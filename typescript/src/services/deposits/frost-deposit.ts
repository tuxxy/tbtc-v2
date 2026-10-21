import { BigNumber, utils } from "ethers"
import * as tinysecp from "@bitcoinerlab/secp256k1"
import { crypto as btccrypto } from "bitcoinjs-lib"
import {
  FrostDepositConstruction,
  FrostDepositTerms,
} from "../../lib/contracts"
import { Hex } from "../../lib/utils"

/**
 * BIP341 NUMS point H = lift_x(SHA256(uncompressed G)), used without blinding.
 */
export const FROST_DEPOSIT_INTERNAL_KEY = Hex.from(
  "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0"
)

const LEAF_VERSION = 0xc0
const MAX_SATOSHI = BigNumber.from("2100000000000000")
const RECEIPT_DOMAIN = utils.keccak256(
  utils.toUtf8Bytes("tbtc-v2/frost-deposit-receipt/v1")
)

function fixed(name: string, value: Hex, length: number): Buffer {
  const b = value.toBuffer()
  if (b.length !== length) {
    throw new Error(`${name} must be ${length} bytes`)
  }
  return b
}

/**
 * The C-05 receipt: sha256(abi.encode(DOMAIN, terms...)).
 * @param terms - Deposit terms.
 * @returns 32-byte receipt.
 */
export function frostDepositReceipt(terms: FrostDepositTerms): Hex {
  const zero = (b: Buffer) => b.every((x) => x === 0)
  const bridge = fixed("bridge", terms.bridge, 20)
  const depositor = fixed("depositor", terms.depositor, 20)
  const genesis = fixed("bitcoinGenesis", terms.bitcoinGenesis, 32)
  const wallet = fixed("fullWalletId", terms.fullWalletId, 32)
  const descriptor = fixed("descriptorHash", terms.descriptorHash, 32)
  if (
    terms.chainId.lte(0) ||
    zero(bridge) ||
    zero(genesis) ||
    zero(wallet) ||
    zero(descriptor) ||
    zero(depositor)
  ) {
    throw new Error("FROST deposit domain")
  }
  if (terms.amount.lte(0) || terms.amount.gt(MAX_SATOSHI)) {
    throw new Error("FROST deposit amount")
  }
  if (
    !Number.isInteger(terms.refundLocktime) ||
    terms.refundLocktime < 500000000 ||
    terms.refundLocktime > 0xffffffff
  ) {
    throw new Error("FROST refund timestamp")
  }
  const encoded = utils.defaultAbiCoder.encode(
    [
      "bytes32",
      "uint256",
      "address",
      "bytes32",
      "bytes32",
      "bytes32",
      "address",
      "address",
      "bytes8",
      "uint64",
      "bytes32",
      "uint32",
      "bytes32",
    ],
    [
      RECEIPT_DOMAIN,
      terms.chainId,
      utils.hexlify(bridge),
      utils.hexlify(genesis),
      utils.hexlify(wallet),
      utils.hexlify(descriptor),
      utils.hexlify(depositor),
      utils.hexlify(fixed("vault", terms.vault, 20)),
      utils.hexlify(fixed("blinding", terms.blinding, 8)),
      terms.amount,
      utils.hexlify(fixed("refundKey", terms.refundKey, 32)),
      terms.refundLocktime,
      utils.hexlify(fixed("extraData", terms.extraData, 32)),
    ]
  )
  return Hex.from(utils.sha256(encoded))
}

/**
 * Minimal positive CScriptNum push of a timestamp.
 * @param value - Timestamp at or above 500,000,000.
 * @returns The push opcode and little-endian bytes.
 */
function scriptNumber(value: number): Buffer {
  const n: number[] = []
  let v = value
  while (v > 0) {
    n.push(v & 0xff)
    v = Math.floor(v / 256)
  }
  if (n[n.length - 1] & 0x80) n.push(0)
  return Buffer.from([n.length, ...n])
}

/**
 * The wallet leaf the FROST sweep signs under Q.
 * @param receipt - 32-byte deposit receipt.
 * @param walletKey - 32-byte x-only wallet key Q.
 * @returns PUSH32(receipt) DROP PUSH32(Q) CHECKSIG.
 */
export function frostWalletLeaf(receipt: Hex, walletKey: Hex): Hex {
  return Hex.from(
    Buffer.concat([
      Buffer.from([0x20]),
      fixed("receipt", receipt, 32),
      Buffer.from([0x75, 0x20]),
      fixed("walletKey", walletKey, 32),
      Buffer.from([0xac]),
    ])
  )
}

/**
 * The depositor refund leaf.
 * @param receipt - 32-byte deposit receipt.
 * @param terms - Deposit terms (refund key and locktime).
 * @returns PUSH32(receipt) DROP <locktime> CLTV DROP PUSH32(refundKey) CHECKSIG.
 */
export function frostRefundLeaf(receipt: Hex, terms: FrostDepositTerms): Hex {
  return Hex.from(
    Buffer.concat([
      Buffer.from([0x20]),
      fixed("receipt", receipt, 32),
      Buffer.from([0x75]),
      scriptNumber(terms.refundLocktime),
      Buffer.from([0xb1, 0x75, 0x20]),
      fixed("refundKey", terms.refundKey, 32),
      Buffer.from([0xac]),
    ])
  )
}

/**
 * BIP341 tapleaf hash with leaf version 0xc0.
 * @param script - Leaf script.
 * @returns The 32-byte leaf hash.
 */
export function frostLeafHash(script: Hex): Buffer {
  const s = script.toBuffer()
  if (s.length >= 253) {
    throw new Error("unexpected tapleaf size")
  }
  return btccrypto.taggedHash(
    "TapLeaf",
    Buffer.concat([Buffer.from([LEAF_VERSION, s.length]), s])
  )
}

/**
 * BIP341 tapbranch hash of two sorted child hashes.
 * @param a - First child hash.
 * @param b - Second child hash.
 * @returns The 32-byte branch hash.
 */
export function frostBranchHash(a: Buffer, b: Buffer): Buffer {
  const [first, second] = Buffer.compare(a, b) > 0 ? [b, a] : [a, b]
  return btccrypto.taggedHash("TapBranch", Buffer.concat([first, second]))
}

function controlBlock(sibling: Buffer, parity: number): Hex {
  return Hex.from(
    Buffer.concat([
      Buffer.from([LEAF_VERSION | parity]),
      FROST_DEPOSIT_INTERNAL_KEY.toBuffer(),
      sibling,
    ])
  )
}

/**
 * The BIP341 output key of the NUMS internal key committed to root.
 * @param root - 32-byte script tree root.
 * @returns The x-only output key and its parity.
 */
export function frostTapTweak(root: Buffer): { key: Buffer; parity: number } {
  const internal = FROST_DEPOSIT_INTERNAL_KEY.toBuffer()
  const tweak = btccrypto.taggedHash(
    "TapTweak",
    Buffer.concat([internal, root])
  )
  const result = tinysecp.xOnlyPointAddTweak(internal, tweak)
  if (!result) {
    throw new Error("FROST deposit tweak")
  }
  return { key: Buffer.from(result.xOnlyPubkey), parity: result.parity }
}

/**
 * Builds the deposit for wallet key Q, independently of the contract.
 * @param terms - Deposit terms.
 * @param walletKey - 32-byte x-only FROST wallet output key Q.
 * @returns The construction C-05 must return for the same terms.
 */
export function computeFrostDepositConstruction(
  terms: FrostDepositTerms,
  walletKey: Hex
): FrostDepositConstruction {
  const receipt = frostDepositReceipt(terms)
  if (!tinysecp.isXOnlyPoint(fixed("walletKey", walletKey, 32))) {
    throw new Error("wallet key is not a curve point")
  }
  if (!tinysecp.isXOnlyPoint(terms.refundKey.toBuffer())) {
    throw new Error("refund key is not a curve point")
  }
  const walletLeaf = frostWalletLeaf(receipt, walletKey)
  const refundLeaf = frostRefundLeaf(receipt, terms)
  const walletHash = frostLeafHash(walletLeaf)
  const refundHash = frostLeafHash(refundLeaf)
  const root = frostBranchHash(walletHash, refundHash)
  const output = frostTapTweak(root)
  return {
    outputKey: Hex.from(output.key),
    root: Hex.from(root),
    parity: output.parity,
    receipt,
    walletLeaf,
    refundLeaf,
    walletControl: controlBlock(refundHash, output.parity),
    refundControl: controlBlock(walletHash, output.parity),
  }
}

/**
 * The funding output script of a deposit.
 * @param c - Deposit construction.
 * @returns OP_1 PUSH32(outputKey).
 */
export function frostDepositOutputScript(c: FrostDepositConstruction): Hex {
  return Hex.from(
    Buffer.concat([Buffer.from([0x51, 0x20]), c.outputKey.toBuffer()])
  )
}

/**
 * The C-05 deposit key: keccak256(rawTxHash || uint32 BE index).
 * @param fundingTxHash - Funding transaction hash in internal byte order.
 * @param outputIndex - Funding output index.
 * @returns The 32-byte deposit key.
 */
export function frostDepositKey(fundingTxHash: Hex, outputIndex: number): Hex {
  const index = Buffer.alloc(4)
  index.writeUInt32BE(outputIndex)
  return Hex.from(
    utils.keccak256(
      Buffer.concat([fixed("fundingTxHash", fundingTxHash, 32), index])
    )
  )
}

/**
 * Compares two constructions byte for byte.
 * @param a - First construction.
 * @param b - Second construction.
 * @returns True when every field is equal.
 */
export function sameFrostDepositConstruction(
  a: FrostDepositConstruction,
  b: FrostDepositConstruction
): boolean {
  return (
    a.parity === b.parity &&
    (
      [
        "outputKey",
        "root",
        "receipt",
        "walletLeaf",
        "refundLeaf",
        "walletControl",
        "refundControl",
      ] as const
    ).every((k) => a[k].equals(b[k]))
  )
}
