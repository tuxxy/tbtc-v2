/* eslint-disable no-await-in-loop, no-restricted-syntax, no-console, @typescript-eslint/no-loop-func */
// Refs tuxxy/tbtc-v2#49 (C-06: movement proofs above 131 targets exceed 2^24).
// Refs ADV-C1 (K-09-restart/ADV-contracts.md: the ECDSA-to-FROST drain has
// its own #49 window, proofs over 128 targets exceed 2^24).
// Decision (tux, 2026-11-04, DECISIONS.md): one movement target cap of 128,
// enforced at commitment, for both routes (ECDSA-to-FROST drain and
// FROST-to-FROST). Settles #49.
//
// Invariants, each on both routes:
// - CAP: a commitment naming more than 128 targets is refused at commitment
//   and leaves no inbound obligation, drain record or commitment behind.
// - FITS: a 128-target commitment is accepted under the 2^24 transaction
//   gas cap, and its movement proof (fresh targets, the worst case per
//   output; the mainnet proof depth of 6 headers) needs at most 2^24 gas
//   (estimateGas, the peak) and lands with a 2^24 gas limit.
// - NOT STRANDED (#49 criterion; KC-SF-V3 K-07 "without stranding value";
//   the frozen batch-5 Frost.Fraud.MovementOutputCap test asks the same of
//   the FROST route): a source that needs more than 128 targets still has an
//   accepted commitment of at most 128 targets through the existing
//   entrypoint, and that movement's proof fits 2^24. The test does not fix
//   which count is accepted (searches from 128 down), so it does not choose
//   between clamping to 128 and any smaller bound.
//
// World: `b8-world` (real 40a11d1d legacy source, real registry DKG,
// upgraded Bridge, FrostOnly; FROST wallets from the registry FIXTURE).
import { ethers } from "hardhat"
import { expect } from "chai"
import {
  b8World,
  B8World,
  FrostWallet,
  GAS_CAP,
  TARGET_CAP,
  PROOF_DEPTH,
  SOURCE_MAIN,
  ascending,
  ageOut,
  deepInclusion,
  movementTx,
  requireTargets,
  reason,
} from "../helpers/b8-world"

type Route = {
  name: string
  /// Puts the source in MovingFunds (if needed); returns eligible targets.
  prepare: (w: B8World) => Promise<FrostWallet[]>
  commit: (w: B8World, targets: FrostWallet[]) => Promise<unknown>
  /// Leftovers a refused commitment must not create.
  committed: (w: B8World) => Promise<boolean>
  prove: (w: B8World, targets: FrostWallet[], estimate: boolean) => any
  proven: (w: B8World) => Promise<boolean>
}

const drain: Route = {
  name: "ECDSA-to-FROST drain",
  // S is in MovingFunds from 40a11d1d; F (Live) and the pool are eligible.
  prepare: async (w) => {
    expect(
      (await w.frost.frostMovementCounters(w.F.id)).eligibleTargets
    ).to.equal(130)
    return ascending(w.pool)
  },
  commit: async (w, targets) =>
    (
      await w.bridge.connect(w.S.signers[0]).submitMovingFundsCommitment(
        w.S.pkh,
        w.S.main,
        w.S.members,
        1,
        targets.map((t) => t.label),
        { gasLimit: GAS_CAP }
      )
    ).wait(),
  committed: async (w) =>
    (await w.frost.frostDrainTargets(w.S.pkh)).length > 0 ||
    (await w.bridge.wallets(w.S.pkh)).movingFundsTargetWalletsCommitmentHash !==
      ethers.constants.HashZero,
  prove: (w, targets, estimate) => {
    const tx = movementTx(w.S.main.txHash, SOURCE_MAIN, targets)
    const args = [
      tx.tx,
      deepInclusion(tx.hash, PROOF_DEPTH),
      w.S.main,
      w.S.pkh,
    ] as const
    const b = w.bridge.connect(w.maintainer)
    return estimate
      ? b.estimateGas.submitMovingFundsProof(...args, { gasLimit: 29000000 })
      : b.submitMovingFundsProof(...args, { gasLimit: GAS_CAP })
  },
  proven: async (w) =>
    (await w.frost.frostDrainTargets(w.S.pkh)).length === 0 &&
    (await w.bridge.wallets(w.S.pkh)).state === 3, // legacy Closing
}

const frostRoute: Route = {
  name: "FROST-to-FROST",
  // F enters MovingFunds through the real age rule; the pool stays eligible.
  prepare: async (w) => {
    await ageOut(w)
    await w.lifecycle.notifyFrostWalletCloseable(w.F.id)
    expect(
      (await w.frost.frostMovementCounters(w.F.id)).eligibleTargets
    ).to.equal(129)
    return ascending(w.pool)
  },
  commit: async (w, targets) =>
    (
      await w.frost.connect(w.keeper).submitFrostMovingFundsCommitment(
        w.F.id,
        0,
        targets.map((t) => t.label),
        { gasLimit: GAS_CAP }
      )
    ).wait(),
  committed: async (w) => {
    const { period } = await w.frost.frostWalletLifecycle(w.F.id)
    const c = await w.frost.frostMovingFundsCommitment(w.F.id, period)
    return c.mainOutpoint !== ethers.constants.HashZero || c.targets.length > 0
  },
  prove: (w, targets, estimate) => {
    const main = w.F.main as { hash: string }
    const tx = movementTx(main.hash, w.F.value, targets)
    const args = [w.F.id, tx.tx, deepInclusion(tx.hash, PROOF_DEPTH)] as const
    const f = w.frost.connect(w.maintainer)
    return estimate
      ? f.estimateGas.submitFrostMovingFundsProof(...args, {
          gasLimit: 29000000,
        })
      : f.submitFrostMovingFundsProof(...args, { gasLimit: GAS_CAP })
  },
  proven: async (w) => {
    const { period } = await w.frost.frostWalletLifecycle(w.F.id)
    const c = await w.frost.frostMovingFundsCommitment(w.F.id, period)
    return c.provenAt.toNumber() > 0
  },
}

const valueOf = (w: B8World, route: Route) =>
  route === drain ? SOURCE_MAIN : w.F.value

/// Proves the committed movement to `targets` and checks it fits 2^24.
async function proveUnderCap(w: B8World, route: Route, targets: FrostWallet[]) {
  const k = targets.length
  let peak = 0
  try {
    peak = (await route.prove(w, targets, true)).toNumber()
  } catch (error) {
    expect.fail(
      `ADV-C1: the accepted ${k}-target ${
        route.name
      } movement cannot be proven: ${reason(error)}`
    )
  }
  expect(
    peak,
    `ADV-C1: the accepted ${k}-target ${route.name} proof needs ${peak} gas, over the 2^24 cap`
  ).to.be.at.most(GAS_CAP)
  let used = 0
  try {
    used = (await (await route.prove(w, targets, false)).wait()).gasUsed
  } catch (error) {
    expect.fail(
      `ADV-C1: the accepted ${k}-target ${
        route.name
      } proof fails under a 2^24 gas limit: ${reason(error)}`
    )
  }
  expect(
    await route.proven(w),
    `ADV-C1: the ${k}-target ${route.name} proof landed without proving`
  ).to.equal(true)
  for (const t of [targets[0], targets[k - 1]]) {
    const c = await w.frost.frostMovementCounters(t.id)
    expect(c.pendingIncoming, "proof records each incoming").to.equal(1)
    expect(c.inboundCommitments, "proof consumes the obligation").to.equal(0)
  }
  console.log(
    `      ${route.name}: ${k} targets, proof peak ${peak} gas, used ${used} (depth ${PROOF_DEPTH})`
  )
}

describe("B8 ADV-C1 / tbtc-v2#49: movement target cap 128 on both routes", () => {
  let w: B8World
  beforeEach(async function setup() {
    this.timeout(180000)
    w = await b8World()
  })

  for (const route of [drain, frostRoute]) {
    it(`[ADV-C1 #49] ${route.name}: a source that needs 129 targets cannot commit 129, and commits and proves at most 128 under 2^24`, async function over() {
      this.timeout(60000)
      const eligible = await route.prepare(w)
      await requireTargets(w, valueOf(w, route), 129)
      const all = eligible.slice(0, 129)
      expect(all.length).to.equal(129)

      let accepted129 = true
      try {
        await route.commit(w, all)
      } catch (error) {
        accepted129 = false
      }
      expect(
        accepted129,
        `ADV-C1: the ${route.name} commitment naming 129 targets was accepted (cap ${TARGET_CAP})`
      ).to.equal(false)
      expect(
        await route.committed(w),
        "ADV-C1: a refused commitment left a commitment behind"
      ).to.equal(false)
      for (const t of [all[0], all[128]])
        expect(
          (await w.frost.frostMovementCounters(t.id)).inboundCommitments,
          "ADV-C1: a refused commitment left an inbound obligation"
        ).to.equal(0)

      // Not stranded: the largest accepted commitment of at most 128.
      const refusals: string[] = []
      let committed: FrostWallet[] = []
      for (let k = TARGET_CAP; k >= 1 && committed.length === 0; k--) {
        try {
          await route.commit(w, all.slice(0, k))
          committed = all.slice(0, k)
        } catch (error) {
          if (refusals.length < 3) refusals.push(`${k}: ${reason(error)}`)
        }
      }
      if (committed.length === 0)
        expect.fail(
          `ADV-C1: a ${
            route.name
          } source that needs 129 targets has no accepted commitment of at most ${TARGET_CAP} targets (${refusals.join(
            "; "
          )})`
        )
      await proveUnderCap(w, route, committed)
    })

    it(`[ADV-C1 #49] ${route.name}: exactly 128 targets is accepted and its proof fits 2^24`, async function exact() {
      this.timeout(60000)
      const eligible = await route.prepare(w)
      await requireTargets(w, valueOf(w, route), TARGET_CAP)
      const targets = eligible.slice(0, TARGET_CAP)
      try {
        await route.commit(w, targets)
      } catch (error) {
        expect.fail(
          `ADV-C1: the ${
            route.name
          } commitment naming exactly ${TARGET_CAP} targets was refused under 2^24: ${reason(
            error
          )}`
        )
      }
      for (const t of [targets[0], targets[TARGET_CAP - 1]])
        expect(
          (await w.frost.frostMovementCounters(t.id)).inboundCommitments
        ).to.equal(1)
      await proveUnderCap(w, route, targets)
    })
  }
})
