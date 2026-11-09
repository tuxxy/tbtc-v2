/* eslint-disable no-await-in-loop, no-restricted-syntax, @typescript-eslint/no-loop-func */
// K-09 / C-10 cutover against the real ECDSA WalletRegistry (tuxxy/tbtc-v2#16,
// K09-5 round 8: "deploy the real WalletRegistry, then drive AwaitingSeed,
// AwaitingResult and Challenge. Cutover must refuse in each with the frame
// unchanged, and a late real approval after FrostOnly must not register an
// ECDSA wallet").
//
// Invariant: the C-10 cutover (`completeFrostCutover`) completes only while
// the real legacy DKG is IDLE; in every other DKG state it refuses with
// `Legacy DKG not idle` and changes nothing in the Bridge, the registry, the
// sortition pool or the exposure controller. After FrostOnly no ECDSA wallet
// can be registered by any public route.
//
// World: `k09-registry-world` (40a11d1d Bridge upgraded in place, real
// registry; ADAPTER beacon). Each DKG is driven on the 40a11d1d Bridge, so it
// is in flight across the upgrade.
import { ethers } from "hardhat"
import { expect } from "chai"
import {
  k09World,
  K09World,
  dkg,
  legacyKey,
  upgradeToFrost,
  storageFrame,
  createLegacyWallet,
  mine,
  DkgState,
  Mode,
  NO_MAIN,
} from "../helpers/k09-registry-world"

const MANIFEST = ethers.utils.id("K09-5 cutover manifest")

describe("K-09 cutover against the real ECDSA WalletRegistry DKG states (tbtc-v2#16)", function () {
  this.timeout(120_000)
  let w: K09World

  before(async () => {
    await k09World()
  })
  beforeEach(async () => {
    w = await k09World()
  })

  /// Bridge, registry, sortition pool and exposure: every fixed storage word,
  /// plus the views the cutover and the registry expose.
  const frame = async (frost: any) => ({
    storage: await storageFrame(w),
    mode: await frost.frostCreationMode(),
    manifest: await frost.frostCutoverManifest(),
    dkgState: await w.registry.getWalletCreationState(),
    poolLocked: await w.sortitionPool.isLocked(),
    timedOut: await w.registry.hasDkgTimedOut(),
    seedTimedOut: await w.registry.hasSeedTimedOut(),
    active: await w.bridge.activeWalletPubKeyHash(),
  })

  /// Drives the real DKG on the 40a11d1d Bridge into `state`.
  const drive = async (state: string) => {
    const d = dkg(w)
    const key = legacyKey(0x5000)
    if (state === "IDLE") return { d, key }
    await w.bridge.requestNewWallet(NO_MAIN)
    if (state === "AWAITING_SEED") return { d, key }
    await d.seed()
    if (state === "AWAITING_RESULT") return { d, key }
    const submitted = await d.submit(key)
    if (state === "CHALLENGE") return { d, key, submitted }
    await d.challengeOver() // approval pending: approvable by the submitter
    return { d, key, submitted }
  }

  const STATES: [string, number][] = [
    ["AWAITING_SEED", DkgState.AWAITING_SEED],
    ["AWAITING_RESULT", DkgState.AWAITING_RESULT],
    ["CHALLENGE", DkgState.CHALLENGE],
    ["approval pending", DkgState.CHALLENGE],
  ]

  for (const [name, state] of STATES)
    it(`refuses the cutover in ${name} with the full frame unchanged`, async () => {
      const { submitted } = await drive(name)
      const { frost } = await upgradeToFrost(w)
      await frost.beginLegacyDkgDrain()
      expect(await w.registry.getWalletCreationState()).to.equal(state)
      if (name === "approval pending")
        // The real approval is available right now.
        await w.registry
          .connect(submitted!.submitter)
          .callStatic.approveDkgResult(submitted!.result)
      const before = await frame(frost)
      await expect(
        frost.completeFrostCutover(MANIFEST),
        `cutover refused in ${name}`
      ).to.be.revertedWith("Legacy DKG not idle")
      expect(
        await frame(frost),
        "frame after the refused cutover"
      ).to.deep.equal(before)
      expect(await frost.frostCreationMode()).to.equal(Mode.LegacyDraining)
    })

  it("completes the cutover in IDLE (positive control), after a real DKG completed on 40a11d1d", async () => {
    await createLegacyWallet(w, w.bridge, legacyKey(0x5001))
    const { frost } = await upgradeToFrost(w)
    await frost.beginLegacyDkgDrain()
    expect(await w.registry.getWalletCreationState()).to.equal(DkgState.IDLE)
    expect(await w.sortitionPool.isLocked()).to.equal(false)
    await frost.completeFrostCutover(MANIFEST)
    expect(await frost.frostCreationMode()).to.equal(Mode.FrostOnly)
    expect(await frost.frostCutoverManifest()).to.equal(MANIFEST)
  })

  it("lets only the in-flight approval register, then cuts over; a late approval cannot register an ECDSA wallet", async () => {
    const { key, submitted } = await drive("approval pending")
    const { bridge, frost } = await upgradeToFrost(w)
    await frost.beginLegacyDkgDrain()
    await expect(
      frost.completeFrostCutover(MANIFEST),
      "cutover refused while approval is pending"
    ).to.be.revertedWith("Legacy DKG not idle")
    // The in-flight DKG may finish once, in LegacyDraining.
    await w.registry
      .connect(submitted!.submitter)
      .approveDkgResult(submitted!.result)
    expect((await bridge.wallets(key.pkh)).state).to.equal(1)
    await frost.completeFrostCutover(MANIFEST)
    expect(await frost.frostCreationMode()).to.equal(Mode.FrostOnly)

    const before = await frame(frost)
    // A late re-approval of the same result, a late result and a new request
    // all fail; no ECDSA wallet appears.
    await expect(
      w.registry
        .connect(submitted!.submitter)
        .approveDkgResult(submitted!.result),
      "late approval refused"
    ).to.be.revertedWith("Current state is not CHALLENGE")
    await expect(
      bridge.requestNewWallet(NO_MAIN),
      "new ECDSA request refused after the cutover"
    ).to.be.revertedWith("Legacy wallet creation closed")
    expect(await frame(frost), "frame after the late attempts").to.deep.equal(
      before
    )
  })

  it("after a DKG timeout and the cutover, a late real result can neither be submitted nor approved", async () => {
    const { d, key } = await drive("AWAITING_RESULT")
    // The members sign a valid result in time but publish it too late.
    const late = await d.prepare(key)
    const { bridge, frost } = await upgradeToFrost(w)
    await frost.beginLegacyDkgDrain()
    const params = await w.registry.dkgParameters()
    await mine(params.resultSubmissionTimeout.toNumber() + 1)
    expect(await w.registry.hasDkgTimedOut()).to.equal(true)
    await w.registry.notifyDkgTimeout()
    expect(await w.registry.getWalletCreationState()).to.equal(DkgState.IDLE)
    await frost.completeFrostCutover(MANIFEST)
    const before = await frame(frost)
    await expect(
      w.registry.connect(late.submitter).submitDkgResult(late.result),
      "late result refused"
    ).to.be.revertedWith("Current state is not AWAITING_RESULT")
    await expect(
      w.registry.connect(late.submitter).approveDkgResult(late.result),
      "late approval refused"
    ).to.be.revertedWith("Current state is not CHALLENGE")
    expect((await bridge.wallets(key.pkh)).state, "no ECDSA wallet").to.equal(0)
    expect(await frame(frost), "frame after the late result").to.deep.equal(
      before
    )
  })

  it("after a seed timeout and the cutover, a late relay entry cannot start a DKG", async () => {
    const { d } = await drive("AWAITING_SEED")
    const { frost } = await upgradeToFrost(w)
    await frost.beginLegacyDkgDrain()
    const params = await w.registry.dkgParameters()
    await mine(params.seedTimeout.toNumber() + 1)
    await w.registry.notifySeedTimeout()
    await frost.completeFrostCutover(MANIFEST)
    const before = await frame(frost)
    await expect(d.seed(), "late relay entry refused").to.be.revertedWith(
      "Current state is not AWAITING_SEED"
    )
    expect(
      await frame(frost),
      "frame after the late relay entry"
    ).to.deep.equal(before)
  })
})
