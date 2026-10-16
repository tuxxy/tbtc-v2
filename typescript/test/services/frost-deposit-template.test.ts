import { BigNumber } from "ethers"
import chai, { expect } from "chai"
import chaiAsPromised from "chai-as-promised"
import { createHash } from "crypto"
import { readFileSync } from "fs"
import { join } from "path"
import * as tinysecp from "@bitcoinerlab/secp256k1"
import { Transaction } from "bitcoinjs-lib"
import {
  BitcoinTxHash,
  buildFrostDepositRefund,
  computeFrostDepositConstruction,
  FrostDepositConstruction,
  frostDepositKey,
  frostDepositOutputScript,
  frostDepositReceipt,
  FrostDepositTerms,
  frostBranchHash,
  frostLeafHash,
  frostRefundLeaf,
  frostWalletLeaf,
  FROST_DEPOSIT_INTERNAL_KEY,
  Hex,
} from "../../src"

chai.use(chaiAsPromised)

// deposit-profile-v1.json is tbtc-v2 solidity/test/data/frost, checked by the
// C-05 contract tests. deposit-construction-v1.json holds C-05
// frostDepositConstruction answers for a real DKG wallet key, captured by the
// keep-core K-06 integration test; the Go host checks the same file.
function load(name: string, sha256: string) {
  const raw = readFileSync(join(__dirname, "../data/frost", name))
  expect(createHash("sha256").update(raw).digest("hex"), name).to.equal(sha256)
  return JSON.parse(raw.toString())
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function terms(t: any): FrostDepositTerms {
  return {
    chainId: BigNumber.from(t.chainId),
    bridge: Hex.from(t.bridge),
    bitcoinGenesis: Hex.from(t.bitcoinGenesis),
    fullWalletId: Hex.from(t.fullWalletId),
    descriptorHash: Hex.from(t.descriptorHash),
    depositor: Hex.from(t.depositor),
    vault: Hex.from(t.vault),
    blinding: Hex.from(t.blinding),
    amount: BigNumber.from(t.amount),
    refundKey: Hex.from(t.refundKey),
    refundLocktime: Number(t.refundLocktime),
    extraData: Hex.from(t.extraData),
  }
}

const profile = load(
  "deposit-profile-v1.json",
  "27fd67242955d39843eea02c24939750b70d384204bb6b9620b13b1d93f21a41"
)
const constructions = load(
  "deposit-construction-v1.json",
  "d754bd8f255c4dd121434bf34bec227cf9b1ad783fb26dd42512d552ec9e1de1"
)

// The keep-core fixture's refund key is the secret 9.
const refundSecret = Hex.from("00".repeat(31) + "09")
const destination = Hex.from("0014" + "77".repeat(20))
const funding = BitcoinTxHash.from("42".repeat(32))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function expected(v: any): FrostDepositConstruction {
  return {
    outputKey: Hex.from(v.outputKey),
    root: Hex.from(v.root),
    parity: v.parity,
    receipt: Hex.from(v.receipt),
    walletLeaf: Hex.from(v.walletLeaf),
    refundLeaf: Hex.from(v.refundLeaf),
    walletControl: Hex.from(v.walletControl),
    refundControl: Hex.from(v.refundControl),
  }
}

function same(a: FrostDepositConstruction, b: FrostDepositConstruction) {
  expect(a.parity).to.equal(b.parity)
  for (const k of [
    "outputKey",
    "root",
    "receipt",
    "walletLeaf",
    "refundLeaf",
    "walletControl",
    "refundControl",
  ] as const) {
    expect(a[k].toString(), k).to.equal(b[k].toString())
  }
}

describe("FROST deposits (K-06)", () => {
  describe("D-04 template", () => {
    it("matches the C-05 profile vectors", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const v of profile as any[]) {
        const t = terms(v.terms)
        const receipt = frostDepositReceipt(t)
        expect(receipt.toPrefixedString(), v.name).to.equal(v.expected.receipt)
        const wallet = frostWalletLeaf(receipt, Hex.from(v.outputKey))
        const refund = frostRefundLeaf(receipt, t)
        expect(wallet.toPrefixedString()).to.equal(v.expected.walletLeaf)
        expect(refund.toPrefixedString()).to.equal(v.expected.refundLeaf)
        const walletHash = frostLeafHash(wallet)
        const refundHash = frostLeafHash(refund)
        expect(Hex.from(walletHash).toPrefixedString()).to.equal(
          v.expected.walletLeafHash
        )
        expect(Hex.from(refundHash).toPrefixedString()).to.equal(
          v.expected.refundLeafHash
        )
        expect(
          Hex.from(frostBranchHash(walletHash, refundHash)).toPrefixedString()
        ).to.equal(v.expected.root)
        expect(FROST_DEPOSIT_INTERNAL_KEY.toPrefixedString()).to.equal(
          v.expected.internalKey
        )
      }
    })

    it("matches C-05 constructions for a real wallet key, both parities", () => {
      const parities = new Set<number>()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const v of constructions as any[]) {
        same(
          computeFrostDepositConstruction(
            terms(v.terms),
            Hex.from(v.walletKey)
          ),
          expected(v)
        )
        parities.add(v.parity)
      }
      expect([...parities].sort()).to.deep.equal([0, 1])
    })

    it("refuses what C-05 refuses", () => {
      const base = terms(constructions[0].terms)
      const key = Hex.from(constructions[0].walletKey)
      for (const bad of [
        { refundLocktime: 499999999 },
        { amount: BigNumber.from(0) },
        { amount: BigNumber.from("2100000000000001") },
        { chainId: BigNumber.from(0) },
        { bridge: Hex.from("00".repeat(20)) },
        { depositor: Hex.from("00".repeat(20)) },
        { refundKey: Hex.from("00".repeat(32)) },
        { blinding: Hex.from("00".repeat(7)) },
      ]) {
        expect(
          () => computeFrostDepositConstruction({ ...base, ...bad }, key),
          JSON.stringify(Object.keys(bad))
        ).to.throw()
      }
      expect(() =>
        computeFrostDepositConstruction(base, Hex.from("00".repeat(32)))
      ).to.throw("wallet key")
    })

    it("computes the C-05 deposit key", () => {
      const hash = Hex.from("aa" + "00".repeat(31))
      expect(frostDepositKey(hash, 0x01020304).toPrefixedString()).to.equal(
        Hex.from(
          // keccak256(0xaa00..00 || 01020304)
          require("ethers").utils.keccak256(
            "0xaa" + "00".repeat(31) + "01020304"
          )
        ).toPrefixedString()
      )
    })
  })

  describe("operator-free refund", () => {
    const v = constructions[0]
    const t = terms(v.terms)
    const c = expected(v)

    it("signs the refund leaf with the refund key at the refund locktime", () => {
      const raw = buildFrostDepositRefund(
        t,
        c,
        funding,
        1,
        destination,
        BigNumber.from(1000),
        refundSecret
      )
      const tx = Transaction.fromHex(raw.toString())
      expect(tx.version).to.equal(2)
      expect(tx.locktime).to.equal(t.refundLocktime)
      expect(tx.ins[0].sequence).to.equal(0xfffffffd)
      expect(tx.outs[0].value).to.equal(t.amount.toNumber() - 1000)
      const [signature, leaf, control] = tx.ins[0].witness
      expect(Hex.from(leaf).toString()).to.equal(c.refundLeaf.toString())
      expect(Hex.from(control).toString()).to.equal(c.refundControl.toString())
      const digest = tx.hashForWitnessV1(
        0,
        [frostDepositOutputScript(c).toBuffer()],
        [t.amount.toNumber()],
        Transaction.SIGHASH_DEFAULT,
        frostLeafHash(c.refundLeaf)
      )
      expect(
        tinysecp.verifySchnorr(digest, t.refundKey.toBuffer(), signature)
      ).to.equal(true)
    })

    it("refuses a foreign key, foreign terms, a wrong control block and bad fees", () => {
      const build = (
        terms: FrostDepositTerms,
        construction: FrostDepositConstruction,
        fee: number,
        secret: Hex
      ) =>
        buildFrostDepositRefund(
          terms,
          construction,
          funding,
          1,
          destination,
          BigNumber.from(fee),
          secret
        )
      expect(() =>
        build(t, c, 1000, Hex.from("00".repeat(31) + "08"))
      ).to.throw("refund key")
      expect(() =>
        build(
          { ...t, refundLocktime: t.refundLocktime + 1 },
          c,
          1000,
          refundSecret
        )
      ).to.throw("terms")
      expect(() =>
        build(t, { ...c, refundControl: c.walletControl }, 1000, refundSecret)
      ).to.throw()
      expect(() => build(t, c, 0, refundSecret)).to.throw("fee")
      expect(() => build(t, c, t.amount.toNumber(), refundSecret)).to.throw(
        "fee"
      )
    })
  })
})
