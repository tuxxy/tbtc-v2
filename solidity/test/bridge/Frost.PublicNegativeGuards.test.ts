/* eslint-disable no-bitwise, no-await-in-loop, no-restricted-syntax */
import { artifacts, ethers, network } from "hardhat"
import { expect } from "chai"
import fs from "fs"
import os from "os"
import path from "path"
import assert from "assert"
import { BigNumber, BigNumberish, Signer, utils } from "ethers"
import {
  publicFundedFixture,
  bitcoinProof,
  outpointKey,
} from "../helpers/frost-public-funding"
import { runCoreSettlement } from "../helpers/frost-core-settlement"

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
async function guardProposal(options: {
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
  conflictTxHash?: string
  conflictOutputIndex?: number
  operators: Signer[]
}) {
  const { inputs, requests, outputKey } = options
  if (inputs.length < 1 || inputs.length > 256 || requests.length < 1)
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
    conflictTxHash: options.conflictTxHash ?? inputs[0].txHash,
    conflictOutputIndex: options.conflictOutputIndex ?? inputs[0].txOutputIndex,
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

// A2 public entrypoint checks; public Core-funded origin, no storage seeding.
// Known scalar/controlled registry/readiness/regtest remain component boundaries.
describe("FROST A2 public negative financial guards", () => {
  let f: Awaited<ReturnType<typeof publicFundedFixture>>
  let root: string
  let limit: number
  let outputMappingSlot: BigNumber
  let nonceMappingSlot: BigNumber
  let allRootSlots: number
  let sequence = 0
  const evidence =
    process.env.FROST_C04_NEGATIVE_EVIDENCE ||
    fs.mkdtempSync(path.join(os.tmpdir(), "c04-negative-guards-"))
  const script = `0x0014${"11".repeat(20)}`
  before(async () => {
    const build = await artifacts.getBuildInfo(
      "contracts/bridge/Bridge.sol:Bridge"
    )
    assert(build, "compiled Bridge source binding required")
    const matched = build.input.sources[
      "contracts/frost/FrostSigningIntent.sol"
    ].content.match(/MAX_REQUESTS\s*=\s*(\d+)/)
    assert(matched, "MAX_REQUESTS source constant required")
    limit = Number(matched[1])
    type StorageMember = { label: string; slot: string; type: string }
    type StorageLayout = {
      storage: StorageMember[]
      types: Record<string, { numberOfBytes: string; members: StorageMember[] }>
    }
    const layout = (
      build.output.contracts["contracts/bridge/Bridge.sol"]
        .Bridge as unknown as { storageLayout: StorageLayout }
    ).storageLayout
    const self = layout.storage.find((item) => item.label === "self")
    allRootSlots =
      Number(self.slot) +
      Math.ceil(Number(layout.types[self.type].numberOfBytes) / 32)
    const custody = layout.types[self.type].members.find(
      (item) => item.label === "frostCustody"
    )
    const outputs = layout.types[custody.type].members.find(
      (item) => item.label === "outputs"
    )
    outputMappingSlot = BigNumber.from(self.slot)
      .add(custody.slot)
      .add(outputs.slot)
    const redemption = layout.types[self.type].members.find(
      (item) => item.label === "frostRedemptions"
    )
    assert(redemption)
    const ledger = layout.types[redemption.type].members.find(
      (item) => item.label === "ledger"
    )
    assert(ledger)
    const nonce = layout.types[ledger.type].members.find(
      (item) => item.label === "requestNonce"
    )
    assert(nonce)
    nonceMappingSlot = BigNumber.from(self.slot)
      .add(redemption.slot)
      .add(ledger.slot)
      .add(nonce.slot)
    f = await publicFundedFixture({
      evidenceDirectory: path.join(evidence, "origin"),
      depositAmount: 1200000,
    })
    const movement = Array.from(await f.bridge.movingFundsParameters())
    movement[1] = 500
    await f.bridge.updateMovingFundsParameters(...movement)
    await f.bridge.updateRedemptionParameters(3000, 100, 2000, 4000, 3600, 0, 0)
    await f.frost.configureFrostRedemptions(
      f.genesis,
      2,
      1000,
      ethers.constants.AddressZero,
      utils.id("UNQUALIFIED A2 local D08 reference")
    )
    await f.frost.setFrostRedemptionsEnabled(true)
    fs.writeFileSync(
      path.join(evidence, "guard-source-binding.json"),
      JSON.stringify(
        {
          maximumRequests: limit,
          solcVersion: build.solcVersion,
          sourceHashes: Object.entries(build.input.sources)
            .filter(([name]) => name.startsWith("contracts/"))
            .map(([name, source]) => ({
              path: name,
              sha256: utils.sha256(utils.toUtf8Bytes(source.content)),
            })),
          scope:
            "Known key, controlled readiness, public proof-funded component; not production qualification",
        },
        null,
        2
      )
    )
    root = await network.provider.send("evm_snapshot")
  })
  beforeEach(async () => {
    await network.provider.send("evm_revert", [root])
    root = await network.provider.send("evm_snapshot")
  })

  async function request(gross = 20000, payoutScript = script) {
    await f.bank.connect(f.depositor).approveBalance(f.frost.address, gross)
    const caller = f.frost.connect(f.depositor)
    const id = await caller.callStatic.requestFrostRedemption(
      f.walletId,
      payoutScript,
      gross,
      f.depositor.address
    )
    await caller.requestFrostRedemption(
      f.walletId,
      payoutScript,
      gross,
      f.depositor.address
    )
    return id as string
  }
  async function proposal(requests: Payee[], overrides = {}) {
    const custody = await f.frost.frostWalletCustody(f.walletId)
    return guardProposal({
      bridge: f.frost.address,
      chainId: (await ethers.provider.getNetwork()).chainId,
      walletId: f.walletId,
      descriptorHash: f.descriptorHash,
      genesis: f.genesis,
      outputKey: f.descriptor.outputKey,
      generation: custody.generation.add(1),
      stateVersion: custody.stateVersion,
      validUntilBlock: (await ethers.provider.getBlockNumber()) + 100,
      inputs: [f.custodyUTXO],
      requests,
      fee: 1000,
      operators: f.operators,
      ...overrides,
    })
  }
  function intentId(p: Awaited<ReturnType<typeof guardProposal>>) {
    const c = p.certificate
    return utils.keccak256(
      utils.defaultAbiCoder.encode(
        [
          "bytes32",
          "uint256",
          "address",
          "bytes32",
          "bytes32",
          "uint64",
          "uint64",
          "bytes32",
        ],
        [
          utils.id("tbtc-v2/frost-reservation-id/v1"),
          f.descriptor.chainId,
          f.frost.address,
          c.walletId,
          c.descriptorHash,
          c.generation,
          c.stateVersion,
          c.intentCommitment,
        ]
      )
    )
  }
  async function frame(
    ids: string[],
    intents: string[] = [],
    extraOutputs: string[] = []
  ) {
    const keys = [outpointKey(f.custodyUTXO.txHash, 0), ...extraOutputs]
    const values = await Promise.all([
      f.frost.frostWalletCustody(f.walletId),
      f.frost.frostRedemptionEscrow(f.walletId),
      f.walletView(),
      f.frost.frostRedemptionConfiguration(),
      f.bridge.redemptionParameters(),
      f.bridge.depositParameters(),
      ...ids.map((id) => f.frost.frostRedemptionRequest(id)),
      ...ids.map((id) => f.frost.frostRedemptionPolicy(id)),
      ...[ethers.constants.HashZero, ...intents].map((id) =>
        f.frost.frostReservation(id)
      ),
      ...[f.depositor, f.treasury, f.governance].flatMap((actor) => [
        f.bank.balanceOf(actor.address),
        f.bank.allowance(actor.address, f.frost.address),
        f.bank.nonces(actor.address),
      ]),
      f.bank.balanceOf(f.frost.address),
      f.bank.bridge(),
      ethers.provider.getStorageAt(
        f.frost.address,
        utils.keccak256(
          utils.defaultAbiCoder.encode(
            ["bytes32", "uint256"],
            [f.walletId, nonceMappingSlot]
          )
        )
      ),
      ...keys.map((key) => f.bridge.spentMainUTXOs(key)),
      ...keys.flatMap((key) => {
        const slot = BigNumber.from(
          utils.keccak256(
            utils.defaultAbiCoder.encode(
              ["bytes32", "uint256"],
              [key, outputMappingSlot]
            )
          )
        )
        return [
          ethers.provider.getStorageAt(f.frost.address, slot),
          ethers.provider.getStorageAt(f.frost.address, slot.add(1)),
        ]
      }),
      ...Array.from({ length: allRootSlots }, (_, slot) =>
        ethers.provider.getStorageAt(f.frost.address, slot)
      ),
    ])
    return JSON.stringify(values)
  }
  async function reject(
    p: Awaited<ReturnType<typeof guardProposal>>,
    ids: string[],
    reason: string
  ) {
    const before = await frame(ids, [intentId(p)])
    await expect(
      f.frost.reserveFrostRedemption(p, { gasLimit: 2000000 })
    ).revertedWith(reason)
    expect(await frame(ids, [intentId(p)])).eq(before)
  }
  it("binds every payout script to the captured request even with a fresh valid quorum signature", async () => {
    const id = await request()
    const p = await proposal([
      { id, value: 18800, script: `0x0014${"22".repeat(20)}` },
    ])
    await reject(p, [id], "FROST request binding")
    await f.frost.reserveFrostRedemption(
      await proposal([{ id, value: 18800, script }])
    )
    expect((await f.frost.frostRedemptionRequest(id)).state).eq(2)
  })
  it("enforces the captured per-request fee cap after governance raises the current cap", async () => {
    const id = await request()
    await f.bridge.updateRedemptionParameters(4000, 100, 3000, 4000, 3600, 0, 0)
    const p = await proposal([{ id, value: 17799, script }], {
      fee: 2001,
      maximumFee: 3000,
    })
    expect((await f.frost.frostRedemptionRequest(id)).maximumBitcoinFee).eq(
      2000
    )
    await reject(p, [id], "FROST captured request fee")
  })
  it("requires the signed conflict outpoint to be current main custody", async () => {
    const id = await request()
    await reject(
      await proposal([{ id, value: 18800, script }], {
        conflictOutputIndex: 1,
      }),
      [id],
      "FROST conflict is not main custody"
    )
  })
  it("requires allocated request fees to equal the actual Bitcoin fee", async () => {
    const id = await request()
    await reject(
      await proposal([{ id, value: 18800, script }], { fee: 1001 }),
      [id],
      "FROST fee allocation mismatch"
    )
  })
  it("rejects a quorum-signed certificate beyond the configured expiry upper bound", async () => {
    const id = await request()
    const config = await f.frost.frostRedemptionConfiguration()
    await reject(
      await proposal([{ id, value: 18800, script }], {
        validUntilBlock:
          (await ethers.provider.getBlockNumber()) +
          config.maximumCertificateBlocks.toNumber() +
          2,
      }),
      [id],
      "FROST certificate window"
    )
  })
  it("rejects a quorum-signed foreign descriptor before reserving the captured request", async () => {
    const id = await request()
    await reject(
      await proposal([{ id, value: 18800, script }], {
        descriptorHash: utils.id("foreign descriptor"),
      }),
      [id],
      "FROST reservation certificate"
    )
  })
  it("rejects duplicate IDs below the count cap after the first tentative Reserved transition", async () => {
    expect(limit).greaterThan(1)
    const id = await request(3000)
    await reject(
      await proposal(
        [
          { id, value: 2920, script },
          { id, value: 2920, script },
        ],
        { fee: 100 }
      ),
      [id],
      "FROST request not reservable"
    )
    expect((await f.frost.frostRedemptionRequest(id)).state).eq(1)
    await f.frost.reserveFrostRedemption(
      await proposal([{ id, value: 2870, script }], { fee: 100 })
    )
  })
  it("rejects source-limit+1 distinct real escrowed requests atomically", async () => {
    const ids: string[] = []
    for (let i = 0; i <= limit; i++) ids.push(await request(3000))
    expect(new Set(ids).size).eq(limit + 1)
    const each = Math.floor(1000 / ids.length)
    const requests = ids.map((id, i) => ({
      id,
      script,
      value:
        2970 - (i === ids.length - 1 ? 1000 - each * (ids.length - 1) : each),
    }))
    await reject(await proposal(requests), ids, "FROST payee count")
    for (const id of ids)
      expect((await f.frost.frostRedemptionRequest(id)).state).eq(1)
  })

  async function admit(id: string, overrides = {}) {
    const p = await proposal([{ id, value: 18800, script }], overrides)
    await f.frost.reserveFrostRedemption(p)
    return { p, reservationId: intentId(p) }
  }
  async function cancellation(reservationId: string, fee: number) {
    const tx = {
      version: "0x02000000",
      inputVector: `0x01${f.custodyUTXO.txHash.slice(2)}0000000000fdffffff`,
      outputVector: utils.hexlify(
        Buffer.concat([
          Buffer.from([1]),
          le(f.custodyUTXO.txOutputValue - fee, 8),
          Buffer.from("225120", "hex"),
          bytes(f.descriptor.outputKey),
        ])
      ),
      locktime: "0x00000000",
    }
    const raw = utils.hexConcat([
      tx.version,
      tx.inputVector,
      tx.outputVector,
      tx.locktime,
    ])
    const snapshot = utils.sha256(
      utils.concat([
        utils.toUtf8Bytes("keep-core/taproot-snapshot/v1"),
        f.descriptor.outputKey,
        raw,
        le(f.custodyUTXO.txOutputValue, 8),
        "0x22",
        `0x5120${f.descriptor.outputKey.slice(2)}`,
      ])
    )
    const authorization = {
      reservationId,
      snapshot,
      transactionHash: utils.sha256(utils.sha256(raw)),
      fee,
      validUntilBlock: (await ethers.provider.getBlockNumber()) + 100,
    }
    const digest = utils.keccak256(
      utils.defaultAbiCoder.encode(
        [
          "bytes32",
          "uint256",
          "address",
          "tuple(bytes32 reservationId,bytes32 snapshot,bytes32 transactionHash,uint64 fee,uint64 validUntilBlock)",
        ],
        [
          utils.id("tbtc-v2/frost-reservation-cancellation/v1"),
          f.descriptor.chainId,
          f.frost.address,
          authorization,
        ]
      )
    )
    const signatures = utils.hexConcat(
      await Promise.all(
        f.operators
          .slice(0, 2)
          .map((operator) => operator.signMessage(utils.arrayify(digest)))
      )
    )
    return { tx, authorization, signatures }
  }
  const cancellationCases = [
    ["minimum", 99, 100, "FROST transaction fee"],
    ["maximum", 2001, 100, "FROST transaction fee"],
    ["rate", 2000, 8, "FROST transaction fee rate"],
  ] as const
  cancellationCases.forEach(([label, fee, rate, reason]) => {
    it(`validates cancellation ${label} fee against the captured reservation policy`, async () => {
      const id = await request()
      const a = await admit(id, { maximumSatPerVByte: rate })
      const c = await cancellation(a.reservationId, fee)
      await f.bank.connect(f.treasury).approveBalance(f.frost.address, fee)
      const before = await frame([id], [a.reservationId])
      await expect(
        f.frost
          .connect(f.treasury)
          .authorizeFrostCancellation(
            c.authorization,
            c.tx,
            [1, 2],
            c.signatures
          )
      ).revertedWith(reason)
      expect(await frame([id], [a.reservationId])).eq(before)
    })
  })

  it("rejects actual proven payment bytes whose locktime changes the admitted txid and snapshot", async () => {
    const id = await request()
    const a = await admit(id)
    const changed = { ...a.p.transaction, locktime: "0x01000000" }
    sequence += 1
    const mined = await runCoreSettlement({
      coreWitness: f.coreWitness,
      input: f.custodyUTXO,
      transaction: changed,
      outputDirectory: path.join(evidence, `payment-${sequence}`),
    })
    const raw = utils.hexConcat([
      changed.version,
      changed.inputVector,
      changed.outputVector,
      changed.locktime,
    ])
    const changedKey = outpointKey(utils.sha256(utils.sha256(raw)), 1)
    const before = await frame([id], [a.reservationId], [changedKey])
    await expect(
      f.frost.submitFrostRedemptionProof(
        a.reservationId,
        changed,
        bitcoinProof(mined.proof)
      )
    ).revertedWith("FROST payment changed intent")
    expect(await frame([id], [a.reservationId], [changedKey])).eq(before)
  })

  it("rejects a replacement change that would strand other net liabilities before custody replacement", async () => {
    // The final remaining-liability guard is an invariant backstop: public
    // admission enforces fee allocation and capacity, and payment binds exact
    // bytes. With V >= L and allocated fee N-P, payment gives V'=V-N
    // and L'=L-N, so the final backstop cannot fail from a valid public state.
    // This reachable adversarial replacement is rejected at exact-byte binding.
    const id = await request()
    const a = await admit(id)
    const remaining = await request(1000000)
    const custody = await f.frost.frostWalletCustody(f.walletId)
    expect((await f.frost.frostRedemptionEscrow(f.walletId)).netLiability).eq(
      1009800
    )
    const changed = await proposal([{ id, value: 18800, script }], {
      fee: 1000000,
    })
    expect(changed.change < 990000n).eq(true)
    const raw = utils.hexConcat([
      changed.transaction.version,
      changed.transaction.inputVector,
      changed.transaction.outputVector,
      changed.transaction.locktime,
    ])
    const output = outpointKey(utils.sha256(utils.sha256(raw)), 1)
    sequence += 1
    const mined = await runCoreSettlement({
      coreWitness: f.coreWitness,
      input: f.custodyUTXO,
      transaction: changed.transaction,
      outputDirectory: path.join(evidence, `stranding-payment-${sequence}`),
    })
    const before = await frame([id, remaining], [a.reservationId], [output])
    await expect(
      f.frost.submitFrostRedemptionProof(
        a.reservationId,
        changed.transaction,
        bitcoinProof(mined.proof)
      )
    ).revertedWith("FROST payment changed intent")
    expect(await frame([id, remaining], [a.reservationId], [output])).eq(before)
    expect((await f.frost.frostWalletCustody(f.walletId)).value).eq(
      custody.value
    )
  })
})
