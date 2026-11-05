/* eslint-disable no-await-in-loop, no-restricted-syntax */
// Refs RebateStaking policy gap (K-09-restart/ADV-contracts.md, Notes (P3);
// review recheck N10); DECISIONS.md D20 (tux, 2026-11-05: option (b)).
// Decision: FROST deposit reveals require RebateStaking unset. Governance
// gets a setter that accepts 0x0, so it can unset RebateStaking on a Bridge
// where RebateStaking is set and reinitializer(5) is already spent (the
// TIP-109 path, deploy script 85). FROST gets no rebate support. Unsetting
// ends rebates for everyone.
//
// Interface the implementer must provide (TESTS-BATCH8.md, "D20 interface"):
// `BridgeGovernance.setRebateStaking(address(0))`, called by the
// BridgeGovernance owner, unsets RebateStaking on a Bridge where it is set.
// The existing setter keeps its other rules (Bridge.Parameters pins "Rebate
// staking already set" for a nonzero address over a set one, and "must not
// be 0x0" while unset). No revert string on the Bridge is required here:
// the refusals below only require a revert and unchanged state.
//
// Invariants:
// - UNSET: on an upgraded Bridge whose governance is BridgeGovernance, with
//   RebateStaking set and reinitializer(5) spent (the TIP-109 sequence:
//   stale pointer, `initializeV5_RepairRebateStaking(0)` by `upgradeAndCall`,
//   `setRebateStaking` again), the BridgeGovernance owner unsets
//   RebateStaking, and a FROST reveal that was refused before then emits
//   `FrostDepositRevealed`.
// - GOVERNANCE ONLY: nobody else can unset it: not a third party through
//   BridgeGovernance, and not anyone calling the Bridge directly (the
//   BridgeGovernance owner and a third party). After each attempt
//   RebateStaking is unchanged and FROST reveals are still refused.
// - NO REBATE AFTER UNSET: after unsetting, a legacy reveal by a staker
//   creates no rebate entry and charges the full treasury fee, exactly as
//   the same reveal on the same upgraded Bridge with RebateStaking never set
//   (a witness taken inside a reverted EVM snapshot).
//
// The set/refused, legacy-witness and never-set cases stay in
// B8.RebateStakingPrecondition.test.ts.
import { ethers } from "hardhat"
import { expect } from "chai"
import { b8World, B8World, REBATE_DEPOSIT, reason } from "../helpers/b8-world"
import { deploy } from "../helpers/frost-movement-world"

const REASON = "FROST rebate unsupported"
const ZERO_ADDRESS = ethers.constants.AddressZero

describe("B8 RebateStaking D20: governance unsets RebateStaking on a TIP-109 Bridge", () => {
  let w: B8World
  beforeEach(async function setup() {
    this.timeout(180000)
    w = await b8World()
  })

  /// The mainnet shape after TIP-109 (deploy script 85): the Bridge's
  /// governance is a BridgeGovernance owned by `owner`; RebateStaking was
  /// set, cleared by `initializeV5_RepairRebateStaking(0)` in an
  /// `upgradeAndCall`, and set again through BridgeGovernance. Returns the
  /// BridgeGovernance.
  const tip109 = async () => {
    const bg = await deploy("BridgeGovernance", [w.proxy.address, 60])
    await w.bridge.connect(w.owner).transferGovernance(bg.address)
    // The stale pointer TIP-109 repaired.
    await bg.connect(w.owner).setRebateStaking(w.rebate.address)
    await w.admin.upgradeAndCall(
      w.proxy.address,
      w.implementation.address,
      w.bridge.interface.encodeFunctionData(
        "initializeV5_RepairRebateStaking",
        [ZERO_ADDRESS]
      )
    )
    expect(await w.bridge.getRebateStaking()).to.equal(ZERO_ADDRESS)
    await bg.connect(w.owner).setRebateStaking(w.rebate.address)
    // Preconditions of the decision's case.
    expect(
      await w.bridge.getRebateStaking(),
      "TIP-109 setup: RebateStaking set"
    ).to.equal(w.rebate.address)
    await expect(
      w.bridge.connect(w.keeper).initializeV5_RepairRebateStaking(ZERO_ADDRESS),
      "TIP-109 setup: reinitializer(5) spent"
    ).to.be.revertedWith("Initializable: contract is already initialized")
    expect(await bg.owner(), "TIP-109 setup: BridgeGovernance owner").to.equal(
      w.owner.address
    )
    return bg
  }

  /// The decided unset: the BridgeGovernance owner sets 0x0.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unset = async (bg: any) => {
    let refused = ""
    try {
      await (await bg.connect(w.owner).setRebateStaking(ZERO_ADDRESS)).wait()
    } catch (e) {
      refused = reason(e)
    }
    expect(
      refused,
      "D20: governance could not unset RebateStaking on a Bridge where it is set and reinitializer(5) is spent"
    ).to.equal("")
  }

  it("[RebateStaking D20] unset: governance unsets RebateStaking and a FROST reveal then works", async () => {
    const bg = await tip109()
    const [x] = w.pool
    const { t, fundingTx } = await w.revealFrost(x, 200000)
    await expect(
      w.frost.connect(w.alias).revealFrostDeposit(t, fundingTx.tx, 0),
      "D20: a FROST reveal with RebateStaking set was not refused"
    ).to.be.revertedWith(REASON)

    await unset(bg)
    expect(
      await w.bridge.getRebateStaking(),
      "D20: RebateStaking is still set after governance unset it"
    ).to.equal(ZERO_ADDRESS)

    const admission = await ethers.getContractAt(
      "FrostDepositAdmission",
      w.proxy.address
    )
    await expect(
      w.frost.connect(w.alias).revealFrostDeposit(t, fundingTx.tx, 0),
      "D20: a FROST reveal after governance unset RebateStaking was refused"
    ).to.emit(admission, "FrostDepositRevealed")
  })

  it("[RebateStaking D20] governance only: no other caller can unset RebateStaking", async () => {
    const bg = await tip109()
    const attempts: [string, () => Promise<unknown>][] = [
      [
        "a third party through BridgeGovernance",
        () => bg.connect(w.keeper).setRebateStaking(ZERO_ADDRESS),
      ],
      [
        "the BridgeGovernance owner calling the Bridge directly",
        () => w.bridge.connect(w.owner).setRebateStaking(ZERO_ADDRESS),
      ],
      [
        "a third party calling the Bridge directly",
        () => w.bridge.connect(w.keeper).setRebateStaking(ZERO_ADDRESS),
      ],
    ]
    for (const [who, call] of attempts) {
      let unset = true
      try {
        await call()
      } catch (e) {
        unset = false
      }
      expect(
        unset === false &&
          (await w.bridge.getRebateStaking()) === w.rebate.address,
        `D20: ${who} unset RebateStaking without governance`
      ).to.equal(true)
    }
    // Still refused for FROST after every attempt.
    const [x] = w.pool
    const { t, fundingTx } = await w.revealFrost(x, 200000)
    await expect(
      w.frost.connect(w.alias).revealFrostDeposit(t, fundingTx.tx, 0),
      "D20: a FROST reveal was admitted after refused unset attempts"
    ).to.be.revertedWith(REASON)
  })

  it("[RebateStaking D20] no rebate after unset: a legacy reveal charges no rebate, as on a never-set Bridge", async () => {
    // Never-set witness on the same upgraded Bridge, undone afterwards.
    const snapshot = await ethers.provider.send("evm_snapshot", [])
    expect(await w.bridge.getRebateStaking()).to.equal(ZERO_ADDRESS)
    await w.stakeRebater()
    const neverSet = await w.rebateRecord(
      w.bridge,
      await w.legacyRebateReveal(w.bridge)
    )
    expect(await ethers.provider.send("evm_revert", [snapshot])).to.equal(true)
    // The witness itself: the full fee and no rebate entry (the available
    // rebate is the stake's cap, untouched).
    expect(neverSet.treasuryFee).to.equal(String(REBATE_DEPOSIT / 100))
    expect(neverSet.rebates).to.deep.equal([])

    const bg = await tip109()
    await w.stakeRebater()
    await unset(bg)
    const key = await w.legacyRebateReveal(w.bridge)
    expect(
      await w.rebateRecord(w.bridge, key),
      "D20: after unsetting RebateStaking a legacy reveal differs from a never-set Bridge (rebate charged)"
    ).to.deep.equal(neverSet)
  })
})
