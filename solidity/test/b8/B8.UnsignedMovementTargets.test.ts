/* eslint-disable no-await-in-loop, no-restricted-syntax, no-bitwise */
// Refs ADV-C2 (K-09-restart/ADV-contracts.md: a commitment that is never
// signed blocks every target from moving, closing or resetting; probe
// ADV.UnsignedDrainTargets on adv/contracts-probes ee1b00cb).
// Decision (tux, 2026-11-04, DECISIONS.md): obligations from a
// committed-but-unproven movement block only the target's closure, not its
// own commitment, movement or timeout reset.
//
// Invariants (each case names the one it checks):
// - OWN MOVE: a FROST target T with an open inbound obligation from a source
//   that committed and never signed (legacy drain or FROST source) can
//   commit its own movement and prove it.
// - NO SANCTION: T is not escalated or sanctioned for the source's failure:
//   no FrostSanctionNotified/FrostMovingFundsEscalated names T.
// - RESET: with no eligible target, T can reset its own moving-funds timeout.
// - CLOSURE: T's closure is still refused ("FROST closure obligations", bit
//   4 of frostClosureObligations) while the obligation stands; the
//   obligation is not released by T's own movement.
//
// Scenario (the probe's, in the real K-09 world): legacy source S, from
// 40a11d1d and the real registry DKG, commits a drain to T and one more
// target; its group never signs; S times out through the real registry.
// T, funded by a real FROST reveal and sweep, later enters MovingFunds
// through the real age rule.
import { ethers } from "hardhat"
import { expect } from "chai"
import {
  b8World,
  B8World,
  FrostWallet,
  GAS_CAP,
  ascending,
  ageOut,
  increaseTime,
  movementTx,
  requireTargets,
  reason,
  deepInclusion,
  LegacyState,
} from "../helpers/b8-world"

const TIMEOUT = 7 * 86400 // movingFundsTimeout in the K-09 world
const CLOSING = 7 * 86400 // walletClosingPeriod in the K-09 world

describe("B8 ADV-C2: an unsigned movement does not strand its FROST targets", () => {
  let w: B8World
  let T: FrostWallet
  let other: FrostWallet // the source's second target
  let next: FrostWallet // T's own target
  let fromBlock: number

  beforeEach(async function setup() {
    this.timeout(180000)
    w = await b8World()
    ;[T, other, next] = ascending(w.pool)
    await w.fundFrost(T, 301000) // custody 300,000 before the drain
    fromBlock = await ethers.provider.getBlockNumber()
  })

  /// S commits a drain to [T, other] and never signs; S times out.
  const legacySourceFails = async () => {
    await requireTargets(w, w.S.main.txOutputValue, 2)
    await w.bridge
      .connect(w.S.signers[0])
      .submitMovingFundsCommitment(w.S.pkh, w.S.main, w.S.members, 1, [
        T.label,
        other.label,
      ])
    await increaseTime(TIMEOUT + 1)
    await w.bridge.notifyMovingFundsTimeout(w.S.pkh, w.S.members)
    expect((await w.bridge.wallets(w.S.pkh)).state).to.equal(
      LegacyState.Terminated
    )
    // The drain can never be proven or released: no Bitcoin evidence.
    expect(await w.frost.frostDrainTargets(w.S.pkh)).to.deep.equal([
      T.label,
      other.label,
    ])
  }

  /// FROST source F commits a movement to [T] and never signs; F escalates.
  const frostSourceFails = async () => {
    await ageOut(w)
    await w.lifecycle.notifyFrostWalletCloseable(w.F.id)
    await requireTargets(w, w.F.value, 1)
    await w.frost
      .connect(w.keeper)
      .submitFrostMovingFundsCommitment(w.F.id, 0, [T.label])
    await increaseTime(TIMEOUT + 1)
    await w.frost.notifyFrostMovingFundsTimeout(w.F.id)
  }

  /// T enters MovingFunds through the real age rule, with the obligation.
  const targetMustMove = async () => {
    await ageOut(w)
    await w.lifecycle.notifyFrostWalletCloseable(T.id)
    expect(
      (await w.frost.frostMovementCounters(T.id)).inboundCommitments,
      "scenario: T carries the unsigned source's obligation"
    ).to.equal(1)
  }

  /// No sanction or escalation names T since the case began.
  const notSanctioned = async () => {
    const sanctions = await w.frost.queryFilter(
      w.frost.filters.FrostSanctionNotified(T.id),
      fromBlock
    )
    const escalations = await w.frost.queryFilter(
      w.frost.filters.FrostMovingFundsEscalated(T.id),
      fromBlock
    )
    expect(
      sanctions.length + escalations.length,
      "ADV-C2: T was sanctioned or escalated for the source's failure"
    ).to.equal(0)
  }

  /// T commits and proves its own movement to `next`.
  const ownMove = async () => {
    await requireTargets(w, T.value, 1)
    try {
      await (
        await w.frost
          .connect(w.keeper)
          .submitFrostMovingFundsCommitment(T.id, 0, [next.label], {
            gasLimit: GAS_CAP,
          })
      ).wait()
    } catch (error) {
      expect.fail(
        `ADV-C2: a target with an unsigned inbound movement cannot commit its own movement: ${reason(
          error
        )}`
      )
    }
    const main = T.main as { hash: string }
    const tx = movementTx(main.hash, T.value, [next])
    try {
      await (
        await w.frost
          .connect(w.maintainer)
          .submitFrostMovingFundsProof(T.id, tx.tx, deepInclusion(tx.hash), {
            gasLimit: GAS_CAP,
          })
      ).wait()
    } catch (error) {
      expect.fail(
        `ADV-C2: a target with an unsigned inbound movement cannot prove its own movement: ${reason(
          error
        )}`
      )
    }
    expect(
      (await w.frost.frostWalletLifecycle(T.id)).closingStartedAt.toNumber(),
      "ADV-C2: T's own movement did not take it to Closing"
    ).to.be.greaterThan(0)
  }

  /// Past its closing period T still cannot close: bit 4 stands.
  const closureRefused = async () => {
    expect(
      (await w.frost.frostMovementCounters(T.id)).inboundCommitments,
      "ADV-C2: T's own movement released the source's obligation"
    ).to.equal(1)
    await increaseTime(CLOSING + 1)
    expect(
      (await w.lifecycle.frostClosureObligations(T.id)).toNumber() & 4,
      "ADV-C2: closure obligations do not name the inbound commitment"
    ).to.equal(4)
    await expect(
      w.lifecycle.finalizeFrostWalletClosing(T.id),
      "ADV-C2: T closed while the inbound obligation stands"
    ).to.be.revertedWith("FROST closure obligations")
  }

  it("[ADV-C2] legacy drain never signed: T commits and proves its own movement, is not sanctioned, and cannot close", async function legacy() {
    this.timeout(60000)
    await legacySourceFails()
    await targetMustMove()
    await ownMove()
    // T's own moving-funds timeout passes; its movement is proven.
    await increaseTime(TIMEOUT + 1)
    await expect(w.frost.notifyFrostMovingFundsTimeout(T.id)).to.be.reverted
    await notSanctioned()
    await closureRefused()
  })

  it("[ADV-C2] FROST source never signed: T commits and proves its own movement, is not sanctioned, and cannot close", async function frost() {
    this.timeout(60000)
    await frostSourceFails()
    await targetMustMove()
    await ownMove()
    await increaseTime(TIMEOUT + 1)
    await expect(w.frost.notifyFrostMovingFundsTimeout(T.id)).to.be.reverted
    await notSanctioned()
    await closureRefused()
  })

  it("[ADV-C2] legacy drain never signed: with no eligible target, T resets its own moving-funds timeout", async function reset() {
    this.timeout(60000)
    await legacySourceFails()
    await targetMustMove()
    // Every other FROST wallet leaves eligibility through the real age rule.
    // A wallet already in MovingFunds (the case's own setup) refuses; that
    // refusal is expected and the counter check below is the assertion.
    for (const x of w.wallets)
      if (x.id !== T.id)
        await w.lifecycle.notifyFrostWalletCloseable(x.id).catch(() => null)
    expect(
      (await w.frost.frostMovementCounters(T.id)).eligibleTargets,
      "scenario: no eligible target"
    ).to.equal(0)
    await increaseTime(3600 + 1) // movingFundsTimeoutResetDelay
    try {
      await (await w.frost.resetFrostMovingFundsTimeout(T.id)).wait()
    } catch (error) {
      expect.fail(
        `ADV-C2: a target with an unsigned inbound movement cannot reset its own timeout: ${reason(
          error
        )}`
      )
    }
    await increaseTime(TIMEOUT - 3600)
    await expect(
      w.frost.notifyFrostMovingFundsTimeout(T.id),
      "ADV-C2: the reset did not restart T's clock"
    ).to.be.revertedWith("FROST movement timeout")
    await notSanctioned()
  })
})
