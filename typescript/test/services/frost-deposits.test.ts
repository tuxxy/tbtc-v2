import { BigNumber } from "ethers"
import chai, { expect } from "chai"
import chaiAsPromised from "chai-as-promised"
import { createHash } from "crypto"
import { readFileSync } from "fs"
import { join } from "path"
import { Transaction, address } from "bitcoinjs-lib"
import {
  BitcoinNetwork,
  BitcoinTxHash,
  computeFrostDepositConstruction,
  FrostDepositConstruction,
  frostDepositKey,
  FrostDepositsService,
  FrostDepositTerms,
  Hex,
} from "../../src"
import { MockBitcoinClient } from "../utils/mock-bitcoin-client"
import { MockFrostBridge } from "../utils/mock-frost-bridge"

chai.use(chaiAsPromised)

// deposit-construction-v1.json holds C-05
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
  describe("FrostDepositsService", () => {
    const v = constructions[0]
    const t = terms(v.terms)
    const walletKey = Hex.from(v.walletKey)

    it("returns an address only when the SDK and C-05 agree", async () => {
      const bridge = new MockFrostBridge()
      bridge.construct = (x) => computeFrostDepositConstruction(x, walletKey)
      const service = new FrostDepositsService(bridge)
      const prepared = await service.prepareDeposit(
        t,
        walletKey,
        BitcoinNetwork.Testnet
      )
      same(prepared.construction, expected(v))
      const decoded = address.fromBech32(prepared.address)
      expect(decoded.prefix).to.equal("tb")
      expect(decoded.version).to.equal(1)
      expect(Hex.from(decoded.data).toString()).to.equal(
        expected(v).outputKey.toString()
      )
      bridge.construct = (x) => ({
        ...computeFrostDepositConstruction(x, walletKey),
        parity: 1 - v.parity,
      })
      await expect(
        service.prepareDeposit(t, walletKey, BitcoinNetwork.Testnet)
      ).to.be.rejectedWith("constructions differ")
    })

    it("refunds from C-05's historical construction and broadcasts", async () => {
      const bridge = new MockFrostBridge()
      const key = frostDepositKey(funding.reverse(), 1)
      bridge.refundConstructions.set(key.toString(), expected(v))
      const bitcoin = new MockBitcoinClient()
      const service = new FrostDepositsService(bridge, bitcoin)
      const { transaction, transactionHash } = await service.refund(
        t,
        funding,
        1,
        destination,
        BigNumber.from(1000),
        refundSecret
      )
      expect(bitcoin.broadcastLog).to.deep.equal([transaction])
      expect(transactionHash.toString()).to.equal(
        Transaction.fromHex(transaction.transactionHex.toString()).getId()
      )
      await expect(
        service.refund(
          t,
          funding,
          2,
          destination,
          BigNumber.from(1000),
          refundSecret
        )
      ).to.be.rejectedWith("unknown")
    })
  })
})
