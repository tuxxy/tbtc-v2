/* eslint-disable no-bitwise */
import { BigNumber, BigNumberish, Signer, utils } from "ethers"

export type CustodyInput = {
  txHash: string
  txOutputIndex: number
  txOutputValue: BigNumberish
}
export type Payee = { id: string; value: BigNumberish; script: string }
export type TransactionInfo = {
  version: string
  inputVector: string
  outputVector: string
  locktime: string
}
const bytes = (value: string) => Buffer.from(utils.arrayify(value))
const hex = (value: Buffer) => utils.hexlify(value)
const le = (value: BigNumberish, width: number) => {
  let remaining = BigInt(value.toString())
  if (remaining < 0n || remaining >= 1n << BigInt(8 * width))
    throw Error("Bitcoin integer width")
  const result = Buffer.alloc(width)
  for (let i = 0; i < width; i++) {
    result[i] = Number(remaining & 255n)
    remaining >>= 8n
  }
  return result
}
const compact = (count: number) =>
  count < 253 ? le(count, 1) : Buffer.concat([Buffer.from([253]), le(count, 2)])
const be = (value: BigNumberish, width: number) =>
  utils.hexZeroPad(BigNumber.from(value).toHexString(), width)

const reservationType =
  "tuple(bytes32 walletId,bytes32 descriptorHash,uint64 generation,uint64 stateVersion,bytes32 intentCommitment,bytes32 requestIdsHash,bytes32 conflictTxHash,uint32 conflictOutputIndex,uint64 minimumFee,uint64 maximumFee,uint64 maximumSatPerVByte,uint64 validUntilBlock)"

/// Independent Bitcoin wire, snapshot and INTENT-V2 encoding; no fixture hash
/// oracle is used to construct the certificate presented to the Bridge.
export async function reservationProposal(options: {
  bridge: string
  chainId: BigNumberish
  walletId: string
  descriptorHash: string
  genesis: string
  outputKey: string
  generation: BigNumberish
  stateVersion: BigNumberish
  validUntilBlock: BigNumberish
  inputs: CustodyInput[]
  requests: Payee[]
  fee: BigNumberish
  minimumFee?: BigNumberish
  maximumFee?: BigNumberish
  maximumSatPerVByte?: BigNumberish
  operators: Signer[]
}) {
  const { inputs, requests, outputKey } = options
  if (
    inputs.length < 1 ||
    inputs.length > 32 ||
    requests.length < 1 ||
    requests.length > 64
  )
    throw Error("Supported reservation shape")
  if (options.operators.length < 2)
    throw Error("Two certificate operators required")
  const sum = inputs.reduce(
    (total, input) => total + BigInt(input.txOutputValue.toString()),
    0n
  )
  const payout = requests.reduce(
    (total, request) => total + BigInt(request.value.toString()),
    0n
  )
  const change = sum - payout - BigInt(options.fee.toString())
  if (change <= 0n) throw Error("Positive custody change required")
  const outputScript = `0x5120${outputKey.slice(2)}`
  const outputs = [
    ...requests,
    { value: change.toString(), script: outputScript },
  ]
  const transaction: TransactionInfo = {
    version: "0x02000000",
    inputVector: hex(
      Buffer.concat([
        compact(inputs.length),
        ...inputs.flatMap((input) => [
          bytes(input.txHash),
          le(input.txOutputIndex, 4),
          Buffer.from([0]),
          le(0xfffffffd, 4),
        ]),
      ])
    ),
    outputVector: hex(
      Buffer.concat([
        compact(outputs.length),
        ...outputs.flatMap((output) => [
          le(output.value, 8),
          compact(bytes(output.script).length),
          bytes(output.script),
        ]),
      ])
    ),
    locktime: "0x00000000",
  }
  const raw = Buffer.concat([
    bytes(transaction.version),
    bytes(transaction.inputVector),
    bytes(transaction.outputVector),
    bytes(transaction.locktime),
  ])
  const snapshot = utils.sha256(
    Buffer.concat([
      Buffer.from("keep-core/taproot-snapshot/v1"),
      bytes(outputKey),
      raw,
      ...inputs.flatMap((input) => [
        le(input.txOutputValue, 8),
        compact(34),
        bytes(outputScript),
      ]),
    ])
  )
  const certificate = {
    walletId: options.walletId,
    descriptorHash: options.descriptorHash,
    generation: options.generation,
    stateVersion: options.stateVersion,
    intentCommitment: utils.sha256("0x"),
    requestIdsHash: utils.keccak256(
      utils.defaultAbiCoder.encode(["bytes32[]"], [requests.map((r) => r.id)])
    ),
    conflictTxHash: inputs[0].txHash,
    conflictOutputIndex: inputs[0].txOutputIndex,
    minimumFee: options.minimumFee ?? 100,
    maximumFee: options.maximumFee ?? 2000,
    maximumSatPerVByte: options.maximumSatPerVByte ?? 100,
    validUntilBlock: options.validUntilBlock,
  }
  certificate.intentCommitment = utils.sha256(
    utils.concat([
      utils.toUtf8Bytes("keep-core/frost/signing-intent/v2/"),
      "0x02",
      snapshot,
      certificate.walletId,
      certificate.descriptorHash,
      options.genesis,
      "0x01",
      be(certificate.generation, 8),
      be(certificate.stateVersion, 8),
      be(requests.length, 2),
      ...requests.flatMap((request) => [
        request.id,
        be(request.value, 8),
        be(bytes(request.script).length, 2),
        request.script,
      ]),
      certificate.conflictTxHash,
      be(certificate.conflictOutputIndex, 4),
      be(certificate.minimumFee, 8),
      be(certificate.maximumFee, 8),
      be(certificate.maximumSatPerVByte, 8),
    ])
  )
  const digest = utils.keccak256(
    utils.defaultAbiCoder.encode(
      ["bytes32", "uint256", "address", reservationType],
      [
        utils.id("tbtc-v2/frost-redemption-reservation/v2"),
        options.chainId,
        options.bridge,
        certificate,
      ]
    )
  )
  const signatures = await Promise.all(
    options.operators
      .slice(0, 2)
      .map((operator) => operator.signMessage(utils.arrayify(digest)))
  )
  return {
    certificate,
    transaction,
    inputs,
    requests,
    seats: [1, 2],
    signatures: utils.hexConcat(signatures),
    snapshot,
    change,
    digest,
  }
}
