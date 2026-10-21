/* eslint-disable no-bitwise */
// Independent byte encoder: no contract calls, manual fixed-width ABI words,
// Node SHA-256, Bitcoin CompactSize and signed-magnitude ScriptNum.
import { createHash } from "crypto"
import { writeFileSync } from "fs"
import { join } from "path"
import { utils } from "ethers"

export type Terms = {
  chainId: string
  bridge: string
  bitcoinGenesis: string
  fullWalletId: string
  descriptorHash: string
  depositor: string
  vault: string
  blinding: string
  amount: string
  refundKey: string
  refundLocktime: number
  extraData: string
}
export const NUMS =
  "0x50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0"
export const DOMAIN = utils.id("tbtc-v2/frost-deposit-receipt/v1")
export const fromHex = (s: string): Buffer => {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(s)) throw Error("hex")
  return Buffer.from(s.slice(2), "hex")
}
export const toHex = (b: Buffer): string => `0x${b.toString("hex")}`
export const sha = (b: Buffer): Buffer =>
  createHash("sha256").update(b).digest()
export const tagged = (name: string, data: Buffer): Buffer => {
  const h = sha(Buffer.from(name))
  return sha(Buffer.concat([h, h, data]))
}
export const unsigned = (
  value: string | number,
  width: number,
  little = false
): Buffer => {
  let n = BigInt(value)
  if (n < BigInt(0) || n >= BigInt(2) ** BigInt(width * 8)) throw Error("width")
  const b = Buffer.alloc(width)
  for (let i = 0; i < width; i += 1) {
    b[little ? i : width - i - 1] = Number(n % BigInt(256))
    n /= BigInt(256)
  }
  return b
}
const fixed = (s: string, width: number) => {
  const b = fromHex(s)
  if (b.length !== width) throw Error("fixed width")
  return b
}
const addressWord = (s: string) =>
  Buffer.concat([Buffer.alloc(12), fixed(s, 20)])
export const receiptPreimage = (t: Terms): Buffer =>
  Buffer.concat([
    fixed(DOMAIN, 32),
    unsigned(t.chainId, 32),
    addressWord(t.bridge),
    fixed(t.bitcoinGenesis, 32),
    fixed(t.fullWalletId, 32),
    fixed(t.descriptorHash, 32),
    addressWord(t.depositor),
    addressWord(t.vault),
    Buffer.concat([fixed(t.blinding, 8), Buffer.alloc(24)]),
    Buffer.concat([Buffer.alloc(24), unsigned(t.amount, 8)]),
    fixed(t.refundKey, 32),
    Buffer.concat([Buffer.alloc(28), unsigned(t.refundLocktime, 4)]),
    fixed(t.extraData, 32),
  ])
export const scriptNum = (timestamp: number): Buffer => {
  if (
    !Number.isInteger(timestamp) ||
    timestamp < 500000000 ||
    timestamp > 4294967295
  )
    throw Error("timestamp")
  let n = BigInt(timestamp)
  const data: number[] = []
  while (n > BigInt(0)) {
    data.push(Number(n % BigInt(256)))
    n /= BigInt(256)
  }
  if (data[data.length - 1] >= 128) data.push(0)
  return Buffer.from([data.length, ...data])
}
export const compact = (n: number): Buffer => {
  if (!Number.isSafeInteger(n) || n < 0) throw Error("size")
  if (n < 253) return unsigned(n, 1)
  if (n <= 65535)
    return Buffer.concat([Buffer.from([253]), unsigned(n, 2, true)])
  if (n <= 4294967295)
    return Buffer.concat([Buffer.from([254]), unsigned(n, 4, true)])
  return Buffer.concat([Buffer.from([255]), unsigned(n, 8, true)])
}
export const leafHash = (script: Buffer): Buffer =>
  tagged(
    "TapLeaf",
    Buffer.concat([Buffer.from([192]), compact(script.length), script])
  )
export const branchHash = (a: Buffer, b: Buffer): Buffer =>
  tagged(
    "TapBranch",
    Buffer.concat(Buffer.compare(a, b) <= 0 ? [a, b] : [b, a])
  )
export const encodeProfile = (
  t: Terms,
  outputKey: string
): Record<string, string> => {
  const r = sha(receiptPreimage(t))
  const wallet = Buffer.concat([
    Buffer.from([32]),
    r,
    Buffer.from([117, 32]),
    fixed(outputKey, 32),
    Buffer.from([172]),
  ])
  const refund = Buffer.concat([
    Buffer.from([32]),
    r,
    Buffer.from([117]),
    scriptNum(t.refundLocktime),
    Buffer.from([177, 117, 32]),
    fixed(t.refundKey, 32),
    Buffer.from([172]),
  ])
  const wh = leafHash(wallet)
  const rh = leafHash(refund)
  const control = (sibling: Buffer, parity: number) =>
    toHex(Buffer.concat([Buffer.from([192 + parity]), fromHex(NUMS), sibling]))
  return {
    receiptPreimage: toHex(receiptPreimage(t)),
    receipt: toHex(r),
    walletLeaf: toHex(wallet),
    refundLeaf: toHex(refund),
    walletLeafHash: toHex(wh),
    refundLeafHash: toHex(rh),
    root: toHex(branchHash(wh, rh)),
    internalKey: NUMS,
    walletControlEven: control(rh, 0),
    walletControlOdd: control(rh, 1),
    refundControlEven: control(wh, 0),
    refundControlOdd: control(wh, 1),
  }
}
export const baseTerms: Terms = {
  chainId: "1",
  bridge: "0x1111111111111111111111111111111111111111",
  bitcoinGenesis:
    "0x06226e46111a0b59caaf126043eb5bbf28c34f3a5e332a1fc7b2b73cf188910f",
  fullWalletId:
    "0x07bad9bdb6a2f48e6a16f8509dbb21cc548c227188c0cdd32699735e67e21e91",
  descriptorHash:
    "0xf6815691830f1b6dbea2aa8a911fd335f6deb153bb89c8f1de544ab6566898ab",
  depositor: "0x2222222222222222222222222222222222222222",
  vault: "0x3333333333333333333333333333333333333333",
  blinding: "0x0102030405060708",
  amount: "100000",
  refundKey:
    "0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  refundLocktime: 500000000,
  extraData: `0x${"44".repeat(32)}`,
}
export const WALLET_Q =
  "0xdefdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34"
if (require.main === module && process.argv.includes("--write-vectors")) {
  const cases = [
    { name: "timestamp floor", terms: baseTerms },
    {
      name: "signed uint32 edge",
      terms: { ...baseTerms, refundLocktime: 2147483647 },
    },
    {
      name: "five-byte positive timestamp",
      terms: { ...baseTerms, refundLocktime: 2147483648 },
    },
    {
      name: "full-width domain and monetary/time caps",
      terms: {
        ...baseTerms,
        chainId: (BigInt(2) ** BigInt(256) - BigInt(1)).toString(),
        amount: "2100000000000000",
        refundLocktime: 4294967295,
        blinding: "0xffffffffffffffff",
        vault: `0x${"00".repeat(20)}`,
        extraData: `0x${"ff".repeat(32)}`,
      },
    },
  ].map((v) => ({
    ...v,
    outputKey: WALLET_Q,
    expected: encodeProfile(v.terms, WALLET_Q),
  }))
  writeFileSync(
    join(__dirname, "deposit-profile-v1.json"),
    `${JSON.stringify(cases, null, 2)}\n`
  )
}
