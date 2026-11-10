/* eslint-disable no-await-in-loop, no-restricted-syntax */
// Mutation batch M1 (tbtc-v2 exposure), 2026-11-10 campaign, MUTATION-REPORT
// sections 1 and 4: the C-10 exposure guards had no fast unit judge. Every
// case here names the guard it holds; each guard has a case that fails at
// its own assertion when the guard is removed or its operator is changed.
//
// Invariants (KC-SF-V3 C-10; FrostExposureController, FrostExposure,
// FrostExposureState):
// - Roles: only governance transfers governance (two steps, nonzero, accepted
//   by the pending address only), sets the guardian, opens a budget period
//   and lifts containment; the guardian or governance contain; only the
//   Bridge moves a counter.
// - Ceilings: a counter may reach a ceiling exactly and never pass it; a
//   ceiling may be set exactly to what is reserved and never below it; a
//   counter may hold the uint64 maximum.
// - Containment refuses only new exposure: a reservation, a deposit
//   reservation, a completion charging more than was reserved, and a reveal.
//   A completion within its reservation still lands.
// - Settlement: a reservation completes once, a zero ID never, and only the
//   excess over the reservation is charged. A release applies only to a
//   reserved custody-only reservation, once.
// - Bridge entrypoints: the controller is installed once, by governance, and
//   only one bound to this Bridge; the creation mode moves LegacyOpen ->
//   LegacyDraining -> FrostOnly under governance, and the cutover needs a
//   FROST registry, an IDLE legacy DKG and an unlocked pool; a deposit is
//   reserved once, only while revealed and unswept, only with its own
//   funding proof, and only while block time plus the margin is strictly
//   before its refund locktime; every selector outside C-10 passes the
//   exposure dispatch untouched.
//
// Real: the Bridge proxy and its FROST libraries, the FrostExposureController,
// the Bank, the FrostVerifier, reveals and reservations through public
// entrypoints.
// FIXTURES: an externally owned account stands in for the Bridge in the
// controller cases (as in Frost.CutoverExposure); the movement world's
// FrostRegistryFixture and FrostDrainRegistryFixture (settable legacy DKG
// state and pool lock); synthetic regtest inclusion proofs; and one storage
// write that clears the installed controller (the only way to reach the
// "not installed" guard on the reveal path, since the funding gates refuse
// to open without a controller and an installed one cannot be removed).
import { ethers, network } from "hardhat"
import { expect } from "chai"
import {
  MAX_UINT64,
  movementWorld,
  transaction,
  inclusion,
  p2tr,
  outpoint,
  deploy,
  World,
  Tx,
} from "../helpers/frost-movement-world"

const ZERO = ethers.constants.HashZero
const RECORD = ethers.utils.id("M1 exposure guard test record")
const TOP_UP = ethers.utils.id("M1 exposure guard test top-up")
const MANIFEST = ethers.utils.id("M1 exposure guard test manifest")
const Mode = { LegacyOpen: 0, LegacyDraining: 1, FrostOnly: 2 }

/// Awaits a step that must succeed: a refusal fails here, at a named
/// assertion, rather than as an uncaught revert.
async function ok<T>(step: Promise<T>, label: string): Promise<T> {
  try {
    return await step
  } catch (error: any) {
    return expect.fail(
      `${label} was refused: ${error?.reason ?? error?.message}`
    )
  }
}

const counters = async (c: any) => ({
  custodyReserved: (await c.custodyReserved()).toString(),
  custodyReleased: (await c.custodyReleased()).toString(),
  custodyAdmitted: (await c.custodyAdmitted()).toString(),
  issuanceReserved: (await c.issuanceReserved()).toString(),
  issued: (await c.issued()).toString(),
  depositsOutstanding: (await c.depositsOutstanding()).toString(),
})

describe("C-10 exposure controller guards (mutation batch M1)", () => {
  let c: any
  let governance: any
  let bridge: any
  let guardian: any
  let stranger: any
  let next: any
  const id = (name: string) => ethers.utils.id(`M1 reservation ${name}`)

  beforeEach(async () => {
    const [g, b, gu, st, n] = await ethers.getSigners()
    governance = g
    bridge = b
    guardian = gu
    stranger = st
    next = n
    // FIXTURE: an externally owned account stands in for the Bridge.
    c = await deploy("FrostExposureController", [
      bridge.address,
      governance.address,
    ])
    c = c.connect(bridge)
  })

  it("refuses a zero Bridge or a zero governance at construction", async () => {
    const factory = await ethers.getContractFactory("FrostExposureController")
    await expect(
      factory.deploy(ethers.constants.AddressZero, governance.address)
    ).to.be.revertedWith("Exposure controller roles")
    await expect(
      factory.deploy(bridge.address, ethers.constants.AddressZero)
    ).to.be.revertedWith("Exposure controller roles")
  })

  it("transfers governance only from governance, only to a nonzero address, and only on acceptance by that address", async () => {
    await expect(
      c.connect(stranger).transferGovernance(stranger.address),
      "a stranger started a governance transfer"
    ).to.be.revertedWith("Caller is not governance")
    expect(await c.pendingGovernance()).to.equal(ethers.constants.AddressZero)
    await expect(
      c.connect(governance).transferGovernance(ethers.constants.AddressZero),
      "a transfer to the zero address was started"
    ).to.be.revertedWith("Exposure controller roles")
    await expect(
      ok(
        c.connect(governance).transferGovernance(next.address),
        "c.connect(governance).transferGovernance(next.address)"
      )
    )
      .to.emit(c, "GovernanceTransferStarted")
      .withArgs(next.address)
    expect(await c.pendingGovernance(), "pending governance").to.equal(
      next.address
    )
    await expect(
      c.connect(stranger).acceptGovernance(),
      "a stranger accepted a transfer pending for another address"
    ).to.be.revertedWith("Caller is not pending")
    expect(await c.governance()).to.equal(governance.address)
    await ok(
      c.connect(next).acceptGovernance(),
      "c.connect(next).acceptGovernance()"
    )
    expect(await c.governance(), "governance after acceptance").to.equal(
      next.address
    )
  })

  it("sets the guardian only from governance", async () => {
    await expect(
      c.connect(stranger).setGuardian(stranger.address),
      "a stranger set the guardian"
    ).to.be.revertedWith("Caller is not governance")
    expect(await c.guardian()).to.equal(ethers.constants.AddressZero)
    await ok(
      c.connect(governance).setGuardian(guardian.address),
      "c.connect(governance).setGuardian(guardian.address)"
    )
    expect(await c.guardian()).to.equal(guardian.address)
  })

  it("opens a budget period only from governance, with a record, and never below what is reserved, while exactly the reserved amount is allowed", async () => {
    await expect(
      c.connect(stranger).openBudgetPeriod(1000, 1000, RECORD),
      "a stranger opened a budget period"
    ).to.be.revertedWith("Caller is not governance")
    expect(await c.period()).to.equal(0)
    await expect(
      c.connect(governance).openBudgetPeriod(1000, 1000, ZERO),
      "a budget period opened without a record"
    ).to.be.revertedWith("Budget period record")
    await ok(
      c.connect(governance).openBudgetPeriod(1000, 1000, RECORD),
      "c.connect(governance).openBudgetPeriod(1000, 1000, RECORD)"
    )
    await ok(c.reserve(id("a"), 300, 200), "c.reserve(id('a'), 300, 200)")
    await expect(
      c.connect(governance).openBudgetPeriod(299, 200, TOP_UP),
      "the custody ceiling fell below the reserved custody"
    ).to.be.revertedWith("Budget below reserved")
    await expect(
      c.connect(governance).openBudgetPeriod(300, 199, TOP_UP),
      "the issuance ceiling fell below the reserved issuance"
    ).to.be.revertedWith("Budget below reserved")
    // Boundary: both ceilings exactly at what is reserved.
    await expect(
      ok(
        c.connect(governance).openBudgetPeriod(300, 200, TOP_UP),
        "c.connect(governance).openBudgetPeriod(300, 200, TOP_UP)"
      )
    )
      .to.emit(c, "BudgetPeriodOpened")
      .withArgs(2, 300, 200, TOP_UP)
    expect(await c.custodyCeiling()).to.equal(300)
    expect(await c.issuanceCeiling()).to.equal(200)
  })

  it("lets the guardian or governance contain, a stranger neither, and only governance lift, with a record", async () => {
    await ok(
      c.connect(governance).setGuardian(guardian.address),
      "c.connect(governance).setGuardian(guardian.address)"
    )
    await expect(
      c.connect(stranger).contain(RECORD),
      "a stranger contained"
    ).to.be.revertedWith("Caller cannot contain")
    expect(await c.contained()).to.equal(false)
    await ok(
      c.connect(guardian).contain(RECORD),
      "c.connect(guardian).contain(RECORD)"
    )
    expect(await c.contained()).to.equal(true)
    for (const who of [guardian, stranger])
      await expect(
        c.connect(who).lift(RECORD),
        "a non-governance caller lifted containment"
      ).to.be.revertedWith("Caller is not governance")
    await expect(
      c.connect(governance).lift(ZERO),
      "containment lifted without a record"
    ).to.be.revertedWith("Lift record")
    expect(await c.contained()).to.equal(true)
    await ok(
      c.connect(governance).lift(RECORD),
      "c.connect(governance).lift(RECORD)"
    )
    expect(await c.contained()).to.equal(false)
    await ok(
      c.connect(governance).contain(RECORD),
      "c.connect(governance).contain(RECORD)"
    )
    expect(await c.contained()).to.equal(true)
  })

  it("moves a counter only for the Bridge", async () => {
    await ok(
      c.connect(governance).openBudgetPeriod(1000, 1000, RECORD),
      "c.connect(governance).openBudgetPeriod(1000, 1000, RECORD)"
    )
    await ok(c.reserve(id("a"), 100, 0), "c.reserve(id('a'), 100, 0)")
    await ok(c.reserveDeposit(50), "c.reserveDeposit(50)")
    const before = await counters(c)
    const calls: [string, (s: any) => Promise<unknown>][] = [
      ["reserve", (s) => c.connect(s).reserve(id("b"), 1, 1)],
      ["reserveDeposit", (s) => c.connect(s).reserveDeposit(1)],
      ["completeDeposits", (s) => c.connect(s).completeDeposits(1, 50, 50, 50)],
      ["completeOne", (s) => c.connect(s).completeOne(id("a"), 100, 0)],
      ["release", (s) => c.connect(s).release(id("a"))],
    ]
    for (const [name, call] of calls)
      for (const who of [governance, stranger])
        await expect(
          call(who),
          `${name} from a non-Bridge caller`
        ).to.be.revertedWith("Caller is not the Bridge")
    expect(await counters(c)).to.deep.equal(before)
    expect((await c.reservations(id("a"))).state).to.equal(1)
  })

  it("refuses a reservation under containment, for the zero ID and for an ID already used", async () => {
    await ok(
      c.connect(governance).openBudgetPeriod(1000, 1000, RECORD),
      "c.connect(governance).openBudgetPeriod(1000, 1000, RECORD)"
    )
    await expect(
      c.reserve(ZERO, 1, 1),
      "the zero ID was reserved"
    ).to.be.revertedWith("Exposure reserved")
    await ok(c.reserve(id("a"), 10, 10), "c.reserve(id('a'), 10, 10)")
    await expect(
      c.reserve(id("a"), 1, 1),
      "an ID was reserved twice"
    ).to.be.revertedWith("Exposure reserved")
    await ok(
      c.connect(governance).contain(RECORD),
      "c.connect(governance).contain(RECORD)"
    )
    await expect(
      c.reserve(id("b"), 1, 1),
      "a reservation was admitted under containment"
    ).to.be.revertedWith("FROST exposure contained")
    await expect(
      c.reserveDeposit(1),
      "a deposit reservation was admitted under containment"
    ).to.be.revertedWith("FROST exposure contained")
    expect(await counters(c)).to.deep.equal({
      custodyReserved: "10",
      custodyReleased: "0",
      custodyAdmitted: "0",
      issuanceReserved: "10",
      issued: "0",
      depositsOutstanding: "0",
    })
  })

  it("admits each ceiling exactly and refuses one unit more", async () => {
    await ok(
      c.connect(governance).openBudgetPeriod(1000, 600, RECORD),
      "c.connect(governance).openBudgetPeriod(1000, 600, RECORD)"
    )
    await expect(
      c.reserve(id("over-custody"), 1001, 0),
      "custody one over the ceiling"
    ).to.be.revertedWith("FROST custody budget")
    await expect(
      c.reserve(id("over-issuance"), 0, 601),
      "issuance one over the ceiling"
    ).to.be.revertedWith("FROST issuance budget")
    // Boundary: both counters land exactly on their ceilings.
    await ok(
      c.reserve(id("exact"), 1000, 600),
      "c.reserve(id('exact'), 1000, 600)"
    )
    expect(await c.remainingCustody()).to.equal(0)
    expect(await c.remainingIssuance()).to.equal(0)
    await expect(c.reserve(id("one-custody"), 1, 0)).to.be.revertedWith(
      "FROST custody budget"
    )
    await expect(c.reserve(id("one-issuance"), 0, 1)).to.be.revertedWith(
      "FROST issuance budget"
    )
    expect(await c.custodyReserved()).to.equal(1000)
    expect(await c.issuanceReserved()).to.equal(600)
  })

  it("holds a counter at exactly the uint64 maximum", async () => {
    await ok(
      c.connect(governance).openBudgetPeriod(MAX_UINT64, MAX_UINT64, RECORD),
      "c.connect(governance).openBudgetPeriod(MAX_UINT64, MAX_UINT64, RECORD)"
    )
    await ok(c.reserveDeposit(MAX_UINT64), "c.reserveDeposit(MAX_UINT64)")
    expect(await c.depositsOutstanding()).to.equal(MAX_UINT64)
    expect(await c.custodyReserved()).to.equal(MAX_UINT64)
    await ok(
      c.completeDeposits(1, MAX_UINT64, MAX_UINT64, MAX_UINT64),
      "c.completeDeposits(1, MAX_UINT64, MAX_UINT64, MAX_UINT64)"
    )
    expect(await c.custodyAdmitted()).to.equal(MAX_UINT64)
    expect(await c.issued()).to.equal(MAX_UINT64)
  })

  it("releases only a reserved custody-only reservation, and only once", async () => {
    await ok(
      c.connect(governance).openBudgetPeriod(1000, 1000, RECORD),
      "c.connect(governance).openBudgetPeriod(1000, 1000, RECORD)"
    )
    await expect(
      c.release(id("unknown")),
      "an unreserved ID was released"
    ).to.be.revertedWith("Exposure not reserved")
    await ok(c.reserve(id("x"), 400, 0), "c.reserve(id('x'), 400, 0)")
    await expect(ok(c.release(id("x")), "c.release(id('x'))"))
      .to.emit(c, "ExposureReleased")
      .withArgs(id("x"), 400)
    expect(await c.custodyReleased()).to.equal(400)
    await expect(
      c.release(id("x")),
      "a reservation was released twice"
    ).to.be.revertedWith("Exposure not reserved")
    await ok(c.reserve(id("y"), 10, 10), "c.reserve(id('y'), 10, 10)")
    await expect(
      c.release(id("y")),
      "a reservation with issuance was released"
    ).to.be.revertedWith("Issuance never releases")
    expect(await c.custodyReleased()).to.equal(400)
    expect((await c.reservations(id("y"))).state).to.equal(1)
  })

  it("settles a reservation once, never the zero ID, and charges only the excess over the reservation", async () => {
    await ok(
      c.connect(governance).openBudgetPeriod(1000, 1000, RECORD),
      "c.connect(governance).openBudgetPeriod(1000, 1000, RECORD)"
    )
    await expect(
      c.completeOne(ZERO, 1, 1),
      "the zero ID was completed"
    ).to.be.revertedWith("Exposure settled")
    await ok(c.reserve(id("a"), 100, 100), "c.reserve(id('a'), 100, 100)")
    await ok(
      c.completeOne(id("a"), 150, 130),
      "c.completeOne(id('a'), 150, 130)"
    )
    expect(await c.custodyReserved(), "custody charged for 50 excess").to.equal(
      150
    )
    expect(
      await c.issuanceReserved(),
      "issuance charged for 30 excess"
    ).to.equal(130)
    await expect(
      c.completeOne(id("a"), 1, 1),
      "a reservation completed twice"
    ).to.be.revertedWith("Exposure settled")
    expect(await counters(c)).to.deep.equal({
      custodyReserved: "150",
      custodyReleased: "0",
      custodyAdmitted: "150",
      issuanceReserved: "130",
      issued: "130",
      depositsOutstanding: "0",
    })
  })

  it("under containment completes work within its reservation and refuses any excess charge; uncontained, it charges the custody excess alone", async () => {
    await ok(
      c.connect(governance).openBudgetPeriod(1000, 1000, RECORD),
      "c.connect(governance).openBudgetPeriod(1000, 1000, RECORD)"
    )
    await ok(c.reserve(id("a"), 100, 100), "c.reserve(id('a'), 100, 100)")
    await ok(c.reserveDeposit(50), "c.reserveDeposit(50)")
    await ok(
      c.connect(governance).contain(RECORD),
      "c.connect(governance).contain(RECORD)"
    )
    // No excess: lands under containment and charges nothing.
    await ok(
      c.completeOne(id("a"), 100, 100),
      "c.completeOne(id('a'), 100, 100)"
    )
    await ok(
      c.completeDeposits(1, 50, 50, 50),
      "c.completeDeposits(1, 50, 50, 50)"
    )
    expect(await c.custodyReserved()).to.equal(150)
    expect(await c.issuanceReserved()).to.equal(150)
    await expect(
      c.completeOne(id("b"), 1, 0),
      "an unreserved custody charge landed under containment"
    ).to.be.revertedWith("FROST exposure contained")
    await expect(
      c.completeOne(id("c"), 0, 1),
      "an unreserved issuance charge landed under containment"
    ).to.be.revertedWith("FROST exposure contained")
    await ok(
      c.connect(governance).lift(RECORD),
      "c.connect(governance).lift(RECORD)"
    )
    // Custody excess with no issuance excess is still charged.
    await ok(c.completeOne(id("d"), 10, 0), "c.completeOne(id('d'), 10, 0)")
    expect(await c.custodyReserved(), "custody-only excess").to.equal(160)
    expect(await c.issuanceReserved()).to.equal(150)
    await ok(c.reserveDeposit(20), "c.reserveDeposit(20)")
    await ok(
      c.completeDeposits(1, 20, 25, 20),
      "c.completeDeposits(1, 20, 25, 20)"
    )
    expect(
      await c.custodyReserved(),
      "custody-only excess over a deposit"
    ).to.equal(185)
    expect(await c.issuanceReserved()).to.equal(170)
    await ok(c.completeOne(id("e"), 0, 7), "c.completeOne(id('e'), 0, 7)")
    expect(await c.issuanceReserved(), "issuance-only excess").to.equal(177)
  })
})

describe("C-10 exposure Bridge guards (mutation batch M1)", () => {
  let w: World
  let stranger: any
  let snapshot: string

  const keyOf = (funding: Tx) => outpoint(funding.hash, 0)
  const reserve = (funding: Tx, overrides: any = {}) =>
    w.frost.reserveFrostDeposit(
      keyOf(funding),
      funding.tx,
      inclusion(funding.hash),
      overrides
    )

  before(async () => {
    w = await movementWorld(1)
    const [, , , , , , s] = w.signers
    stranger = s
    snapshot = await network.provider.send("evm_snapshot")
  })
  beforeEach(async () => {
    expect(await network.provider.send("evm_revert", [snapshot])).to.equal(true)
    snapshot = await network.provider.send("evm_snapshot")
  })

  it("routes every C-10 selector to the exposure dispatch and every other selector past it", async () => {
    // A lifecycle view behind the exposure dispatch must still answer.
    expect(
      await ok(
        w.frost.connect(stranger).frostInactivityNonce(w.wallets[0].id),
        "w.frost.connect(stranger).frostInactivityNonce(w.wallets[0].id)"
      )
    ).to.equal(0)
    expect(await w.frost.frostCreationMode()).to.equal(Mode.LegacyOpen)
    await expect(
      ok(w.frost.beginLegacyDkgDrain(), "w.frost.beginLegacyDkgDrain()")
    ).to.emit(w.frost, "LegacyDkgDrainBegun")
    expect(await w.frost.frostCreationMode()).to.equal(Mode.LegacyDraining)
    await expect(
      ok(
        w.frost.abortLegacyDkgDrain(RECORD),
        "w.frost.abortLegacyDkgDrain(RECORD)"
      )
    )
      .to.emit(w.frost, "LegacyDkgDrainAborted")
      .withArgs(RECORD)
    expect(await w.frost.frostCreationMode()).to.equal(Mode.LegacyOpen)
    await ok(w.frost.beginLegacyDkgDrain(), "w.frost.beginLegacyDkgDrain()")
    await expect(
      ok(
        w.frost.completeFrostCutover(MANIFEST),
        "w.frost.completeFrostCutover(MANIFEST)"
      )
    )
      .to.emit(w.frost, "FrostCutoverCompleted")
      .withArgs(MANIFEST)
    expect(await w.frost.frostCreationMode()).to.equal(Mode.FrostOnly)
    expect(await w.frost.frostCutoverManifest()).to.equal(MANIFEST)
  })

  it("lets only governance change the creation mode or the reservation margin", async () => {
    for (const [name, call] of [
      ["begin", () => w.frost.connect(stranger).beginLegacyDkgDrain()],
      [
        "margin",
        () => w.frost.connect(stranger).setFrostDepositReservationMargin(1),
      ],
    ] as [string, () => Promise<unknown>][])
      await expect(call(), `${name} from a stranger`).to.be.revertedWith(
        "Caller is not governance"
      )
    expect(await w.frost.frostCreationMode()).to.equal(Mode.LegacyOpen)
    expect(await w.frost.frostDepositReservationMargin()).to.equal(0)
    await ok(w.frost.beginLegacyDkgDrain(), "w.frost.beginLegacyDkgDrain()")
    for (const [name, call] of [
      ["abort", () => w.frost.connect(stranger).abortLegacyDkgDrain(RECORD)],
      [
        "cutover",
        () => w.frost.connect(stranger).completeFrostCutover(MANIFEST),
      ],
    ] as [string, () => Promise<unknown>][])
      await expect(call(), `${name} from a stranger`).to.be.revertedWith(
        "Caller is not governance"
      )
    expect(await w.frost.frostCreationMode()).to.equal(Mode.LegacyDraining)
  })

  it("moves the creation mode only forward from the right state, and cuts over only with the legacy DKG IDLE and its pool unlocked", async () => {
    await expect(
      w.frost.completeFrostCutover(MANIFEST),
      "cutover from LegacyOpen"
    ).to.be.revertedWith("FROST cutover state")
    await expect(
      w.frost.abortLegacyDkgDrain(RECORD),
      "abort from LegacyOpen"
    ).to.be.revertedWith("Legacy DKG drain abort")
    expect(await w.frost.frostCreationMode()).to.equal(Mode.LegacyOpen)
    await ok(w.frost.beginLegacyDkgDrain(), "w.frost.beginLegacyDkgDrain()")
    await expect(
      w.frost.beginLegacyDkgDrain(),
      "a second drain begun"
    ).to.be.revertedWith("Legacy DKG not open")
    await expect(
      w.frost.abortLegacyDkgDrain(ZERO),
      "abort without a policy record"
    ).to.be.revertedWith("Legacy DKG drain abort")
    await expect(
      w.frost.completeFrostCutover(ZERO),
      "cutover without a manifest"
    ).to.be.revertedWith("FROST cutover state")
    for (const state of [1, 2, 3]) {
      await ok(
        w.legacyRegistry.setCreationState(state),
        "w.legacyRegistry.setCreationState(state)"
      )
      await expect(
        w.frost.completeFrostCutover(MANIFEST),
        `cutover with the legacy DKG in state ${state}`
      ).to.be.revertedWith("Legacy DKG not idle")
    }
    await ok(
      w.legacyRegistry.setCreationState(0),
      "w.legacyRegistry.setCreationState(0)"
    )
    await ok(
      w.legacyRegistry.setPoolLocked(true),
      "w.legacyRegistry.setPoolLocked(true)"
    )
    await expect(
      w.frost.completeFrostCutover(MANIFEST),
      "cutover with the legacy pool locked"
    ).to.be.revertedWith("Legacy sortition pool locked")
    expect(await w.frost.frostCreationMode()).to.equal(Mode.LegacyDraining)
    expect(await w.frost.frostCutoverManifest()).to.equal(ZERO)
    await ok(
      w.legacyRegistry.setPoolLocked(false),
      "w.legacyRegistry.setPoolLocked(false)"
    )
    await ok(
      w.frost.completeFrostCutover(MANIFEST),
      "w.frost.completeFrostCutover(MANIFEST)"
    )
    expect(await w.frost.frostCreationMode()).to.equal(Mode.FrostOnly)
  })

  it("reserves a deposit once, only while it is revealed and unswept, and only with its own funding proof", async () => {
    const [x] = w.wallets
    const funding = await ok(w.reveal(x, 50000), "w.reveal(x, 50000)")
    const unknown = transaction(
      [[ethers.utils.id("M1 never revealed"), 0]],
      [{ value: 50000, script: p2tr(x.q) }]
    )
    await expect(
      w.frost.reserveFrostDeposit(
        keyOf(unknown),
        unknown.tx,
        inclusion(unknown.hash)
      ),
      "an unrevealed outpoint was reserved"
    ).to.be.revertedWith("FROST deposit not pending")
    const forged = transaction(
      [[ethers.utils.id("M1 another funding"), 0]],
      [{ value: 50000, script: p2tr(x.q) }]
    )
    await expect(
      w.frost.reserveFrostDeposit(
        keyOf(funding),
        forged.tx,
        inclusion(forged.hash)
      ),
      "a deposit was reserved with another transaction's proof"
    ).to.be.revertedWith("FROST funding proof")
    expect(await w.exposure.depositsOutstanding()).to.equal(0)
    await expect(ok(reserve(funding), "reserve(funding)"))
      .to.emit(w.frost, "FrostDepositReserved")
      .withArgs(keyOf(funding), 50000)
    expect(await w.frost.frostDepositReserved(keyOf(funding))).to.equal(true)
    expect(await w.exposure.depositsOutstanding()).to.equal(50000)
    await expect(
      reserve(funding),
      "a deposit was reserved twice"
    ).to.be.revertedWith("FROST deposit reserved")
    expect(await w.exposure.depositsOutstanding()).to.equal(50000)
  })

  it("reserves a deposit only while block time plus the margin is strictly before its refund locktime", async () => {
    const [x] = w.wallets
    const MARGIN = 3600
    await ok(
      w.frost.setFrostDepositReservationMargin(MARGIN),
      "w.frost.setFrostDepositReservationMargin(MARGIN)"
    )
    const funding = await ok(
      w.reveal(x, 50000, 7200),
      "w.reveal(x, 50000, 7200)"
    )
    const locktime = (await w.deposit(keyOf(funding))).terms.refundLocktime
    const boundary = Number(locktime) - MARGIN
    // An explicit gas limit sends the transaction, so it is mined at the
    // timestamp set for it rather than estimated against another block.
    const gasLimit = 3000000
    const s = await network.provider.send("evm_snapshot")
    await network.provider.send("evm_setNextBlockTimestamp", [boundary])
    await expect(
      reserve(funding, { gasLimit }),
      "reserved with block time + margin equal to the refund locktime"
    ).to.be.revertedWith("FROST deposit refund window")
    expect(await network.provider.send("evm_revert", [s])).to.equal(true)
    await network.provider.send("evm_setNextBlockTimestamp", [boundary - 1])
    await ok(reserve(funding, { gasLimit }), "reserve(funding, { gasLimit })")
    expect(await w.exposure.depositsOutstanding()).to.equal(50000)
    // Past the locktime the refund leaf is open: refused with no margin too.
    await ok(
      w.frost.setFrostDepositReservationMargin(0),
      "w.frost.setFrostDepositReservationMargin(0)"
    )
    const late = await ok(w.reveal(x, 40000, 600), "w.reveal(x, 40000, 600)")
    await network.provider.send("evm_increaseTime", [86400])
    await network.provider.send("evm_mine")
    await expect(
      reserve(late, { gasLimit }),
      "reserved after the refund locktime"
    ).to.be.revertedWith("FROST deposit refund window")
    expect(await w.exposure.depositsOutstanding()).to.equal(50000)
  })

  it("refuses a reveal under containment and admits it once lifted", async () => {
    const [x] = w.wallets
    await ok(w.exposure.contain(RECORD), "w.exposure.contain(RECORD)")
    await expect(
      w.reveal(x, 50000),
      "a deposit was revealed under containment"
    ).to.be.revertedWith("FROST exposure contained")
    await ok(w.exposure.lift(RECORD), "w.exposure.lift(RECORD)")
    await ok(w.reveal(x, 50000), "w.reveal(x, 50000)")
  })

  it("refuses a reveal when no controller is installed", async () => {
    const [x] = w.wallets
    // FIXTURE: clear the installed controller in Bridge storage. Public
    // entrypoints cannot reach this state (see the file header).
    await w.writeField(
      w.child(w.child(w.self, "frostExposure"), "controller"),
      0
    )
    expect(await w.frost.frostExposureController()).to.equal(
      ethers.constants.AddressZero
    )
    await expect(
      w.reveal(x, 50000),
      "a deposit was revealed with no controller"
    ).to.be.revertedWith("FROST exposure not installed")
  })
})

describe("C-10 exposure installation guards (mutation batch M1)", () => {
  /// A Bridge proxy with no FROST registry and no exposure controller, as in
  /// Frost.CutoverExposure's bareBridge.
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
      frost: await ethers.getContractAt("IFrostBridge", proxy.address),
    }
  }

  let b: Awaited<ReturnType<typeof bareBridge>>
  let snapshot: string
  before(async () => {
    b = await bareBridge()
    snapshot = await network.provider.send("evm_snapshot")
  })
  beforeEach(async () => {
    expect(await network.provider.send("evm_revert", [snapshot])).to.equal(true)
    snapshot = await network.provider.send("evm_snapshot")
  })

  it("installs only a contract bound to this Bridge, only from governance, and only once", async () => {
    const [, stranger] = await ethers.getSigners()
    await expect(
      b.frost.installFrostExposureController(stranger.address),
      "an account without code was installed"
    ).to.be.revertedWith("FROST exposure controller")
    const other = await deploy("FrostExposureController", [
      stranger.address,
      b.owner.address,
    ])
    await expect(
      b.frost.installFrostExposureController(other.address),
      "a controller bound to another Bridge was installed"
    ).to.be.revertedWith("FROST exposure controller")
    const controller = await deploy("FrostExposureController", [
      b.proxy.address,
      b.owner.address,
    ])
    await expect(
      b.frost
        .connect(stranger)
        .installFrostExposureController(controller.address),
      "a stranger installed the controller"
    ).to.be.revertedWith("Caller is not governance")
    expect(await b.frost.frostExposureController()).to.equal(
      ethers.constants.AddressZero
    )
    await ok(
      b.frost.installFrostExposureController(controller.address),
      "b.frost.installFrostExposureController(controller.address)"
    )
    expect(await b.frost.frostExposureController()).to.equal(controller.address)
    const second = await deploy("FrostExposureController", [
      b.proxy.address,
      b.owner.address,
    ])
    await expect(
      b.frost.installFrostExposureController(second.address),
      "a second controller replaced the first"
    ).to.be.revertedWith("FROST exposure installed")
    expect(await b.frost.frostExposureController()).to.equal(controller.address)
  })

  it("refuses the cutover without a FROST registry", async () => {
    await ok(b.frost.beginLegacyDkgDrain(), "b.frost.beginLegacyDkgDrain()")
    await expect(
      b.frost.completeFrostCutover(MANIFEST),
      "cutover with no FROST registry"
    ).to.be.revertedWith("FROST cutover registry")
  })
})
