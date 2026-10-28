/* eslint-disable no-await-in-loop, no-restricted-syntax */
import { ethers } from "hardhat"
import { expect } from "chai"
import vectors from "../data/frost/deposit-profile-v1.json"
import {
  baseTerms,
  branchHash,
  compact,
  DOMAIN,
  encodeProfile,
  fromHex,
  leafHash,
  NUMS,
  receiptPreimage,
  scriptNum,
  sha,
  Terms,
  toHex,
  WALLET_Q,
} from "../data/frost/deposit-profile"

describe("Proposed D-04 exact NUMS two-leaf deposit profile", () => {
  async function fixture() {
    return (
      await ethers.getContractFactory("FrostDepositProfileFixture")
    ).deploy()
  }
  it("uses official BIP341 H and independently reproduces the generator hash", async () => {
    const p = await fixture()
    const g = fromHex(
      "0x04" +
        "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" +
        "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8"
    )
    expect(toHex(sha(g))).eq(NUMS)
    expect(await p.internalKey()).eq(NUMS)
  })
  it("matches all independent fixed receipts, scripts, hashes and control vectors", async () => {
    const p = await fixture()
    for (const v of vectors) {
      expect(encodeProfile(v.terms, v.outputKey)).deep.eq(v.expected)
      expect(await p.receipt(v.terms)).eq(v.expected.receipt)
      expect(await p.walletLeaf(v.terms, v.outputKey)).eq(v.expected.walletLeaf)
      expect(await p.refundLeaf(v.terms)).eq(v.expected.refundLeaf)
      expect(await p.leafHash(v.expected.walletLeaf)).eq(
        v.expected.walletLeafHash
      )
      expect(await p.leafHash(v.expected.refundLeaf)).eq(
        v.expected.refundLeafHash
      )
      expect(await p.root(v.terms, v.outputKey)).eq(v.expected.root)
      for (const parity of [0, 1]) {
        expect(await p.controlBlock(v.expected.refundLeafHash, parity)).eq(
          parity === 0
            ? v.expected.walletControlEven
            : v.expected.walletControlOdd
        )
        expect(await p.controlBlock(v.expected.walletLeafHash, parity)).eq(
          parity === 0
            ? v.expected.refundControlEven
            : v.expected.refundControlOdd
        )
      }
    }
  })
  it("uses exact flat ABI, bytes8 right padding and full-width integer words", async () => {
    const p = await fixture()
    for (const v of vectors) {
      const t = v.terms
      const encoded = ethers.utils.defaultAbiCoder.encode(
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
          DOMAIN,
          t.chainId,
          t.bridge,
          t.bitcoinGenesis,
          t.fullWalletId,
          t.descriptorHash,
          t.depositor,
          t.vault,
          t.blinding,
          t.amount,
          t.refundKey,
          t.refundLocktime,
          t.extraData,
        ]
      )
      expect(toHex(receiptPreimage(t))).eq(encoded)
      expect(fromHex(encoded).length).eq(416)
      expect(await p.receipt(t)).eq(ethers.utils.sha256(encoded))
    }
  })
  it("binds every term to both leaves and preserves separate wallet-key selection", async () => {
    const p = await fixture()
    const old = encodeProfile(baseTerms, WALLET_Q)
    const changes: Partial<Terms>[] = [
      { chainId: "2" },
      { bridge: `0x${"12".repeat(20)}` },
      { bitcoinGenesis: ethers.utils.id("network") },
      { fullWalletId: ethers.utils.id("wallet") },
      { descriptorHash: ethers.utils.id("descriptor") },
      { depositor: `0x${"23".repeat(20)}` },
      { vault: ethers.constants.AddressZero },
      { blinding: "0x0102030405060709" },
      { amount: "100001" },
      { refundKey: `0x${"11".repeat(32)}` },
      { refundLocktime: 500000001 },
      { extraData: ethers.utils.id("extra") },
    ]
    for (const update of changes) {
      const t = { ...baseTerms, ...update }
      const value = encodeProfile(t, WALLET_Q)
      expect(value.receipt).not.eq(old.receipt)
      expect(value.walletLeaf).not.eq(old.walletLeaf)
      expect(value.refundLeaf).not.eq(old.refundLeaf)
      expect(await p.receipt(t)).eq(value.receipt)
      expect(await p.root(t, WALLET_Q)).eq(value.root)
      expect(value.root).not.eq(old.root)
    }
    expect(await p.receipt(baseTerms)).eq(old.receipt)
    expect(await p.walletLeaf(baseTerms, baseTerms.refundKey)).not.eq(
      old.walletLeaf
    )
    expect(await p.refundLeaf(baseTerms)).eq(old.refundLeaf)
    expect(await p.root(baseTerms, baseTerms.refundKey)).not.eq(old.root)
  })
  it("uses minimal positive ScriptNum at Unix/sign-bit boundaries", async () => {
    const p = await fixture()
    const numbers: [number, string][] = [
      [500000000, "040065cd1d"],
      [500000001, "040165cd1d"],
      [2147483647, "04ffffff7f"],
      [2147483648, "050000008000"],
      [4294967295, "05ffffffff00"],
    ]
    for (const [n, push] of numbers) {
      expect(toHex(scriptNum(n))).eq(`0x${push}`)
      const t = { ...baseTerms, refundLocktime: n }
      const r = await p.receipt(t)
      const expected = `0x20${r.slice(2)}75${push}b17520${t.refundKey.slice(
        2
      )}ac`
      expect(await p.refundLeaf(t)).eq(expected)
      expect(fromHex(expected).length).eq(n < 2147483648 ? 75 : 76)
    }
    const w = await p.walletLeaf(baseTerms, WALLET_Q)
    expect(fromHex(w).length).eq(68)
    expect(w).eq(
      `0x20${encodeProfile(baseTerms, WALLET_Q).receipt.slice(
        2
      )}7520${WALLET_Q.slice(2)}ac`
    )
  })
  it("rejects invalid amount/domain/time without narrowing full-width amounts", async () => {
    const p = await fixture()
    for (const amount of [
      "0",
      "2100000000000001",
      "9007199254740993",
      "18446744073709551615",
    ]) {
      const t = { ...baseTerms, amount }
      await expect(p.receipt(t)).revertedWith("FROST deposit amount")
      await expect(p.walletLeaf(t, WALLET_Q)).revertedWith(
        "FROST deposit amount"
      )
      await expect(p.refundLeaf(t)).revertedWith("FROST deposit amount")
      await expect(p.root(t, WALLET_Q)).revertedWith("FROST deposit amount")
    }
    for (const refundLocktime of [0, 16, 499999999]) {
      const t = { ...baseTerms, refundLocktime }
      await expect(p.receipt(t)).revertedWith("FROST refund timestamp")
      await expect(p.refundLeaf(t)).revertedWith("FROST refund timestamp")
    }
    for (const update of [
      { chainId: "0" },
      { bridge: ethers.constants.AddressZero },
      { bitcoinGenesis: ethers.constants.HashZero },
      { fullWalletId: ethers.constants.HashZero },
      { descriptorHash: ethers.constants.HashZero },
      { depositor: ethers.constants.AddressZero },
    ])
      await expect(p.receipt({ ...baseTerms, ...update })).revertedWith(
        "FROST deposit domain"
      )
    for (const amount of ["1", "2100000000000000"])
      expect(await p.receipt({ ...baseTerms, amount })).eq(
        encodeProfile({ ...baseTerms, amount }, WALLET_Q).receipt
      )
  })
  it("hashes fixed c0 leaf version and canonical CompactSize length transitions", async () => {
    const p = await fixture()
    for (const n of [0, 68, 75, 76, 252, 253, 255, 256, 65535, 65536]) {
      const s = Buffer.alloc(n, 0x51)
      expect(await p.leafHash(toHex(s))).eq(toHex(leafHash(s)))
    }
    expect(toHex(compact(252))).eq("0xfc")
    expect(toHex(compact(253))).eq("0xfdfd00")
    expect(toHex(compact(65535))).eq("0xfdffff")
    expect(toHex(compact(65536))).eq("0xfe00000100")
    expect(toHex(compact(4294967296))).eq("0xff0000000001000000")
  })
  it("rejects ABI-width overflow and malformed fixed bytes in the independent encoder", () => {
    const cases = [
      { amount: "18446744073709551616" },
      { amount: "-1" },
      { chainId: (BigInt(2) ** BigInt(256)).toString() },
      { refundLocktime: 4294967296 },
    ]
    for (const update of cases)
      expect(() => receiptPreimage({ ...baseTerms, ...update })).to.throw(
        "width"
      )
    expect(() =>
      receiptPreimage({ ...baseTerms, blinding: "0x0102" })
    ).to.throw("fixed width")
    expect(() => scriptNum(500000000.5)).to.throw("timestamp")
  })

  it("sorts two leaf hashes lexically without byte reversal", async () => {
    const p = await fixture()
    const a = `0x01${"ff".repeat(31)}`
    const b = `0x02${"00".repeat(31)}`
    const expected = toHex(branchHash(fromHex(a), fromHex(b)))
    expect(await p.branchHash(a, b)).eq(expected)
    expect(await p.branchHash(b, a)).eq(expected)
    const v = encodeProfile(baseTerms, WALLET_Q)
    expect(await p.branchHash(v.walletLeafHash, v.refundLeafHash)).eq(v.root)
    expect(await p.branchHash(v.refundLeafHash, v.walletLeafHash)).eq(v.root)
  })
  it("fixes 65-byte control blocks to NUMS, c0/c1 and one sibling", async () => {
    const p = await fixture()
    const v = encodeProfile(baseTerms, WALLET_Q)
    for (const parity of [0, 1]) {
      const c = fromHex(await p.controlBlock(v.refundLeafHash, parity))
      expect(c.length).eq(65)
      expect(c[0]).eq(0xc0 + parity)
      expect(toHex(c.subarray(1, 33))).eq(NUMS)
      expect(toHex(c.subarray(33))).eq(v.refundLeafHash)
    }
    for (const parity of [2, 3, 192, 255])
      await expect(p.controlBlock(v.refundLeafHash, parity)).revertedWith(
        "FROST control parity"
      )
  })
  it("keeps optional metadata and curve verification as admission/C07 duties", async () => {
    const p = await fixture()
    const t = {
      ...baseTerms,
      vault: ethers.constants.AddressZero,
      blinding: "0x0000000000000000",
      extraData: ethers.constants.HashZero,
    }
    expect(await p.receipt(t)).eq(encodeProfile(t, WALLET_Q).receipt)
    // The encoder can construct invalid-key bytes. They must never pass admission.
    const bad = { ...baseTerms, refundKey: ethers.constants.HashZero }
    const q = `0x${"ff".repeat(32)}`
    expect(await p.root(bad, q)).eq(encodeProfile(bad, q).root)
  })
})
