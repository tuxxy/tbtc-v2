/* eslint-disable no-await-in-loop */
// C-10 budgets, containment and DKG cutover through the real Bridge proxy.
// Synthetic regtest inclusion proofs: the relay admits fabricated funding and
// sweep transactions, which the fault demonstration uses as the assumed
// faulty deposit validator. D-10 values are test values (OPEN).
import { ethers, network } from "hardhat"
import { expect } from "chai"
import * as secp from "@noble/secp256k1"
import {
  MAX_UINT64,
  movementWorld,
  transaction,
  inclusion,
  p2tr,
  p2wpkh,
  outpoint,
  raw,
  deploy,
  ascending,
  split,
  World,
  Wallet,
  Tx,
} from "../helpers/frost-movement-world"

const RECORD = ethers.utils.id("C-10 test review record")
const TOP_UP = ethers.utils.id("C-10 test top-up record")
const Mode = { LegacyOpen: 0, LegacyDraining: 1, FrostOnly: 2 }
const LegacyState = { Live: 1, MovingFunds: 2, Closing: 3, Terminated: 5 }
const BOND = ethers.utils.parseEther("5")
const SWEEP_FEE = 1000

/// Every exposure counter, for whole-frame comparisons.
const counters = async (c: any) => ({
  custodyReserved: (await c.custodyReserved()).toString(),
  custodyReleased: (await c.custodyReleased()).toString(),
  custodyAdmitted: (await c.custodyAdmitted()).toString(),
  issuanceReserved: (await c.issuanceReserved()).toString(),
  issued: (await c.issued()).toString(),
})

/// A Bridge proxy with no FROST registry and no exposure controller.
async function bareBridge() {
  const [owner, , treasury] = await ethers.getSigners()
  const bank = await deploy("Bank")
  const relay = await deploy("FrostDepositRegtestRelay")
  const implementation = await deploy("Bridge")
  const admin = await deploy("ProxyAdmin")
  const legacyRegistry = await deploy("FrostDrainRegistryFixture")
  const pool = await deploy(
    "@keep-network/random-beacon/contracts/ReimbursementPool.sol:ReimbursementPool",
    [0, 0]
  )
  const init = implementation.interface.encodeFunctionData("initialize", [
    bank.address,
    relay.address,
    treasury.address,
    legacyRegistry.address,
    pool.address,
    1,
  ])
  const proxy = await deploy("TransparentUpgradeableProxy", [
    implementation.address,
    admin.address,
    init,
  ])
  await legacyRegistry.bindWalletOwner(proxy.address)
  return {
    owner,
    proxy,
    legacyRegistry,
    frost: await ethers.getContractAt("IFrostBridge", proxy.address),
  }
}

/// Deposit, sweep and legacy helpers over one movement world.
function helpers(get: () => World) {
  const reveal = (x: Wallet, amount: number) => get().reveal(x, amount)
  const keyOf = (funding: Tx) => outpoint(funding.hash, 0)
  const reserve = (funding: Tx) =>
    get().frost.reserveFrostDeposit(
      keyOf(funding),
      funding.tx,
      inclusion(funding.hash)
    )
  const sweepTx = (x: Wallet, fundings: Tx[], amounts: number[]) =>
    transaction(
      fundings.map((f) => [f.hash, 0] as [string, number]),
      [
        {
          value: amounts.reduce((a, b) => a + b, 0) - SWEEP_FEE,
          script: p2tr(x.q),
        },
      ]
    )
  const sweep = (x: Wallet, fundings: Tx[], amounts: number[]) => {
    const tx = sweepTx(x, fundings, amounts)
    return get().frost.submitFrostDepositSweepProof({
      walletId: x.id,
      transaction: tx.tx,
      proof: inclusion(tx.hash),
      includeMain: false,
      vault: ethers.constants.AddressZero,
    })
  }
  const bankTotal = async () => {
    const w = get()
    return (await w.bank.balanceOf(w.depositor.address)).add(
      await w.bank.balanceOf(w.treasury.address)
    )
  }
  let created = 0
  /// Registers a legacy wallet through the real registry callback.
  const legacyWallet = async () => {
    created += 1
    const pub = ethers.utils.computePublicKey(
      ethers.utils.hexZeroPad(ethers.utils.hexlify(7000 + created), 32)
    )
    const compressed = ethers.utils.computePublicKey(pub, true)
    await get().legacyRegistry.publish(
      ethers.utils.id(`C-10 legacy wallet ${created}`),
      `0x${pub.slice(4, 68)}`,
      `0x${pub.slice(68)}`
    )
    return ethers.utils.ripemd160(ethers.utils.sha256(compressed))
  }
  const legacyNode = (pkh: string) =>
    get().entry(get().child(get().self, "registeredWallets"), pkh, "bytes20")
  /// Controlled legacy markers, as in Frost.Movement: a main UTXO and
  /// MovingFunds for a wallet registered through the real callback.
  const legacyMovingFunds = async (pkh: string, value: number) => {
    const w = get()
    const main = {
      txHash: ethers.utils.id(`C-10 legacy main ${pkh}`),
      txOutputIndex: 0,
      txOutputValue: value,
    }
    await w.writeField(
      w.child(legacyNode(pkh), "mainUtxoHash"),
      ethers.utils.solidityKeccak256(
        ["bytes32", "uint32", "uint64"],
        [main.txHash, main.txOutputIndex, main.txOutputValue]
      )
    )
    const live = w.child(w.self, "liveWalletsCount")
    await w.writeField(live, (await w.readField(live)) - 1)
    await w.writeField(
      w.child(legacyNode(pkh), "state"),
      LegacyState.MovingFunds
    )
    await w.writeField(
      w.child(legacyNode(pkh), "movingFundsRequestedAt"),
      await w.now()
    )
    return main
  }
  /// A real legacy deposit revealed to a Live legacy wallet: the P2WSH
  /// deposit script of the legacy Bridge, refundable to the same key.
  const legacyDeposit = async (pkh: string, amount: number) => {
    const w = get()
    const locktime = Buffer.alloc(4)
    locktime.writeUInt32LE((await w.now()) + 30 * 86400)
    const blinding = ethers.utils.hexZeroPad(ethers.utils.hexlify(++created), 8)
    const script = `0x14${w.depositor.address.slice(2)}7508${blinding.slice(
      2
    )}7576a914${pkh.slice(2)}8763ac6776a914${pkh.slice(
      2
    )}8804${locktime.toString("hex")}b175ac68`
    const funding = transaction(
      [[ethers.utils.id(`C-10 legacy funding ${created}`), 0]],
      [
        {
          value: amount,
          script: Buffer.from(
            `220020${ethers.utils.sha256(script).slice(2)}`,
            "hex"
          ),
        },
      ]
    )
    await w.bridge.connect(w.depositor).revealDeposit(funding.tx, {
      fundingOutputIndex: 0,
      blindingFactor: blinding,
      walletPubKeyHash: pkh,
      refundPubKeyHash: pkh,
      refundLocktime: `0x${locktime.toString("hex")}`,
      vault: ethers.constants.AddressZero,
    })
    return funding
  }
  const legacyState = (pkh: string) =>
    get().readField(get().child(legacyNode(pkh), "state"))
  /// A drain commitment of a legacy main into the first two FROST wallets.
  const commitDrain = async (pkh: string, main: any) => {
    const w = get()
    const targets = ascending(w.wallets).slice(0, 2)
    await w.bridge.connect(w.operator).submitMovingFundsCommitment(
      pkh,
      main,
      [1, 2, 3],
      0,
      targets.map((t) => t.label)
    )
    const values = split(main.txOutputValue - 3000, 2)
    const tx = transaction(
      [[main.txHash, 0]],
      targets.map((t, i) => ({ value: values[i], script: p2tr(t.q) }))
    )
    return { targets, values, tx }
  }
  return {
    reveal,
    keyOf,
    reserve,
    sweep,
    bankTotal,
    legacyWallet,
    legacyDeposit,
    legacyMovingFunds,
    legacyState,
    commitDrain,
  }
}

describe("C-10 exposure controller", () => {
  let c: any
  let governance: any
  let bridge: any
  let guardian: any
  let stranger: any
  const id = (name: string) => ethers.utils.id(`reservation ${name}`)

  beforeEach(async () => {
    ;[governance, bridge, guardian, stranger] = await ethers.getSigners()
    // An externally owned account stands in for the Bridge.
    c = await deploy("FrostExposureController", [
      bridge.address,
      governance.address,
    ])
    c = c.connect(bridge)
  })

  it("keeps the reservations within both ceilings, exactly at the boundary", async () => {
    await c.connect(governance).openBudgetPeriod(1000, 600, RECORD)
    await c.reserveDeposit(600)
    await expect(c.reserve(id("b"), 401, 0)).to.be.revertedWith(
      "FROST custody budget"
    )
    await expect(c.reserve(id("b"), 400, 1)).to.be.revertedWith(
      "FROST issuance budget"
    )
    await c.reserve(id("b"), 400, 0)
    expect(await c.remainingCustody()).to.equal(0)
    expect(await c.remainingIssuance()).to.equal(0)
    await c.completeDeposits(1, 600, 600, 500)
    await c.completeOne(id("b"), 400, 0)
    // The unused issuance (a fee) stays counted: nothing replenishes.
    expect(await counters(c)).to.deep.equal({
      custodyReserved: "1000",
      custodyReleased: "0",
      custodyAdmitted: "1000",
      issuanceReserved: "600",
      issued: "500",
    })
    expect(await c.remainingIssuance()).to.equal(0)
  })

  it("completes each reservation once and charges any excess or unreserved amount", async () => {
    await c.connect(governance).openBudgetPeriod(1000, 1000, RECORD)
    await c.reserve(id("a"), 100, 100)
    await c.completeOne(id("a"), 100, 150)
    expect(await c.issuanceReserved()).to.equal(150)
    await expect(c.completeOne(id("a"), 1, 1)).to.be.revertedWith(
      "Exposure settled"
    )
    await expect(
      c.completeOne(ethers.constants.HashZero, 1, 1)
    ).to.be.revertedWith("Exposure settled")
    // Deposits: a sweep reported as reserved beyond what is outstanding is
    // covered only up to the outstanding value; the rest is charged.
    await c.reserveDeposit(5)
    expect(await c.depositsOutstanding()).to.equal(5)
    await c.completeDeposits(2, 10, 10, 10)
    expect(await c.depositsOutstanding()).to.equal(0)
    expect(await c.custodyReserved()).to.equal(110)
    expect(await c.issuanceReserved()).to.equal(160)
    // Without a reservation a deposit is charged in full, every time.
    await c.completeDeposits(2, 0, 10, 10)
    await c.completeDeposits(2, 0, 10, 10)
    expect(await c.custodyReserved()).to.equal(130)
    expect(await c.issuanceReserved()).to.equal(180)
    await expect(c.completeOne(id("d"), 0, 821)).to.be.revertedWith(
      "FROST issuance budget"
    )
    await expect(c.completeDeposits(1, 0, 0, 821)).to.be.revertedWith(
      "FROST issuance budget"
    )
    expect(await c.issued()).to.equal(180)
    expect(await c.custodyAdmitted()).to.equal(130)
  })

  it("releases only an unsettled custody-only reservation, once, and restores no allowance", async () => {
    await c.connect(governance).openBudgetPeriod(1000, 1000, RECORD)
    await c.reserve(id("x"), 400, 0)
    await expect(c.release(id("x")))
      .to.emit(c, "ExposureReleased")
      .withArgs(id("x"), 400)
    // Reading 8 (Astra re-check of #14): a release is recorded, but its
    // custody stays counted; only a top-up makes it usable again.
    expect(await c.remainingCustody()).to.equal(600)
    await expect(c.reserve(id("z"), 601, 0)).to.be.revertedWith(
      "FROST custody budget"
    )
    await c.connect(governance).openBudgetPeriod(1400, 1000, TOP_UP)
    expect(await c.remainingCustody()).to.equal(1000)
    await expect(c.release(id("x"))).to.be.revertedWith("Exposure not reserved")
    await expect(c.completeOne(id("x"), 1, 0)).to.be.revertedWith(
      "Exposure settled"
    )
    await c.reserve(id("y"), 10, 10)
    await expect(c.release(id("y"))).to.be.revertedWith(
      "Issuance never releases"
    )
    await c.completeOne(id("y"), 10, 10)
    await expect(c.release(id("y"))).to.be.revertedWith("Exposure not reserved")
    expect(await c.custodyReleased()).to.equal(400)
  })

  it("gives governance the budget and lift, the guardian only containment, the Bridge only the counters", async () => {
    await expect(
      c.connect(stranger).openBudgetPeriod(1, 1, RECORD)
    ).to.be.revertedWith("Caller is not governance")
    await expect(
      c.connect(governance).openBudgetPeriod(1, 1, ethers.constants.HashZero)
    ).to.be.revertedWith("Budget period record")
    await c.connect(governance).openBudgetPeriod(500, 500, RECORD)
    await c.reserve(id("a"), 300, 200)
    await expect(
      c.connect(governance).openBudgetPeriod(299, 500, TOP_UP)
    ).to.be.revertedWith("Budget below reserved")
    await expect(
      c.connect(governance).openBudgetPeriod(500, 199, TOP_UP)
    ).to.be.revertedWith("Budget below reserved")
    const before = await counters(c)
    await expect(c.connect(governance).openBudgetPeriod(900, 900, TOP_UP))
      .to.emit(c, "BudgetPeriodOpened")
      .withArgs(2, 900, 900, TOP_UP)
    // A top-up raises the ceilings and resets nothing.
    expect(await counters(c)).to.deep.equal(before)
    expect(await c.remainingCustody()).to.equal(600)

    await expect(c.connect(stranger).contain(RECORD)).to.be.revertedWith(
      "Caller cannot contain"
    )
    await expect(
      c.connect(stranger).setGuardian(guardian.address)
    ).to.be.revertedWith("Caller is not governance")
    await c.connect(governance).setGuardian(guardian.address)
    await c.connect(guardian).contain(RECORD)
    expect(await c.contained()).to.equal(true)
    await expect(c.connect(guardian).lift(RECORD)).to.be.revertedWith(
      "Caller is not governance"
    )
    await expect(
      c.connect(governance).lift(ethers.constants.HashZero)
    ).to.be.revertedWith("Lift record")
    await c.connect(governance).lift(RECORD)
    expect(await c.contained()).to.equal(false)

    for (const call of [
      () => c.connect(governance).reserve(id("b"), 1, 1),
      () => c.connect(stranger).completeOne(id("a"), 1, 1),
      () => c.connect(governance).reserveDeposit(1),
      () => c.connect(governance).completeDeposits(1, 1, 1, 1),
      () => c.connect(stranger).release(id("a")),
    ])
      await expect(call()).to.be.revertedWith("Caller is not the Bridge")
    await expect(
      c.connect(stranger).transferGovernance(stranger.address)
    ).to.be.revertedWith("Caller is not governance")
  })

  it("transfers governance in two steps, so a wrong address takes nothing", async () => {
    const dead = "0x000000000000000000000000000000000000dEaD"
    await expect(c.connect(governance).transferGovernance(dead))
      .to.emit(c, "GovernanceTransferStarted")
      .withArgs(dead)
    // Nothing moves until the named address accepts; a wrong one never can.
    expect(await c.governance()).to.equal(governance.address)
    await c.connect(governance).openBudgetPeriod(1, 1, RECORD)
    await expect(c.connect(stranger).acceptGovernance()).to.be.revertedWith(
      "Caller is not pending"
    )
    await c.connect(governance).transferGovernance(stranger.address)
    await expect(c.connect(stranger).acceptGovernance())
      .to.emit(c, "GovernanceTransferred")
      .withArgs(stranger.address)
    expect(await c.governance()).to.equal(stranger.address)
    expect(await c.pendingGovernance()).to.equal(ethers.constants.AddressZero)
    await expect(
      c.connect(governance).openBudgetPeriod(2, 2, TOP_UP)
    ).to.be.revertedWith("Caller is not governance")
    await expect(c.connect(stranger).acceptGovernance()).to.be.revertedWith(
      "Caller is not pending"
    )
  })

  it("refuses new exposure under containment and completes what was reserved", async () => {
    await c.connect(governance).openBudgetPeriod(1000, 1000, RECORD)
    await c.reserve(id("a"), 100, 100)
    await c.connect(governance).contain(RECORD)
    await expect(c.reserve(id("b"), 1, 1)).to.be.revertedWith(
      "FROST exposure contained"
    )
    await expect(c.completeOne(id("c"), 1, 1)).to.be.revertedWith(
      "FROST exposure contained"
    )
    await expect(c.completeOne(id("a"), 100, 101)).to.be.revertedWith(
      "FROST exposure contained"
    )
    await c.completeOne(id("a"), 100, 90)
    await c.connect(governance).lift(RECORD)
    await c.reserve(id("b"), 1, 1)
    expect(await c.issued()).to.equal(90)
  })

  it("refuses a counter overflow instead of wrapping", async () => {
    await c.connect(governance).openBudgetPeriod(MAX_UINT64, MAX_UINT64, RECORD)
    await c.reserve(id("a"), MAX_UINT64, 0)
    // A released maximum restores nothing, so the ceiling, which no counter
    // can exceed, stops the next reservation before any counter overflows.
    await c.release(id("a"))
    await expect(c.reserve(id("b"), 1, 0)).to.be.revertedWith(
      "FROST custody budget"
    )
    await expect(c.reserveDeposit(1)).to.be.revertedWith(
      "FROST custody budget"
    )
    await c.reserve(id("c"), 0, MAX_UINT64)
    await expect(c.reserve(id("d"), 0, 1)).to.be.revertedWith(
      "FROST issuance budget"
    )
  })
})

describe("C-10 installation and gates", () => {
  it("installs the controller once, for this Bridge only, and opens no gate without it", async () => {
    const b = await bareBridge()
    const [, stranger] = await ethers.getSigners()
    const other = await deploy("FrostExposureController", [
      stranger.address,
      b.owner.address,
    ])
    await expect(
      b.frost.installFrostExposureController(other.address)
    ).to.be.revertedWith("FROST exposure controller")
    await expect(
      b.frost.installFrostExposureController(stranger.address)
    ).to.be.revertedWith("FROST exposure controller")
    await expect(b.frost.setFrostDrainEnabled(true)).to.be.revertedWith(
      "FROST exposure not installed"
    )
    await b.frost.setFrostDrainEnabled(false)
    const controller = await deploy("FrostExposureController", [
      b.proxy.address,
      b.owner.address,
    ])
    await expect(
      b.frost
        .connect(stranger)
        .installFrostExposureController(controller.address)
    ).to.be.revertedWith("Caller is not governance")
    await expect(b.frost.installFrostExposureController(controller.address))
      .to.emit(b.frost, "FrostExposureControllerInstalled")
      .withArgs(controller.address)
    expect(await b.frost.frostExposureController()).to.equal(controller.address)
    const second = await deploy("FrostExposureController", [
      b.proxy.address,
      b.owner.address,
    ])
    await expect(
      b.frost.installFrostExposureController(second.address)
    ).to.be.revertedWith("FROST exposure installed")
    await b.frost.setFrostDrainEnabled(true)
  })
})

describe("C-10 exposure through the Bridge", () => {
  let w: World
  let snapshot: string
  const h = helpers(() => w)

  before(async () => {
    w = await movementWorld(4)
    await w.legacyRegistry.setMember(w.operator.address)
    await w.frost.setFrostDrainEnabled(true)
    snapshot = await network.provider.send("evm_snapshot")
  })
  beforeEach(async () => {
    expect(await network.provider.send("evm_revert", [snapshot])).to.equal(true)
    snapshot = await network.provider.send("evm_snapshot")
  })

  it("reserves a proven deposit once and credits it within the reservation", async () => {
    const [x] = w.wallets
    await w.exposure.openBudgetPeriod(100000, 100000, RECORD)
    const funding = await h.reveal(x, 50000)
    const key = h.keyOf(funding)
    // Optimistic minting cannot see a FROST deposit.
    expect((await w.bridge.deposits(key)).revealedAt).to.equal(0)
    const forged = transaction(
      [[ethers.utils.id("another funding"), 0]],
      [{ value: 50000, script: p2tr(x.q) }]
    )
    await expect(
      w.frost.reserveFrostDeposit(key, forged.tx, inclusion(forged.hash))
    ).to.be.revertedWith("FROST funding proof")
    await expect(
      w.frost.reserveFrostDeposit(
        outpoint(funding.hash, 1),
        funding.tx,
        inclusion(funding.hash)
      )
    ).to.be.revertedWith("FROST deposit not pending")
    await expect(h.reserve(funding))
      .to.emit(w.frost, "FrostDepositReserved")
      .withArgs(key, 50000)
    expect(await w.frost.frostDepositReserved(key)).to.equal(true)
    expect(await w.exposure.depositsOutstanding()).to.equal(50000)
    expect(await w.exposure.remainingCustody()).to.equal(50000)
    expect(await w.exposure.remainingIssuance()).to.equal(50000)
    await expect(h.reserve(funding)).to.be.revertedWith(
      "FROST deposit reserved"
    )

    await h.sweep(x, [funding], [50000])
    // 50,000 less the 1,000 sweep fee: 48,500 to the depositor, 500 treasury.
    expect(await w.bank.balanceOf(w.depositor.address)).to.equal(48500)
    expect(await w.bank.balanceOf(w.treasury.address)).to.equal(500)
    expect(await counters(w.exposure)).to.deep.equal({
      custodyReserved: "50000",
      custodyReleased: "0",
      custodyAdmitted: "50000",
      issuanceReserved: "50000",
      issued: "49000",
    })
    expect(await w.frost.frostDepositReserved(key)).to.equal(false)
    expect(await w.exposure.depositsOutstanding()).to.equal(0)
    await expect(h.reserve(funding)).to.be.revertedWith(
      "FROST deposit not pending"
    )
  })

  it("refuses a reservation once the deposit can be refunded before a sweep lands", async () => {
    const [x] = w.wallets
    await w.exposure.openBudgetPeriod(1000000, 1000000, RECORD)
    await expect(
      w.frost.connect(w.operator).setFrostDepositReservationMargin(3600)
    ).to.be.revertedWith("Caller is not governance")
    await expect(w.frost.setFrostDepositReservationMargin(3600))
      .to.emit(w.frost, "FrostDepositReservationMarginSet")
      .withArgs(3600)
    expect(await w.frost.frostDepositReservationMargin()).to.equal(3600)
    // Inside the margin: refused, and nothing is charged.
    const inside = await w.reveal(x, 50000, 3000)
    await expect(h.reserve(inside)).to.be.revertedWith(
      "FROST deposit refund window"
    )
    // Past the locktime, the refund leaf is open: refused even with no margin.
    await w.frost.setFrostDepositReservationMargin(0)
    const late = await w.reveal(x, 50000, 600)
    await network.provider.send("evm_increaseTime", [86400])
    await network.provider.send("evm_mine")
    await expect(h.reserve(late)).to.be.revertedWith(
      "FROST deposit refund window"
    )
    expect(await counters(w.exposure)).to.deep.equal({
      custodyReserved: "0",
      custodyReleased: "0",
      custodyAdmitted: "0",
      issuanceReserved: "0",
      issued: "0",
    })
    // Clear of the margin: accepted.
    await w.frost.setFrostDepositReservationMargin(3600)
    const clear = await w.reveal(x, 50000, 7200)
    await h.reserve(clear)
    expect(await w.exposure.depositsOutstanding()).to.equal(50000)
  })

  it("credits a reserved deposit through the vault and mints within the issuance count", async () => {
    // Adversarial review of #14: the vault route is the one that mints TBTC.
    const [x, y] = w.wallets
    const token = await deploy("TBTC")
    const vault = await deploy("TBTCVault", [
      w.bank.address,
      token.address,
      w.bridge.address,
    ])
    await token.transferOwnership(vault.address)
    await w.bridge.setVaultStatus(vault.address, true)
    await w.exposure.openBudgetPeriod(150000, 79000, RECORD)
    const a = await w.reveal(x, 50000, 86400, vault.address)
    const b = await w.reveal(x, 30000, 86400, vault.address)
    await h.reserve(a)
    await expect(h.reserve(b)).to.be.revertedWith("FROST issuance budget")
    await w.exposure.openBudgetPeriod(150000, 80000, TOP_UP)
    await h.reserve(b)
    const swept = transaction(
      [
        [a.hash, 0],
        [b.hash, 0],
      ],
      [{ value: 79000, script: p2tr(x.q) }]
    )
    await w.frost.submitFrostDepositSweepProof({
      walletId: x.id,
      transaction: swept.tx,
      proof: inclusion(swept.hash),
      includeMain: false,
      vault: vault.address,
    })
    // 80,000 less the 1,000 fee; 500 + 300 treasury fees.
    const vaultCredit = await w.bank.balanceOf(vault.address)
    const treasuryCredit = await w.bank.balanceOf(w.treasury.address)
    expect(vaultCredit).to.equal(78200)
    expect(treasuryCredit).to.equal(800)
    expect(await token.totalSupply()).to.equal(
      vaultCredit.mul(ethers.BigNumber.from(10).pow(10))
    )
    expect(await w.exposure.issued()).to.equal(
      vaultCredit.add(treasuryCredit)
    )
    expect(await w.exposure.custodyAdmitted()).to.equal(80000)
    expect(await w.exposure.depositsOutstanding()).to.equal(0)
    // An unreserved deposit through the vault: refused under containment
    // and beyond the ceiling, with nothing credited or minted.
    const c = await w.reveal(y, 70000, 86400, vault.address)
    const unreserved = transaction(
      [[c.hash, 0]],
      [{ value: 69000, script: p2tr(y.q) }]
    )
    const proof = {
      walletId: y.id,
      transaction: unreserved.tx,
      proof: inclusion(unreserved.hash),
      includeMain: false,
      vault: vault.address,
    }
    const supply = await token.totalSupply()
    await w.exposure.contain(RECORD)
    await expect(w.frost.submitFrostDepositSweepProof(proof)).to.be.revertedWith(
      "FROST exposure contained"
    )
    await w.exposure.lift(RECORD)
    await expect(w.frost.submitFrostDepositSweepProof(proof)).to.be.revertedWith(
      "FROST issuance budget"
    )
    expect(await token.totalSupply()).to.equal(supply)
    expect(await w.bank.balanceOf(vault.address)).to.equal(vaultCredit)
    expect(await w.exposure.issued()).to.equal(79000)
  })

  it("charges an unreserved deposit at its sweep, refuses one beyond the budget, and a top-up admits it", async () => {
    // Each sweep funds a fresh wallet: a funded wallet must spend its main.
    const [x, y] = w.wallets
    await w.exposure.openBudgetPeriod(60000, 60000, RECORD)
    const first = await h.reveal(x, 50000)
    await h.sweep(x, [first], [50000])
    expect(await w.exposure.remainingCustody()).to.equal(10000)
    const second = await h.reveal(y, 20000)
    await expect(h.reserve(second)).to.be.revertedWith("FROST custody budget")
    const before = await h.bankTotal()
    await expect(h.sweep(y, [second], [20000])).to.be.revertedWith(
      "FROST custody budget"
    )
    // The refused proof changed nothing.
    expect(await h.bankTotal()).to.equal(before)
    expect((await w.frost.frostWalletCustody(y.id)).value).to.equal(0)
    expect((await w.deposit(h.keyOf(second))).sweptAt).to.equal(0)
    await w.exposure.openBudgetPeriod(100000, 100000, TOP_UP)
    expect(await w.exposure.period()).to.equal(3)
    await h.reserve(second)
    await h.sweep(y, [second], [20000])
    expect(await w.exposure.issued()).to.equal((await h.bankTotal()).toNumber())
  })

  it("reserves a legacy drain's custody at its commitment and completes it with the value that reached FROST", async () => {
    const pkh = await h.legacyWallet()
    const main = await h.legacyMovingFunds(pkh, 400000)
    await w.exposure.openBudgetPeriod(399999, 0, RECORD)
    await expect(h.commitDrain(pkh, main)).to.be.revertedWith(
      "FROST custody budget"
    )
    await w.exposure.openBudgetPeriod(1000000, 0, TOP_UP)
    const { tx } = await h.commitDrain(pkh, main)
    const id = await w.frost.frostDrainReservationId(pkh)
    expect((await w.exposure.reservations(id)).custody).to.equal(400000)
    await w.bridge.submitMovingFundsProof(tx.tx, inclusion(tx.hash), main, pkh)
    expect(await h.legacyState(pkh)).to.equal(LegacyState.Closing)
    const done = await w.exposure.reservations(id)
    expect([done.custody.toNumber(), done.state]).to.deep.equal([400000, 2])
    // The 3,000 fee stays counted; 397,000 entered FROST.
    expect(await counters(w.exposure)).to.deep.equal({
      custodyReserved: "400000",
      custodyReleased: "0",
      custodyAdmitted: "397000",
      issuanceReserved: "0",
      issued: "0",
    })
  })

  it("releases a drain's custody when its legacy main provably went elsewhere", async () => {
    const pkh = await h.legacyWallet()
    const main = await h.legacyMovingFunds(pkh, 400000)
    await w.exposure.openBudgetPeriod(400000, 0, RECORD)
    await h.commitDrain(pkh, main)
    expect(await w.exposure.remainingCustody()).to.equal(0)
    const conflict = transaction(
      [[main.txHash, 0]],
      [{ value: 397000, script: p2wpkh(pkh) }]
    )
    await w.frost.releaseFrostDrainOnConflict(
      pkh,
      main,
      conflict.tx,
      inclusion(conflict.hash)
    )
    expect(await w.exposure.custodyReleased()).to.equal(400000)
    // Reading 8: the release is recorded but the custody stays counted.
    expect(await w.exposure.remainingCustody()).to.equal(0)
    await w.exposure.openBudgetPeriod(800000, 0, TOP_UP)
    expect(await w.exposure.remainingCustody()).to.equal(400000)
  })

  it("releases a drain when a legacy deposit sweep replaces its source main, so the larger drain reserves again before signing", async () => {
    // Review of #14: a drain reserved for main M must never be signed for a
    // larger main. The legacy sweep proof that replaces M releases the drain;
    // the recommitment reserves the new value or is refused before any
    // signature, with no capacity left or under containment.
    const pkh = await h.legacyWallet()
    const late = await h.legacyDeposit(pkh, 100000)
    const main = await h.legacyMovingFunds(pkh, 300000)
    await w.exposure.openBudgetPeriod(300000, 0, RECORD)
    const { targets } = await h.commitDrain(pkh, main)
    const first = await w.frost.frostDrainReservationId(pkh)
    const sweep = transaction(
      [
        [late.hash, 0],
        [main.txHash, 0],
      ],
      [{ value: 399000, script: p2wpkh(pkh) }]
    )
    await expect(
      w.bridge.submitDepositSweepProof(
        sweep.tx,
        inclusion(sweep.hash),
        main,
        ethers.constants.AddressZero
      )
    )
      .to.emit(w.frost, "FrostDrainReleased")
      .withArgs(pkh)
    expect((await w.exposure.reservations(first)).state).to.equal(3)
    expect(await w.exposure.custodyReleased()).to.equal(300000)
    expect(await w.frost.frostDrainTargets(pkh)).to.deep.equal([])
    for (const t of targets)
      expect(
        (await w.frost.frostMovementCounters(t.id)).inboundCommitments
      ).to.equal(0)
    const grown = {
      txHash: sweep.hash,
      txOutputIndex: 0,
      txOutputValue: 399000,
    }
    await expect(h.commitDrain(pkh, grown)).to.be.revertedWith(
      "FROST custody budget"
    )
    await w.exposure.openBudgetPeriod(1000000, 0, TOP_UP)
    await w.exposure.contain(RECORD)
    await expect(h.commitDrain(pkh, grown)).to.be.revertedWith(
      "FROST exposure contained"
    )
    await w.exposure.lift(RECORD)
    const { tx } = await h.commitDrain(pkh, grown)
    const second = await w.frost.frostDrainReservationId(pkh)
    expect((await w.exposure.reservations(second)).custody).to.equal(399000)
    await w.bridge.submitMovingFundsProof(tx.tx, inclusion(tx.hash), grown, pkh)
    expect(await h.legacyState(pkh)).to.equal(LegacyState.Closing)
    expect(await counters(w.exposure)).to.deep.equal({
      custodyReserved: "699000",
      custodyReleased: "300000",
      custodyAdmitted: "396000",
      issuanceReserved: "0",
      issued: "0",
    })
  })

  it("clears the commitment when the conflict release lands before the main-replacing proof", async () => {
    // Adversarial review of #14: anyone may prove the conflicting spend
    // first. The release must still clear the commitment, or the source can
    // never recommit and times out with its new main stranded.
    const pkh = await h.legacyWallet()
    const late = await h.legacyDeposit(pkh, 100000)
    const main = await h.legacyMovingFunds(pkh, 300000)
    await w.exposure.openBudgetPeriod(1000000, 0, RECORD)
    const { targets } = await h.commitDrain(pkh, main)
    const sweep = transaction(
      [
        [late.hash, 0],
        [main.txHash, 0],
      ],
      [{ value: 399000, script: p2wpkh(pkh) }]
    )
    await expect(
      w.frost
        .connect(w.depositor)
        .releaseFrostDrainOnConflict(pkh, main, sweep.tx, inclusion(sweep.hash))
    )
      .to.emit(w.frost, "FrostDrainReleased")
      .withArgs(pkh)
    expect(
      (await w.bridge.wallets(pkh)).movingFundsTargetWalletsCommitmentHash
    ).to.equal(ethers.constants.HashZero)
    for (const t of targets)
      expect(
        (await w.frost.frostMovementCounters(t.id)).inboundCommitments
      ).to.equal(0)
    // The sweep proof finds no drain left and replaces the main.
    await expect(
      w.bridge.submitDepositSweepProof(
        sweep.tx,
        inclusion(sweep.hash),
        main,
        ethers.constants.AddressZero
      )
    ).not.to.emit(w.frost, "FrostDrainReleased")
    const grown = {
      txHash: sweep.hash,
      txOutputIndex: 0,
      txOutputValue: 399000,
    }
    // The source recommits against its new main and the drain completes.
    const { tx } = await h.commitDrain(pkh, grown)
    const second = await w.frost.frostDrainReservationId(pkh)
    expect((await w.exposure.reservations(second)).custody).to.equal(399000)
    await w.bridge.submitMovingFundsProof(tx.tx, inclusion(tx.hash), grown, pkh)
    expect(await h.legacyState(pkh)).to.equal(LegacyState.Closing)
    expect(await counters(w.exposure)).to.deep.equal({
      custodyReserved: "699000",
      custodyReleased: "300000",
      custodyAdmitted: "396000",
      issuanceReserved: "0",
      issued: "0",
    })
  })

  it("proves a drain-committed source only as a drain", async () => {
    // Adversarial review of #14: legacy-shaped outputs to the FROST labels
    // match the commitment hash; accepting them would close the source with
    // the reservation and the targets' inbound obligations stranded.
    const pkh = await h.legacyWallet()
    const main = await h.legacyMovingFunds(pkh, 400000)
    await w.exposure.openBudgetPeriod(1000000, 0, RECORD)
    const { targets, values } = await h.commitDrain(pkh, main)
    const legacyShaped = transaction(
      [[main.txHash, 0]],
      targets.map((t, i) => ({ value: values[i], script: p2wpkh(t.label) }))
    )
    await expect(
      w.bridge.submitMovingFundsProof(
        legacyShaped.tx,
        inclusion(legacyShaped.hash),
        main,
        pkh
      )
    ).to.be.revertedWith("FROST drain mixes schemes")
    expect(await h.legacyState(pkh)).to.equal(LegacyState.MovingFunds)
  })

  it("refuses a drain commitment below the moving funds dust threshold", async () => {
    // Adversarial review of #14: a below-dust source closes without moving
    // its main, which would leave a drain reserved and unprovable.
    const dust = (await w.bridge.movingFundsParameters())
      .movingFundsDustThreshold
    const pkh = await h.legacyWallet()
    const main = await h.legacyMovingFunds(pkh, dust - 1)
    await w.exposure.openBudgetPeriod(1000000, 0, RECORD)
    await expect(h.commitDrain(pkh, main)).to.be.revertedWith(
      "FROST drain below dust"
    )
    expect(await w.exposure.custodyReserved()).to.equal(0)
    expect(await w.frost.frostDrainTargets(pkh)).to.deep.equal([])
  })

  it("releases a drain when a legacy moved-funds sweep replaces its source main", async () => {
    // Re-check of #14: a donor commits to the source while it is Live; the
    // source then commits a FROST drain; the donor's proof lands and the
    // source sweeps the moved funds into a larger main. That sweep releases
    // the drain, so no reservation leaks and the larger drain reserves again.
    const donor = await h.legacyWallet()
    const source = await h.legacyWallet()
    const donorMain = await h.legacyMovingFunds(donor, 100000)
    await w.bridge
      .connect(w.operator)
      .submitMovingFundsCommitment(donor, donorMain, [1, 2, 3], 0, [source])
    const main = await h.legacyMovingFunds(source, 300000)
    await w.exposure.openBudgetPeriod(300000, 0, RECORD)
    await h.commitDrain(source, main)
    const first = await w.frost.frostDrainReservationId(source)
    const moved = transaction(
      [[donorMain.txHash, 0]],
      [{ value: 97000, script: p2wpkh(source) }]
    )
    await w.bridge.submitMovingFundsProof(
      moved.tx,
      inclusion(moved.hash),
      donorMain,
      donor
    )
    const sweep = transaction(
      [
        [moved.hash, 0],
        [main.txHash, 0],
      ],
      [{ value: 396000, script: p2wpkh(source) }]
    )
    await expect(
      w.bridge.submitMovedFundsSweepProof(sweep.tx, inclusion(sweep.hash), main)
    )
      .to.emit(w.frost, "FrostDrainReleased")
      .withArgs(source)
    expect((await w.exposure.reservations(first)).state).to.equal(3)
    expect(await w.exposure.remainingCustody()).to.equal(0)
    expect(await w.frost.frostDrainTargets(source)).to.deep.equal([])
    const grown = {
      txHash: sweep.hash,
      txOutputIndex: 0,
      txOutputValue: 396000,
    }
    await expect(h.commitDrain(source, grown)).to.be.revertedWith(
      "FROST custody budget"
    )
    // Reading 8: the released 300,000 still counts, so a 396,000 ceiling
    // is not enough; the top-up must cover both.
    await w.exposure.openBudgetPeriod(396000, 0, TOP_UP)
    await expect(h.commitDrain(source, grown)).to.be.revertedWith(
      "FROST custody budget"
    )
    await w.exposure.openBudgetPeriod(696000, 0, TOP_UP)
    await w.exposure.contain(RECORD)
    await expect(h.commitDrain(source, grown)).to.be.revertedWith(
      "FROST exposure contained"
    )
    await w.exposure.lift(RECORD)
    const { tx } = await h.commitDrain(source, grown)
    await w.bridge.submitMovingFundsProof(
      tx.tx,
      inclusion(tx.hash),
      grown,
      source
    )
    expect(await h.legacyState(source)).to.equal(LegacyState.Closing)
    expect(await counters(w.exposure)).to.deep.equal({
      custodyReserved: "696000",
      custodyReleased: "300000",
      custodyAdmitted: "393000",
      issuanceReserved: "0",
      issued: "0",
    })
  })

  it("releases a drain when a timed-out legacy redemption's proof replaces its source main", async () => {
    // Re-check of #14 (audit of every main-changing proof): a timed-out
    // redemption moves a Live source to MovingFunds; the source commits a
    // FROST drain; the original payment then confirms and is proven.
    const params = await w.bridge.walletParameters()
    await w.bridge.updateWalletParameters(
      params.walletCreationPeriod,
      params.walletCreationMinBtcBalance,
      params.walletCreationMaxBtcBalance,
      params.walletClosureMinBtcBalance,
      params.walletMaxAge,
      1500000,
      params.walletClosingPeriod
    )
    const source = await h.legacyWallet()
    const deposit = await h.legacyDeposit(source, 3000000)
    const funded = transaction(
      [[deposit.hash, 0]],
      [{ value: 2999000, script: p2wpkh(source) }]
    )
    await w.bridge.submitDepositSweepProof(
      funded.tx,
      inclusion(funded.hash),
      { txHash: ethers.constants.HashZero, txOutputIndex: 0, txOutputValue: 0 },
      ethers.constants.AddressZero
    )
    const main = {
      txHash: funded.hash,
      txOutputIndex: 0,
      txOutputValue: 2999000,
    }
    const redeemer = `0x160014${ethers.utils.id("C-10 redeemer").slice(2, 42)}`
    await w.bank.connect(w.depositor).approveBalance(w.bridge.address, 1500000)
    await w.bridge
      .connect(w.depositor)
      .requestRedemption(source, main, redeemer, 1500000)
    await network.provider.send("evm_increaseTime", [5 * 86400 + 1])
    await network.provider.send("evm_mine")
    await w.bridge.notifyRedemptionTimeout(source, [1, 2, 3], redeemer)
    expect(await h.legacyState(source)).to.equal(LegacyState.MovingFunds)
    await w.exposure.openBudgetPeriod(2999000, 0, RECORD)
    await h.commitDrain(source, main)
    const first = await w.frost.frostDrainReservationId(source)
    // The overdue payment: 1,500,000 less the 750 treasury fee and a 1,000
    // fee share to the redeemer; the change returns to the source.
    const payment = transaction(
      [[main.txHash, 0]],
      [
        { value: 1498250, script: Buffer.from(redeemer.slice(2), "hex") },
        { value: 1498750, script: p2wpkh(source) },
      ]
    )
    await expect(
      w.bridge.submitRedemptionProof(
        payment.tx,
        inclusion(payment.hash),
        main,
        source
      )
    )
      .to.emit(w.frost, "FrostDrainReleased")
      .withArgs(source)
    expect((await w.exposure.reservations(first)).state).to.equal(3)
    expect(await w.exposure.remainingCustody()).to.equal(0)
    await w.exposure.openBudgetPeriod(2999000 + 1498750, 0, TOP_UP)
    const change = {
      txHash: payment.hash,
      txOutputIndex: 1,
      txOutputValue: 1498750,
    }
    // The smaller change needs one target (1,500,000 per transfer).
    await w.bridge
      .connect(w.operator)
      .submitMovingFundsCommitment(source, change, [1, 2, 3], 0, [
        ascending(w.wallets)[0].label,
      ])
    const second = await w.frost.frostDrainReservationId(source)
    expect((await w.exposure.reservations(second)).custody).to.equal(1498750)
  })

  it("adds nothing for FROST-to-FROST movement or the receiving sweeps", async () => {
    const [source] = w.wallets
    await w.fund(source, 600000)
    const frame = await counters(w.exposure)
    await w.enterMovingFunds(source)
    const targets = ascending(w.wallets.slice(1))
    await w.frost.connect(w.operator).submitFrostMovingFundsCommitment(
      source.id,
      0,
      targets.map((t) => t.label)
    )
    const values = split(source.value - 3000, targets.length)
    const move = transaction(
      [[(source.main as Tx).hash, 0]],
      targets.map((t, i) => ({ value: values[i], script: p2tr(t.q) }))
    )
    await w.frost.submitFrostMovingFundsProof(
      source.id,
      move.tx,
      inclusion(move.hash)
    )
    for (let i = 0; i < targets.length; i++) {
      const tx = transaction(
        [[move.hash, i]],
        [{ value: values[i] - 500, script: p2tr(targets[i].q) }]
      )
      await w.frost.submitFrostMovedFundsSweepProof(
        targets[i].id,
        tx.tx,
        inclusion(tx.hash)
      )
    }
    expect(await counters(w.exposure)).to.deep.equal(frame)
  })

  it("bounds a faulty deposit validator's credits by the issuance budget", async () => {
    // The assumed fault: the relay admits proofs of fabricated funding and
    // sweep transactions, so the validator credits deposits that never
    // entered custody. The controller is the only bound.
    await w.exposure.openBudgetPeriod(10000000, 100000, RECORD)
    const credited: number[] = []
    for (let i = 0; i < 3; i++) {
      const x = w.wallets[i]
      const fabricated = await h.reveal(x, 40000)
      const sweep = h.sweep(x, [fabricated], [40000])
      if (i < 2) {
        await sweep
        credited.push(40000 - SWEEP_FEE)
      } else await expect(sweep).to.be.revertedWith("FROST issuance budget")
    }
    const total = credited.reduce((a, b) => a + b, 0)
    expect(await h.bankTotal()).to.equal(total)
    expect(await w.exposure.issued()).to.equal(total)
    expect(total).to.be.at.most(100000)
    // Fabricated reservations stop at the custody ceiling the same way.
    await w.exposure.openBudgetPeriod(150000, 1000000, TOP_UP)
    const fabricated = await h.reveal(w.wallets[3], 70001)
    await expect(h.reserve(fabricated)).to.be.revertedWith(
      "FROST custody budget"
    )
  })

  it("keeps every Bank credit inside the controller's count, whatever the sweep accounting computes", async () => {
    // The contained-fault controls inject faults into the sweep's credit
    // accounting; each proof must still credit exactly what the controller
    // counted, within the ceiling, or revert atomically. The ceiling sits
    // below three uncharged-fee credits (3 x 50,000), so both injected
    // faults reach the refusal (adversarial review of #14).
    await w.exposure.openBudgetPeriod(10000000, 149999, RECORD)
    for (let i = 0; i < 3; i++) {
      const x = w.wallets[i]
      const funding = await h.reveal(x, 50000)
      const before = await h.bankTotal()
      const issuedBefore = await w.exposure.issued()
      try {
        await h.sweep(x, [funding], [50000])
      } catch (error: any) {
        expect(String(error.message)).to.contain("FROST issuance budget")
        expect(await h.bankTotal()).to.equal(before)
        expect(await w.exposure.issued()).to.equal(issuedBefore)
      }
      expect(await h.bankTotal()).to.equal(await w.exposure.issued())
      expect((await w.exposure.issued()).toNumber()).to.be.at.most(149999)
    }
  })

  it("measures a 128-deposit sweep with every deposit reserved", async function () {
    // 128 reveals and reservations take longer than mocha's default.
    this.timeout(600000)
    const [x] = w.wallets
    const fundings: Tx[] = []
    for (let i = 0; i < 128; i++) {
      const funding = await h.reveal(x, 20000)
      await h.reserve(funding)
      fundings.push(funding)
    }
    const receipt = await (
      await h.sweep(
        x,
        fundings,
        fundings.map(() => 20000)
      )
    ).wait()
    // eslint-disable-next-line no-console
    console.log(
      `      128-deposit reserved sweep gas: ${receipt.gasUsed.toString()}`
    )
    expect(receipt.gasUsed.toNumber()).to.be.lessThan(16777216)
    expect(await w.exposure.issued()).to.equal((await h.bankTotal()).toNumber())
    expect(await w.exposure.custodyAdmitted()).to.equal(128 * 20000)
  })
})

describe("C-10 containment", () => {
  let w: World
  let snapshot: string
  let guardian: any
  let challenger: any
  const h = helpers(() => w)
  const secretOf = (wallet: Wallet) =>
    ethers.utils
      .hexZeroPad(ethers.utils.hexlify(1000 + w.wallets.indexOf(wallet)), 32)
      .slice(2)

  before(async () => {
    w = await movementWorld(4)
    ;[, , , , guardian, challenger] = w.signers
    await w.legacyRegistry.setMember(w.operator.address)
    await w.frost.setFrostDrainEnabled(true)
    await w.exposure.setGuardian(guardian.address)
    snapshot = await network.provider.send("evm_snapshot")
  })
  beforeEach(async () => {
    expect(await network.provider.send("evm_revert", [snapshot])).to.equal(true)
    snapshot = await network.provider.send("evm_snapshot")
  })

  it("stops reveals, reservations and drain commitments, and completes the work reserved before it", async () => {
    const [x] = w.wallets
    const reserved = await h.reveal(x, 50000)
    await h.reserve(reserved)
    const unreserved = await h.reveal(x, 30000)
    const first = await h.legacyWallet()
    const firstMain = await h.legacyMovingFunds(first, 400000)
    const drain = await h.commitDrain(first, firstMain)
    const second = await h.legacyWallet()
    const secondMain = await h.legacyMovingFunds(second, 300000)

    await w.exposure.connect(guardian).contain(RECORD)
    await expect(h.reveal(x, 20000)).to.be.revertedWith(
      "FROST exposure contained"
    )
    await expect(h.reserve(unreserved)).to.be.revertedWith(
      "FROST exposure contained"
    )
    await expect(h.sweep(x, [unreserved], [30000])).to.be.revertedWith(
      "FROST exposure contained"
    )
    await expect(h.commitDrain(second, secondMain)).to.be.revertedWith(
      "FROST exposure contained"
    )
    // In flight before containment: the reserved sweep and drain complete.
    await h.sweep(x, [reserved], [50000])
    await w.bridge.submitMovingFundsProof(
      drain.tx.tx,
      inclusion(drain.tx.hash),
      firstMain,
      first
    )
    expect(await h.legacyState(first)).to.equal(LegacyState.Closing)
    expect(await w.exposure.issued()).to.equal(49000)

    await w.exposure.lift(RECORD)
    await h.reserve(unreserved)
    await h.commitDrain(second, secondMain)
  })

  it("keeps exits open under containment: a FROST movement, a drain release and a fraud defense", async () => {
    const [source] = w.wallets
    await w.fund(source, 600000)
    const pkh = await h.legacyWallet()
    const main = await h.legacyMovingFunds(pkh, 400000)
    await h.commitDrain(pkh, main)
    await w.exposure.connect(guardian).contain(RECORD)

    const nonce = 7n
    const digest = await w.frost.frostHeartbeatDigest(source.id, nonce)
    const signature = `0x${Buffer.from(
      await secp.schnorr.sign(raw(digest), secretOf(source), new Uint8Array(32))
    ).toString("hex")}`
    await w.frost
      .connect(challenger)
      .submitFrostFraudChallenge(source.id, digest, signature, { value: BOND })
    await w.frost.defeatFrostFraudChallengeWithHeartbeat(source.id, nonce)

    const conflict = transaction(
      [[main.txHash, 0]],
      [{ value: 397000, script: p2wpkh(pkh) }]
    )
    await w.frost.releaseFrostDrainOnConflict(
      pkh,
      main,
      conflict.tx,
      inclusion(conflict.hash)
    )

    await w.enterMovingFunds(source)
    const targets = ascending(w.wallets.slice(1))
    await w.frost.connect(w.operator).submitFrostMovingFundsCommitment(
      source.id,
      0,
      targets.map((t) => t.label)
    )
    const values = split(source.value - 3000, targets.length)
    const move = transaction(
      [[(source.main as Tx).hash, 0]],
      targets.map((t, i) => ({ value: values[i], script: p2tr(t.q) }))
    )
    await w.frost.submitFrostMovingFundsProof(
      source.id,
      move.tx,
      inclusion(move.hash)
    )
    expect(await w.exposure.contained()).to.equal(true)
  })
})

describe("C-10 losses", () => {
  let w: World
  const h = helpers(() => w)

  before(async () => {
    w = await movementWorld(3)
    await w.legacyRegistry.setMember(w.operator.address)
    await w.frost.setFrostDrainEnabled(true)
  })

  it("replenishes nothing when a drain-committed legacy source times out under containment", async () => {
    // Adversarial review of #14 (SC-09): a loss leaves every counter and
    // the remaining allowance as they were.
    const pkh = await h.legacyWallet()
    const main = await h.legacyMovingFunds(pkh, 400000)
    await w.exposure.openBudgetPeriod(1000000, 0, RECORD)
    await h.commitDrain(pkh, main)
    await w.exposure.contain(RECORD)
    const before = await counters(w.exposure)
    const remaining = await w.exposure.remainingCustody()
    await network.provider.send("evm_increaseTime", [7 * 86400 + 1])
    await network.provider.send("evm_mine")
    await w.bridge.notifyMovingFundsTimeout(pkh, [1, 2, 3])
    expect(await h.legacyState(pkh)).to.equal(LegacyState.Terminated)
    expect(await counters(w.exposure)).to.deep.equal(before)
    expect(await w.exposure.remainingCustody()).to.equal(remaining)
  })
})

describe("C-10 one-way DKG cutover", () => {
  let w: World
  let snapshot: string
  let stranger: any
  const h = helpers(() => w)
  const none = {
    txHash: ethers.constants.HashZero,
    txOutputIndex: 0,
    txOutputValue: 0,
  }
  const MANIFEST = ethers.utils.id("C-10 test cutover manifest")

  before(async () => {
    w = await movementWorld(3)
    ;[, , , , , , stranger] = w.signers
    await w.legacyRegistry.setMember(w.operator.address)
    await w.frost.setFrostDrainEnabled(true)
    snapshot = await network.provider.send("evm_snapshot")
  })
  beforeEach(async () => {
    expect(await network.provider.send("evm_revert", [snapshot])).to.equal(true)
    snapshot = await network.provider.send("evm_snapshot")
  })

  it("moves only forward, by governance, with records", async () => {
    expect(await w.frost.frostCreationMode()).to.equal(Mode.LegacyOpen)
    await expect(w.frost.completeFrostCutover(MANIFEST)).to.be.revertedWith(
      "FROST cutover state"
    )
    await expect(w.frost.abortLegacyDkgDrain(RECORD)).to.be.revertedWith(
      "Legacy DKG drain abort"
    )
    for (const call of [
      () => w.frost.connect(stranger).beginLegacyDkgDrain(),
      () => w.frost.connect(stranger).abortLegacyDkgDrain(RECORD),
      () => w.frost.connect(stranger).completeFrostCutover(MANIFEST),
    ])
      await expect(call()).to.be.revertedWith("Caller is not governance")
    await expect(w.frost.beginLegacyDkgDrain()).to.emit(
      w.frost,
      "LegacyDkgDrainBegun"
    )
    await expect(w.frost.beginLegacyDkgDrain()).to.be.revertedWith(
      "Legacy DKG not open"
    )
    await expect(
      w.frost.abortLegacyDkgDrain(ethers.constants.HashZero)
    ).to.be.revertedWith("Legacy DKG drain abort")
    await expect(w.frost.abortLegacyDkgDrain(RECORD))
      .to.emit(w.frost, "LegacyDkgDrainAborted")
      .withArgs(RECORD)
    expect(await w.frost.frostCreationMode()).to.equal(Mode.LegacyOpen)
    await w.frost.beginLegacyDkgDrain()
    await expect(
      w.frost.completeFrostCutover(ethers.constants.HashZero)
    ).to.be.revertedWith("FROST cutover state")
  })

  it("completes the cutover only with the legacy DKG IDLE and its pool unlocked, once and for good", async () => {
    await w.frost.beginLegacyDkgDrain()
    for (const state of [1, 2, 3]) {
      await w.legacyRegistry.setCreationState(state)
      await expect(w.frost.completeFrostCutover(MANIFEST)).to.be.revertedWith(
        "Legacy DKG not idle"
      )
    }
    await w.legacyRegistry.setCreationState(0)
    await w.legacyRegistry.setPoolLocked(true)
    await expect(w.frost.completeFrostCutover(MANIFEST)).to.be.revertedWith(
      "Legacy sortition pool locked"
    )
    await w.legacyRegistry.setPoolLocked(false)
    await expect(w.frost.completeFrostCutover(MANIFEST))
      .to.emit(w.frost, "FrostCutoverCompleted")
      .withArgs(MANIFEST)
    expect(await w.frost.frostCreationMode()).to.equal(Mode.FrostOnly)
    expect(await w.frost.frostCutoverManifest()).to.equal(MANIFEST)
    await expect(w.frost.completeFrostCutover(TOP_UP)).to.be.revertedWith(
      "FROST cutover state"
    )
    await expect(w.frost.abortLegacyDkgDrain(RECORD)).to.be.revertedWith(
      "Legacy DKG drain abort"
    )
    await expect(w.frost.beginLegacyDkgDrain()).to.be.revertedWith(
      "Legacy DKG not open"
    )
    expect(await w.frost.frostCutoverManifest()).to.equal(MANIFEST)
  })

  it("closes legacy requests at the drain, lets only the DKG in flight finish, once, and refuses registration after the cutover", async () => {
    await w.bridge.requestNewWallet(none)
    expect(await w.legacyRegistry.getWalletCreationState()).to.equal(1)
    await w.frost.beginLegacyDkgDrain()
    await expect(w.bridge.requestNewWallet(none)).to.be.revertedWith(
      "Legacy wallet creation closed"
    )
    // The DKG requested before the drain completes during it, once.
    const pkh = await h.legacyWallet()
    expect(await h.legacyState(pkh)).to.equal(LegacyState.Live)
    // Adversarial review of #14: any later callback (a registry whose owner
    // was swapped to request one) is refused during the drain.
    await expect(h.legacyWallet()).to.be.revertedWith(
      "Legacy wallet creation closed"
    )
    // An abort reopens requests; the next refusal is the legacy condition.
    await w.frost.abortLegacyDkgDrain(RECORD)
    await expect(w.bridge.requestNewWallet(none)).to.be.revertedWith(
      "Wallet creation conditions are not met"
    )
    // Begun with the legacy DKG IDLE: no callback registers at all.
    await w.frost.beginLegacyDkgDrain()
    await expect(h.legacyWallet()).to.be.revertedWith(
      "Legacy wallet creation closed"
    )
    await w.frost.completeFrostCutover(MANIFEST)
    await expect(w.bridge.requestNewWallet(none)).to.be.revertedWith(
      "Legacy wallet creation closed"
    )
    await expect(h.legacyWallet()).to.be.revertedWith(
      "Legacy wallet creation closed"
    )
  })

  it("keeps serving a legacy wallet's moving funds after the cutover", async () => {
    const pkh = await h.legacyWallet()
    await w.frost.beginLegacyDkgDrain()
    await w.frost.completeFrostCutover(MANIFEST)
    const main = await h.legacyMovingFunds(pkh, 400000)
    const { tx } = await h.commitDrain(pkh, main)
    await w.bridge.submitMovingFundsProof(tx.tx, inclusion(tx.hash), main, pkh)
    expect(await h.legacyState(pkh)).to.equal(LegacyState.Closing)
  })

  it("refuses the cutover without a FROST registry", async () => {
    const b = await bareBridge()
    await b.frost.beginLegacyDkgDrain()
    await expect(b.frost.completeFrostCutover(MANIFEST)).to.be.revertedWith(
      "FROST cutover registry"
    )
  })
})
