/* eslint-disable no-await-in-loop, no-restricted-syntax, no-continue, @typescript-eslint/no-explicit-any, @typescript-eslint/no-loop-func, no-unused-expressions */
// C-11a: the FROST Bridge upgrade bundle, rehearsed on the populated
// 40a11d1d world under the production authority shape.
//
// Refs tuxxy/tbtc-v2#58 (C-11a milestone: KC-SF-V3 §7 C-11), #57 (FROST
// governance unreachable through BridgeGovernance), #56 (unlinked
// FrostBridge, the deploy-85 class). Decisions: D1 (baseline 40a11d1d), D20
// (governance unsets RebateStaking with 0x0), D21 pick (a) (local populated
// world, no fork), D22 pick (a) (a new BridgeGovernance version with one
// immediate onlyOwner forwarder per FROST governance call, same name as the
// Bridge function, installed with base's delayed Bridge governance transfer).
//
// The bundle under test is the production builder,
// `deploy/87_deploy_frost_bridge_upgrade.ts` (interface: test/c11/README.md),
// loaded dynamically: while it does not exist every case fails at
// `C-11 bundle builder present`. `C11_BUILDER=<file>` runs a control variant.
//
// Invariants (one per numbered property of K-09-restart/TESTS-C11.md):
// 1. AUTHORITY: the implementation changes only through Timelock ->
//    ProxyAdmin, after the Timelock delay; nobody else can schedule or
//    execute it; afterwards the deployer and an outsider can change neither
//    the implementation nor any FROST state.
// 2. INITIALIZATION: from the upgrade to the end of the bundle no
//    non-governance account can write FROST state; a new reinitializer (if
//    any) uses an unused version, runs atomically through upgradeAndCall and
//    refuses repeats, bare-implementation calls and wrong addresses; without
//    one, every FROST field is zero after the plain upgrade.
// 3. LEGACY PRESERVED: the whole frame is identical before and after the
//    bundle except a named allow-list, and every legacy obligation class is
//    still discharged afterwards.
// 4. G-D ONLY: after the bundle every FROST capability is off.
// 5. FROST GOVERNANCE REACHABLE (#57, D22): every governance-guarded FROST
//    entrypoint (derived, not listed) has a same-named BridgeGovernance
//    forwarder that the council can use immediately and nobody else can; the
//    activation runbook and the emergency stop work through it.
// 6. BYTECODE (#56 class): the deployed runtime code is the artifact with
//    every link substituted, every library has code, no placeholder is left,
//    metadata and immutables are handled explicitly, sizes <= 24,576 bytes.
// 7. VERIFIER: installed by code hash through the production route; a
//    mismatched hash is refused; replacement is a recorded fact.
// 8. ROLLBACK: before any FROST state exists, a timelocked rollback to the
//    40a11d1d implementation restores the pre-bundle frame and legacy service.
import hre, { artifacts, deployments, ethers } from "hardhat"
import { expect } from "chai"
import type { Contract } from "ethers"
import fs from "fs"
import path from "path"
import {
  c11World,
  C11World,
  LegacyName,
  Builder,
  FrostUpgradeBundle,
  FrostUpgradeStep,
  BUILDER_FILE,
  BUILDER_TAG,
  BUILDER_SKIP_ENV,
  GOVERNANCE_REASONS,
  OWNABLE_REASON,
  MAX_CODE,
  loadBuilder,
  abiOf,
  inputs,
  reason,
  implementationOf,
  schedule,
  execute,
  runStep,
  runSteps,
  readField,
  frostSlots,
  governanceGuarded,
  newInitializers,
  defaultArguments,
  unmappedBaseViews,
  c11Frame,
  changed,
  allowedDifferences,
  increaseTime,
  now,
  NO_MAIN,
  transaction,
  inclusion,
  p2wpkh,
  outpoint,
} from "../helpers/c11-upgrade-world"
import {
  dkg,
  MAX_UINT64,
  Mode,
  LegacyState,
} from "../helpers/k09-registry-world"
import {
  redemptionKey,
  challengeKey,
  SWEEP_FEE,
  RED_AMOUNT,
} from "../helpers/k09-legacy-ledger"
import { CLASSES } from "../k09/obligation-ledger"
import { p2tr, TYPE, ZERO } from "../helpers/frost-movement-world"

const GENESIS = ethers.utils.id("C11 synthetic regtest domain")
const RECORD = ethers.utils.id("UNQUALIFIED C11 local test record")
const EVIDENCE = ethers.utils.id("C11 legacy transition evidence")
const ABORT_RECORD = ethers.utils.id("C11 reviewed abort policy")
const MANIFEST = ethers.utils.id("C11 cutover manifest")
const BUDGET_RECORD = ethers.utils.id("C11 test budget; D-10 OPEN")
const ZERO_ADDRESS = ethers.constants.AddressZero
const REDEMPTION_TIMEOUT = 5 * 86400
const CLOSING_PERIOD = 7 * 86400
/// The entrypoints #57 names; the derivation must find at least these.
const ISSUE_57 = [
  "configureFrostRegistry",
  "configureFrostFunding",
  "configureFrostRedemptions",
  "installFrostExposureController",
  "setFrostFundingGates",
  "setFrostDrainEnabled",
  "setFrostRedemptionsEnabled",
  "setFrostRequestsEnabled",
  "setFrostDepositReservationMargin",
  "beginLegacyDkgDrain",
  "completeFrostCutover",
]

let builder: Builder | null = null
/// The named assertion every case starts with.
async function requireBuilder(): Promise<Builder> {
  builder = await loadBuilder()
  expect(builder, `C-11 bundle builder present: ${BUILDER_FILE}`).to.not.equal(
    null
  )
  return builder as Builder
}

/// The bundle deployed by the builder (contracts only, no step executed).
const deployedFixture = deployments.createFixture(async () => {
  const c = await c11World()
  const preFrame = await c11Frame(c)
  const bundle = await (builder as Builder).deployFrostBridgeUpgrade(
    hre,
    inputs(c)
  )
  return { c, bundle, preFrame }
})
/// The bundle executed: every step, as the council stand-in.
const upgradedFixture = deployments.createFixture(async () => {
  const d = await deployedFixture()
  await runSteps(d.c, d.bundle.steps)
  return d
})
/// A fixture call whose own failures surface as `label`; named assertions
/// raised inside it (a failing bundle step) pass through.
async function named<T>(label: string, fixture: () => Promise<T>): Promise<T> {
  await requireBuilder()
  let failure = ""
  let result: T | undefined
  try {
    result = await fixture()
  } catch (e: any) {
    if (e?.name === "AssertionError") throw e
    failure = reason(e)
  }
  expect(failure, label).to.equal("")
  return result as T
}
const deployed = () => named("C-11 bundle deploys", deployedFixture)
const upgraded = () => named("C-11 bundle deploys", upgradedFixture)

/// Context for the governance cases.
type Run = {
  c: C11World
  bundle: FrostUpgradeBundle
  bg: Contract
  frost: Contract
}
function context(c: C11World, bundle: FrostUpgradeBundle): Run {
  return {
    c,
    bundle,
    bg: new ethers.Contract(bundle.bridgeGovernance, [], c.council),
    frost: new ethers.Contract(c.proxy.address, [], ethers.provider),
  }
}
async function frostAt(c: C11World) {
  return ethers.getContractAt("IFrostBridge", c.proxy.address)
}
/// The FROST/Bridge fragment of a governance entrypoint by name.
async function fragment(name: string) {
  for (const a of ["IFrostBridge", "Bridge"]) {
    const i = new ethers.utils.Interface(await abiOf(a))
    const f = Object.values(i.functions).find((x) => x.name === name)
    if (f) return { i, f }
  }
  throw Error(`no fragment ${name}`)
}
/// Calldata of a Bridge governance entrypoint; a D22 forwarder has the same
/// name and types, so the same calldata addresses it on BridgeGovernance.
async function calldata(name: string, args: unknown[]) {
  const { i, f } = await fragment(name)
  return i.encodeFunctionData(f, args)
}
/// The council stand-in through the new BridgeGovernance, as a named step.
async function gov(r: Run, name: string, args: unknown[]) {
  let refused = ""
  try {
    await (
      await r.c.council.sendTransaction({
        to: r.bundle.bridgeGovernance,
        data: await calldata(name, args),
      })
    ).wait()
  } catch (e) {
    refused = reason(e)
  }
  expect(refused, `council through BridgeGovernance: ${name}`).to.equal("")
}
/// A refused call: reverted with one of `reasons` (any reason when empty).
async function refused(
  label: string,
  call: () => Promise<any>,
  reasons: string[] = []
) {
  let why = ""
  try {
    const tx = await call()
    if (tx && typeof tx.wait === "function") await tx.wait()
  } catch (e) {
    why = reason(e) || "<reverted>"
  }
  expect(why, `${label}: not refused`).to.not.equal("")
  if (reasons.length > 0)
    expect(reasons, `${label}: refused for "${why}"`).to.include(why)
}
const codehash = async (a: string) =>
  ethers.utils.keccak256(await ethers.provider.getCode(a))

// ---------------------------------------------------------------------------
// Valid-call recipes for every governance-guarded FROST entrypoint. The
// derivation case fails if a derived entrypoint has none.
// ---------------------------------------------------------------------------
type Recipe = {
  setup?: (string | ((r: Run) => Promise<void>))[]
  args: (r: Run) => Promise<unknown[]> | unknown[]
  effect: (r: Run) => Promise<void>
}
const field = (r: Run, p: string[]) => readField(r.c.proxy.address, p)
const expectField = async (
  r: Run,
  p: string[],
  v: bigint | string,
  label: string
) =>
  expect((await field(r, p)).toString(), label).to.equal(BigInt(v).toString())

/// Completes the in-flight legacy DKG Z through the real registry.
async function completeZ(r: Run) {
  const d = dkg(r.c)
  const z = await d.submit(r.c.z.key)
  await d.challengeOver()
  await r.c.registry.connect(z.submitter).approveDkgResult(z.result)
  return z
}

/// A FROST wallet through the registry FIXTURE callbacks (C-11b is the real
/// registry stack); ready, so Live.
async function frostWallet(r: Run, scalar = 0x3100) {
  const { chainId } = await ethers.provider.getNetwork()
  const pub = ethers.utils.computePublicKey(
    ethers.utils.hexZeroPad(ethers.utils.hexlify(scalar), 32),
    true
  )
  const q = `0x${pub.slice(4)}`
  const descriptor = {
    scheme: 2,
    profile: 1,
    chainId,
    registry: r.c.frostRegistry.address,
    epoch: await ethers.provider.getBlockNumber(),
    members: [1, 2, 3],
    operators: [r.c.keeper.address, r.c.manager.address, r.c.alias.address],
    threshold: 2,
    snowfallDescriptor: ethers.utils.id(`C11 FROST wallet ${scalar}`),
    outputKey: q,
  }
  const descriptorHash = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["bytes32", TYPE],
      [ethers.utils.id("tbtc-v2/frost-descriptor/v1"), descriptor]
    )
  )
  const id = ethers.utils.keccak256(
    ethers.utils.concat([ethers.utils.id("tbtc-v2/frost-wallet-id/v1"), q])
  )
  await r.c.frostRegistry.created(
    ethers.utils.defaultAbiCoder.encode([TYPE], [descriptor]),
    (await ethers.provider.getBlockNumber()) + 100000
  )
  await r.c.frostRegistry.ready(id, descriptorHash)
  return { q, id, label: id.slice(0, 42), descriptorHash }
}
type FrostWallet = Awaited<ReturnType<typeof frostWallet>>

let blinding = 0
async function frostTerms(r: Run, x: FrostWallet, amount: number) {
  blinding += 1
  const { chainId } = await ethers.provider.getNetwork()
  const t = {
    chainId,
    bridge: r.c.proxy.address,
    bitcoinGenesis: GENESIS,
    fullWalletId: x.id,
    descriptorHash: x.descriptorHash,
    depositor: r.c.alias.address,
    vault: ZERO_ADDRESS,
    blinding: ethers.utils.hexZeroPad(ethers.utils.hexlify(blinding), 8),
    amount,
    refundKey: x.q,
    refundLocktime: (await now()) + 86400,
    extraData: ZERO,
  }
  return t
}
/// A FROST reveal (not sent): terms and the funding transaction.
async function frostReveal(r: Run, x: FrostWallet, amount: number) {
  const frost = await frostAt(r.c)
  const t = await frostTerms(r, x, amount)
  const output = await frost.frostDepositOutput(t)
  const fundingTx = transaction(
    [[ethers.utils.id(`C11 FROST funding ${blinding}`), 0]],
    [{ value: amount, script: p2tr(output.key) }]
  )
  return { t, fundingTx }
}

/// Retires the rebated pending legacy redemptions (T and V, by timeout): the
/// Bridge's setRebateStaking rule says to unset only when none is pending.
/// (V's watchtower veto window has elapsed during the bundle's 48 h
/// governance delay, so the timeout is the route left.)
async function retireRebatedRedemptions(r: Run) {
  await increaseTime(REDEMPTION_TIMEOUT + 1)
  const { legacy } = r.c
  await legacy
    .connect(r.c.alias)
    .notifyRedemptionTimeout(
      r.c.wallets.T.pkh,
      r.c.wallets.T.members,
      r.c.scripts.T
    )
  await legacy
    .connect(r.c.alias)
    .notifyRedemptionTimeout(
      r.c.wallets.R.pkh,
      r.c.wallets.R.members,
      r.c.scripts.V
    )
}

/// The activation runbook (D20, then installs, then gates), through the
/// production route. Returns a ready FROST wallet.
async function activate(r: Run, retire = true) {
  if (retire) await retireRebatedRedemptions(r)
  await gov(r, "setRebateStaking", [ZERO_ADDRESS])
  await gov(r, "configureFrostRegistry", [r.c.frostRegistry.address])
  await gov(r, "configureFrostFunding", [
    r.bundle.verifier,
    await codehash(r.bundle.verifier),
    RECORD,
    GENESIS,
  ])
  // Controller governance is the council stand-in (D-10 OPEN); TEST ceilings.
  const controller = await ethers.getContractAt(
    "FrostExposureController",
    r.bundle.exposureController
  )
  await controller
    .connect(r.c.council)
    .openBudgetPeriod(MAX_UINT64, MAX_UINT64, BUDGET_RECORD)
  await gov(r, "installFrostExposureController", [r.bundle.exposureController])
  await gov(r, "setFrostFundingGates", [true, true])
  return { wallet: await frostWallet(r), controller }
}

/// A funded FROST wallet: a real FROST reveal and deposit sweep.
async function fundFrostWallet(r: Run, x: FrostWallet, amount: number) {
  const frost = await frostAt(r.c)
  const { t, fundingTx } = await frostReveal(r, x, amount)
  await frost.connect(r.c.alias).revealFrostDeposit(t, fundingTx.tx, 0)
  const main = transaction(
    [[fundingTx.hash, 0]],
    [{ value: amount - SWEEP_FEE, script: p2tr(x.q) }]
  )
  await frost.connect(r.c.maintainer).submitFrostDepositSweepProof({
    walletId: x.id,
    transaction: main.tx,
    proof: inclusion(main.hash),
    includeMain: false,
    vault: ZERO_ADDRESS,
  })
}

let quarantined: { id: string; version: number } | undefined
const RECIPES: Record<string, Recipe> = {
  configureFrostRegistry: {
    args: (r) => [r.c.frostRegistry.address],
    effect: async (r) =>
      expect(
        await (await frostAt(r.c)).frostRegistry(),
        "registry bound"
      ).to.equal(r.c.frostRegistry.address),
  },
  setFrostRequestsEnabled: {
    setup: ["configureFrostRegistry"],
    args: () => [true],
    effect: (r) =>
      expectField(
        r,
        ["self", "frost", "requestsEnabled"],
        BigInt(1),
        "requests enabled"
      ),
  },
  configureFrostFunding: {
    args: async (r) => [
      r.bundle.verifier,
      await codehash(r.bundle.verifier),
      RECORD,
      GENESIS,
    ],
    effect: (r) =>
      expectField(
        r,
        ["self", "frostFunding", "configuration", "verifier"],
        BigInt(r.bundle.verifier),
        "verifier installed"
      ),
  },
  installFrostExposureController: {
    args: (r) => [r.bundle.exposureController],
    effect: async (r) =>
      expect(
        await (await frostAt(r.c)).frostExposureController(),
        "controller installed"
      ).to.equal(r.bundle.exposureController),
  },
  setFrostFundingGates: {
    setup: ["configureFrostFunding", "installFrostExposureController"],
    args: () => [true, true],
    effect: async (r) => {
      await expectField(
        r,
        ["self", "frostFunding", "configuration", "addressesEnabled"],
        BigInt(1),
        "addresses gate open"
      )
      await expectField(
        r,
        ["self", "frostFunding", "configuration", "revealEnabled"],
        BigInt(1),
        "reveal gate open"
      )
    },
  },
  setFrostDrainEnabled: {
    setup: ["installFrostExposureController"],
    args: () => [true],
    effect: (r) =>
      expectField(
        r,
        ["self", "frostMovement", "drainEnabled"],
        BigInt(1),
        "drain enabled"
      ),
  },
  configureFrostRedemptions: {
    args: (r) => [GENESIS, 6, 100, r.c.tower.address, EVIDENCE],
    effect: (r) =>
      expectField(
        r,
        ["self", "frostRedemptions", "configuration", "bitcoinGenesis"],
        BigInt(GENESIS),
        "redemptions configured"
      ),
  },
  setFrostRedemptionsEnabled: {
    setup: ["configureFrostFunding", "configureFrostRedemptions"],
    args: () => [true],
    effect: (r) =>
      expectField(
        r,
        ["self", "frostRedemptions", "configuration", "enabled"],
        BigInt(1),
        "redemptions enabled"
      ),
  },
  setFrostDepositReservationMargin: {
    args: () => [3600],
    effect: async (r) =>
      expect(
        await (await frostAt(r.c)).frostDepositReservationMargin(),
        "margin set"
      ).to.equal(3600),
  },
  beginLegacyDkgDrain: {
    args: () => [],
    effect: async (r) =>
      expect(
        await (await frostAt(r.c)).frostCreationMode(),
        "LegacyDraining"
      ).to.equal(Mode.LegacyDraining),
  },
  abortLegacyDkgDrain: {
    setup: ["beginLegacyDkgDrain"],
    args: () => [ABORT_RECORD],
    effect: async (r) =>
      expect(
        await (await frostAt(r.c)).frostCreationMode(),
        "LegacyOpen again"
      ).to.equal(Mode.LegacyOpen),
  },
  completeFrostCutover: {
    setup: [
      "configureFrostRegistry",
      "beginLegacyDkgDrain",
      async (r) => {
        await completeZ(r)
      },
    ],
    args: () => [MANIFEST],
    effect: async (r) => {
      const frost = await frostAt(r.c)
      expect(await frost.frostCreationMode(), "FrostOnly").to.equal(
        Mode.FrostOnly
      )
      expect(await frost.frostCutoverManifest(), "manifest").to.equal(MANIFEST)
    },
  },
  quarantineFrostWallet: {
    setup: [
      async (r) => {
        // Activation without retiring the rebated legacy redemptions first
        // (that runbook rule is exercised by the runbook case).
        const { wallet } = await activate(r, false)
        await fundFrostWallet(r, wallet, 200000)
        const custody = await (await frostAt(r.c)).frostWalletCustody(wallet.id)
        quarantined = { id: wallet.id, version: Number(custody.stateVersion) }
      },
    ],
    args: () => [
      quarantined!.id,
      quarantined!.version,
      ethers.utils.id("C11 quarantine reason"),
      ethers.utils.id("C11 quarantine evidence"),
    ],
    effect: async (r) => {
      const record = await (
        await frostAt(r.c)
      ).frostWalletQuarantine(quarantined!.id, quarantined!.version + 1)
      expect(record.stateVersion, "quarantine recorded").to.equal(
        quarantined!.version + 1
      )
    },
  },
}

/// Runs a recipe's setup through the production route.
async function setup(r: Run, name: string) {
  for (const s of RECIPES[name].setup ?? []) {
    if (typeof s === "string") {
      await setup(r, s)
      await gov(r, s, await RECIPES[s].args(r))
    } else await s(r)
  }
}

/// FROST user entrypoints, called by an outsider (property 4 and the window).
async function userEntrypoints(c: C11World) {
  const frost = await frostAt(c)
  const x = await frostLikeTerms(c)
  const fundingTx = transaction(
    [[ethers.utils.id("C11 outsider funding"), 0]],
    [{ value: 100000, script: p2tr(ethers.utils.hexZeroPad("0x02", 32)) }]
  )
  return {
    "FROST reveal": () =>
      frost.connect(c.outsider).revealFrostDeposit(x, fundingTx.tx, 0),
    "FROST wallet request": () =>
      frost.connect(c.outsider).requestNewFrostWallet(),
    "FROST redemption request": () =>
      frost
        .connect(c.outsider)
        .requestFrostRedemption(
          ethers.utils.hexZeroPad("0x01", 32),
          `0x160014${"11".repeat(20)}`,
          100000,
          c.outsider.address
        ),
    "drain commitment": () =>
      c.legacy
        .connect(c.wallets.M.signers[0])
        .submitMovingFundsCommitment(
          c.wallets.M.pkh,
          c.mains.M,
          c.wallets.M.members,
          1,
          [ethers.utils.hexZeroPad("0x0c11", 20)]
        ),
  } as Record<string, () => Promise<any>>
}
async function frostLikeTerms(c: C11World) {
  const { chainId } = await ethers.provider.getNetwork()
  return {
    chainId,
    bridge: c.proxy.address,
    bitcoinGenesis: GENESIS,
    fullWalletId: ethers.utils.hexZeroPad("0x0c11", 32),
    descriptorHash: ethers.utils.hexZeroPad("0x0c11", 32),
    depositor: c.outsider.address,
    vault: ZERO_ADDRESS,
    blinding: ethers.utils.hexZeroPad("0x01", 8),
    amount: 100000,
    refundKey: ethers.utils.hexZeroPad("0x02", 32),
    refundLocktime: (await now()) + 86400,
    extraData: ZERO,
  }
}

/// Outsider and deployer calls to every governance-guarded entrypoint
/// directly on the Bridge (refused with the governance reason); outsider
/// calls to every new initializer and every FROST user entrypoint (refused);
/// the frame is unchanged.
async function probeOutsider(r: Run, guarded: any[], label: string) {
  const before = await c11Frame(r.c)
  for (const f of guarded) {
    // The governance check is each branch's first statement, so any
    // arguments reach it; the refusal reason is pinned.
    const data = await calldata(f.name, defaultArguments(f, true))
    for (const [who, s] of Object.entries({
      outsider: r.c.outsider,
      deployer: r.c.deployer,
    }))
      await refused(
        `${label}: ${who} ${f.name} on the Bridge`,
        () => s.sendTransaction({ to: r.c.proxy.address, data }),
        GOVERNANCE_REASONS
      )
  }
  for (const f of await newInitializers(r.c)) {
    const i = new ethers.utils.Interface([f])
    for (const max of [false, true])
      await refused(`${label}: outsider initializer ${f.name}`, () =>
        r.c.outsider.sendTransaction({
          to: r.c.proxy.address,
          data: i.encodeFunctionData(f, defaultArguments(f, max)),
        })
      )
  }
  for (const [name, call] of Object.entries(await userEntrypoints(r.c)))
    await refused(`${label}: outsider ${name}`, call)
  expect(
    changed(before, await c11Frame(r.c)),
    `${label}: frame unchanged by outsider calls`
  ).to.deep.equal([])
}

/// ProxyAdmin, Timelock, Bridge and BridgeGovernance attempts by `who`.
async function attemptAuthority(
  r: Run,
  who: { name: string; signer: any },
  guarded: any[]
) {
  const { c, bundle } = r
  const s = who.signer
  await refused(
    `${who.name}: ProxyAdmin.upgrade`,
    () => c.admin.connect(s).upgrade(c.proxy.address, c.baseline.address),
    [OWNABLE_REASON]
  )
  await refused(
    `${who.name}: ProxyAdmin.upgradeAndCall`,
    () =>
      c.admin
        .connect(s)
        .upgradeAndCall(c.proxy.address, c.baseline.address, "0x"),
    [OWNABLE_REASON]
  )
  await refused(
    `${who.name}: ProxyAdmin.changeProxyAdmin`,
    () => c.admin.connect(s).changeProxyAdmin(c.proxy.address, s.address),
    [OWNABLE_REASON]
  )
  await refused(`${who.name}: Timelock schedule`, () =>
    schedule(
      c,
      {
        kind: "timelock",
        actions: [
          {
            target: c.admin.address,
            value: 0,
            data: c.admin.interface.encodeFunctionData("upgrade", [
              c.proxy.address,
              c.baseline.address,
            ]),
          },
        ],
        predecessor: ethers.constants.HashZero,
        salt: ethers.utils.id(`C11 ${who.name}`),
        description: "attacker",
      },
      s
    )
  )
  for (const f of guarded) {
    const data = await calldata(f.name, defaultArguments(f, true))
    await refused(
      `${who.name}: ${f.name} on the Bridge`,
      () => s.sendTransaction({ to: c.proxy.address, data }),
      GOVERNANCE_REASONS
    )
    await refused(
      `${who.name}: ${f.name} through BridgeGovernance`,
      () => s.sendTransaction({ to: bundle.bridgeGovernance, data }),
      [OWNABLE_REASON]
    )
  }
  const bg = await ethers.getContractAt(
    "BridgeGovernance",
    bundle.bridgeGovernance
  )
  await refused(
    `${who.name}: BridgeGovernance.transferOwnership`,
    () => bg.connect(s).transferOwnership(s.address),
    [OWNABLE_REASON]
  )
  await refused(
    `${who.name}: BridgeGovernance.beginBridgeGovernanceTransfer`,
    () => bg.connect(s).beginBridgeGovernanceTransfer(s.address),
    [OWNABLE_REASON]
  )
  const controller = await ethers.getContractAt(
    "FrostExposureController",
    bundle.exposureController
  )
  await refused(`${who.name}: exposure budget`, () =>
    controller
      .connect(s)
      .openBudgetPeriod(MAX_UINT64, MAX_UINT64, BUDGET_RECORD)
  )
}

/// Immutable references of a compiled contract, from its build-info (each
/// build-info file is parsed once).
const buildInfos = new Map<string, any>()
async function immutableReferences(source: string, name: string) {
  const dbg = artifacts
    .formArtifactPathFromFullyQualifiedName(`${source}:${name}`)
    .replace(/\.json$/, ".dbg.json")
  const file = path.resolve(
    path.dirname(dbg),
    JSON.parse(fs.readFileSync(dbg, "utf8")).buildInfo
  )
  if (!buildInfos.has(file))
    buildInfos.set(file, JSON.parse(fs.readFileSync(file, "utf8")))
  const out =
    buildInfos.get(file).output.contracts[source][name].evm.deployedBytecode
  return (out.immutableReferences ?? {}) as Record<
    string,
    { start: number; length: number }[]
  >
}

describe("C-11a FROST Bridge upgrade bundle (tbtc-v2#58, #57, #56)", function () {
  this.timeout(180_000)
  let c: C11World
  /// The world is built once (suite setup); each case starts from a snapshot.
  before(async () => {
    c = await c11World()
  })
  afterEach(function timing() {
    if (process.env.C11_TIMING)
      console.log(
        `C11 TIMING ${this.currentTest?.duration} ms ${this.currentTest?.title}`
      )
  })

  it("[C-11 interface] the builder is the production deploy script, tagged and skipped by default", async () => {
    const b = await requireBuilder()
    expect(
      typeof b.deployFrostBridgeUpgrade,
      "deployFrostBridgeUpgrade exported"
    ).to.equal("function")
    expect(b.default?.tags ?? [], `tag ${BUILDER_TAG}`).to.include(BUILDER_TAG)
    const saved = process.env[BUILDER_SKIP_ENV]
    try {
      delete process.env[BUILDER_SKIP_ENV]
      expect(
        await b.default.skip(hre),
        `skipped unless ${BUILDER_SKIP_ENV}=true`
      ).to.equal(true)
      process.env[BUILDER_SKIP_ENV] = "true"
      expect(
        await b.default.skip(hre),
        `runs with ${BUILDER_SKIP_ENV}=true`
      ).to.equal(false)
    } finally {
      if (saved === undefined) delete process.env[BUILDER_SKIP_ENV]
      else process.env[BUILDER_SKIP_ENV] = saved
    }
  })

  it("[#57, D22] every governance-guarded FROST entrypoint has a same-named BridgeGovernance forwarder", async () => {
    c = await c11World()
    // Derived by behaviour on this checkout's bare Bridge implementation
    // (governance 0x0): the new non-view functions that refuse an outsider
    // with the governance reason.
    const guarded = await governanceGuarded(c, c.implementation.address)
    const names = guarded.map((f) => f.name)
    expect(names, "derivation finds the #57 entrypoints").to.include.members(
      ISSUE_57
    )
    const bg = new ethers.utils.Interface(
      (await artifacts.readArtifact("BridgeGovernance")).abi
    )
    const routes = new Set(Object.values(bg.functions).map((f) => f.format()))
    for (const f of guarded)
      expect(
        routes.has(f.format()),
        `no BridgeGovernance route for ${f.format()}`
      ).to.equal(true)
    for (const f of guarded)
      expect(
        RECIPES[f.name],
        `no C-11 recipe for governance entrypoint ${f.name}`
      ).to.not.equal(undefined)
    for (const name of Object.keys(RECIPES))
      expect(
        names,
        `recipe for an entrypoint that is not governance-guarded: ${name}`
      ).to.include(name)
  })

  it("[1 authority] the implementation changes only through Timelock -> ProxyAdmin, after the delay, and nobody else can schedule or execute it", async () => {
    const { c: w, bundle } = await deployed()
    c = w
    expect(bundle.steps.length, "bundle has steps").to.be.greaterThan(0)
    const attackers = [
      ["outsider", c.outsider],
      ["deployer", c.deployer],
      ["historical deployer", c.historicalDeployer],
    ] as const
    let changes = 0
    for (const [i, step] of bundle.steps.entries()) {
      const before = await implementationOf(c)
      if (step.kind === "council")
        expect(
          step.to.toLowerCase(),
          `step ${i}: a council step targets the ProxyAdmin`
        ).to.not.equal(c.admin.address.toLowerCase())
      if (step.kind === "timelock") {
        for (const [name, s] of attackers)
          await refused(`step ${i}: ${name} schedules`, () =>
            schedule(c, step, s)
          )
        await (await schedule(c, step)).wait()
        await refused(`step ${i}: execution before the delay`, () =>
          execute(c, step)
        )
        const ready = await c.timelock.getTimestamp(
          await c.timelock.hashOperationBatch(
            step.actions.map((a) => a.target),
            step.actions.map((a) => a.value),
            step.actions.map((a) => a.data),
            step.predecessor,
            step.salt
          )
        )
        // Mined attempts (explicit gas), so the block timestamp is exact.
        const mined = { gasLimit: 3_000_000 }
        await ethers.provider.send("evm_setNextBlockTimestamp", [
          ready.toNumber() - 1,
        ])
        await refused(`step ${i}: execution one second before the delay`, () =>
          execute(c, step, c.council, mined)
        )
        expect(
          await implementationOf(c),
          `step ${i}: implementation unchanged before the delay`
        ).to.equal(before)
        await ethers.provider.send("evm_setNextBlockTimestamp", [
          ready.toNumber(),
        ])
        for (const [name, s] of attackers)
          await refused(`step ${i}: ${name} executes after the delay`, () =>
            execute(c, step, s, mined)
          )
        expect(
          await implementationOf(c),
          `step ${i}: implementation unchanged by attackers`
        ).to.equal(before)
        await (await execute(c, step)).wait()
      } else {
        await runSteps(c, [step])
      }
      const after = await implementationOf(c)
      if (after !== before) {
        changes += 1
        expect(
          step.kind === "timelock" &&
            step.actions.some(
              (a) => a.target.toLowerCase() === c.admin.address.toLowerCase()
            ),
          `implementation changed outside Timelock -> ProxyAdmin at step ${i}`
        ).to.equal(true)
      }
    }
    expect(changes, "the bundle upgrades the implementation").to.be.greaterThan(
      0
    )
    expect(
      await implementationOf(c),
      "final implementation is the bundle's"
    ).to.equal(ethers.utils.getAddress(bundle.bridgeImplementation))
  })

  it("[2 window] from the upgrade to the end of the bundle no non-governance account can write FROST state", async () => {
    const { c: w, bundle } = await deployed()
    c = w
    const r = context(c, bundle)
    const guarded = await governanceGuarded(c, bundle.bridgeImplementation)
    expect(
      guarded.map((f) => f.name),
      "derivation on the bundle's implementation"
    ).to.include.members(ISSUE_57)
    let upgradedAt = -1
    await runSteps(c, bundle.steps, async (i) => {
      if (
        upgradedAt < 0 &&
        (await implementationOf(c)) ===
          ethers.utils.getAddress(bundle.bridgeImplementation)
      )
        upgradedAt = i
      if (upgradedAt >= 0) await probeOutsider(r, guarded, `after step ${i}`)
    })
    expect(upgradedAt, "the bundle upgrades the implementation").to.be.at.least(
      0
    )
  })

  it("[2 initialization] a new reinitializer is atomic and refuses repeat, bare and wrong-address calls; without one no FROST field is set", async () => {
    const { c: w, bundle } = await deployed()
    c = w
    const initializers = await newInitializers(c)
    const proxyAdmin = c.admin.interface
    const upgradeCalls = bundle.steps
      .flatMap((s) => (s.kind === "timelock" ? s.actions : []))
      .filter((a) => a.target.toLowerCase() === c.admin.address.toLowerCase())
      .map((a) => proxyAdmin.parseTransaction({ data: a.data }))
    expect(
      upgradeCalls.length,
      "the bundle has a ProxyAdmin upgrade"
    ).to.be.greaterThan(0)
    if (initializers.length === 0) {
      for (const call of upgradeCalls)
        if (call.name === "upgradeAndCall")
          expect(
            call.args[2],
            "no initializer: upgradeAndCall carries no call"
          ).to.equal("0x")
      await upgradedFixture()
      for (const s of await frostSlots())
        expect(
          await ethers.provider.getStorageAt(
            c.proxy.address,
            ethers.BigNumber.from(s.slot)
          ),
          `no initializer: FROST field zero after the plain upgrade (${s.member}, slot ${s.slot})`
        ).to.equal(ethers.constants.HashZero)
      return
    }
    for (const f of initializers) {
      const version = Number(/^initializeV(\d+)/.exec(f.name)?.[1])
      expect(
        version,
        `reinitializer version unused (> 5): ${f.name}`
      ).to.be.greaterThan(5)
    }
    const atomic = upgradeCalls.find(
      (call) =>
        call.name === "upgradeAndCall" &&
        initializers.some((f) =>
          call.args[2].startsWith(new ethers.utils.Interface([f]).getSighash(f))
        )
    )
    expect(
      atomic,
      "reinitializer runs atomically through upgradeAndCall"
    ).to.not.equal(undefined)
    const init = initializers.find((f) =>
      atomic!.args[2].startsWith(new ethers.utils.Interface([f]).getSighash(f))
    )!
    const iface = new ethers.utils.Interface([init])
    const args = iface.decodeFunctionData(init, atomic!.args[2])
    // Wrong addresses, each address argument in turn, through the real route.
    const before = await implementationOf(c)
    for (const [index, input] of init.inputs.entries()) {
      if (input.type !== "address") continue
      for (const wrong of [ZERO_ADDRESS, c.outsider.address]) {
        const mutated = [...args]
        mutated[index] = wrong
        const step: FrostUpgradeStep = {
          kind: "timelock",
          actions: [
            {
              target: c.admin.address,
              value: 0,
              data: proxyAdmin.encodeFunctionData("upgradeAndCall", [
                c.proxy.address,
                bundle.bridgeImplementation,
                iface.encodeFunctionData(init, mutated),
              ]),
            },
          ],
          predecessor: ethers.constants.HashZero,
          salt: ethers.utils.id(`C11 wrong ${index} ${wrong}`),
          description: "wrong address",
        }
        await refused(
          `wrong-address initialization refused (${init.name} argument ${index} = ${wrong})`,
          () => runStep(c, step)
        )
        expect(
          await implementationOf(c),
          "implementation unchanged by a refused initialization"
        ).to.equal(before)
      }
    }
    await refused("bare implementation refuses initialization", () =>
      c.council.sendTransaction({
        to: bundle.bridgeImplementation,
        data: atomic!.args[2],
      })
    )
    await runSteps(c, bundle.steps)
    for (const s of [c.council, c.outsider])
      await refused("repeated initialization refused", () =>
        s.sendTransaction({ to: c.proxy.address, data: atomic!.args[2] })
      )
  })

  it("[1 authority] after the bundle the deployer and an outsider can change neither the implementation nor any FROST state", async () => {
    const { c: w, bundle } = await upgraded()
    c = w
    const r = context(c, bundle)
    const bg = await ethers.getContractAt(
      "BridgeGovernance",
      bundle.bridgeGovernance
    )
    expect(await c.admin.owner(), "ProxyAdmin owner is the Timelock").to.equal(
      c.timelock.address
    )
    expect(
      await c.legacy.governance(),
      "Bridge governance is the bundle's BridgeGovernance"
    ).to.equal(ethers.utils.getAddress(bundle.bridgeGovernance))
    expect(await bg.owner(), "BridgeGovernance owner is the council").to.equal(
      c.council.address
    )
    const controller = await ethers.getContractAt(
      "FrostExposureController",
      bundle.exposureController
    )
    expect(
      await controller.governance(),
      "exposure controller governance (D-10 OPEN: council)"
    ).to.equal(c.council.address)
    const roles = {
      proposer: await c.timelock.PROPOSER_ROLE(),
      executor: await c.timelock.EXECUTOR_ROLE(),
      canceller: await c.timelock.CANCELLER_ROLE(),
      admin: await c.timelock.TIMELOCK_ADMIN_ROLE(),
    }
    expect(
      await c.timelock.hasRole(roles.proposer, c.council.address),
      "council proposes"
    ).to.equal(true)
    expect(
      await c.timelock.hasRole(roles.executor, c.council.address),
      "council executes"
    ).to.equal(true)
    for (const [who, a] of Object.entries({
      deployer: c.deployer.address,
      "historical deployer": c.historicalDeployer.address,
      outsider: c.outsider.address,
    })) {
      for (const [role, id] of Object.entries(roles))
        expect(
          await c.timelock.hasRole(id, a),
          `no Timelock ${role} role for the ${who}`
        ).to.equal(false)
      for (const [name, contract] of Object.entries({
        bg,
        tower: c.tower,
        rebate: c.rebate,
        bank: c.bank,
      }))
        expect(
          (await contract.owner()).toLowerCase(),
          `the ${who} owns no ${name}`
        ).to.not.equal(a.toLowerCase())
    }
    const guarded = await governanceGuarded(c, bundle.bridgeImplementation)
    const before = await c11Frame(c)
    for (const who of [
      { name: "outsider", signer: c.outsider },
      { name: "deployer", signer: c.deployer },
      { name: "historical deployer", signer: c.historicalDeployer },
    ])
      await attemptAuthority(r, who, guarded)
    expect(
      changed(before, await c11Frame(c)),
      "frame unchanged by refused attempts"
    ).to.deep.equal([])
  })

  it("[3 legacy] the whole frame is identical before and after the bundle except the named allow-list", async () => {
    const { c: w, bundle, preFrame } = await upgraded()
    c = w
    expect(unmappedBaseViews(c), "unmapped 40a11d1d view").to.deep.equal([])
    const reinitialized = (await newInitializers(c)).length > 0
    const allowed = await allowedDifferences(reinitialized)
    const after = await c11Frame(c)
    const diff = changed(preFrame, after)
    const unexpected = diff.filter((k) => !allowed[k])
    expect(
      unexpected.map((k) => `${k}: ${preFrame[k]} -> ${after[k]}`),
      "frame differences outside the allow-list"
    ).to.deep.equal([])
    // Each allowed difference is the named one.
    expect(
      JSON.parse(after["eip1967:implementation"]).slice(26),
      "implementation slot is the bundle's"
    ).to.equal(bundle.bridgeImplementation.slice(2).toLowerCase())
    expect(
      JSON.parse(after["bridge:governance"]),
      "governance is the bundle's BridgeGovernance"
    ).to.equal(ethers.utils.getAddress(bundle.bridgeGovernance))
  })

  const witnessed = new Set<string>()
  const discharges = async (route: string, call: () => Promise<any>) => {
    let why = ""
    try {
      await (await call()).wait()
    } catch (e) {
      why = reason(e)
    }
    expect(why, `${route} discharges after the bundle`).to.equal("")
    witnessed.add(route)
  }
  const wallet = (n: LegacyName | "Z") =>
    c.legacy.wallets(n === "Z" ? c.z.key.pkh : c.wallets[n].pkh)
  const redemptionTx = (name: "R" | "U", script: string) => {
    const main = c.mains[name]
    const paid = RED_AMOUNT - RED_AMOUNT / 100 - 1000
    return {
      main,
      tx: transaction(
        [[main.txHash, 0]],
        [
          { value: paid, script: Buffer.from(script.slice(2), "hex") },
          {
            value: main.txOutputValue - paid - 1000,
            script: p2wpkh(c.wallets[name].pkh),
          },
        ]
      ),
    }
  }

  it("[3 legacy] deposits, redemptions, rebates and timed-out redemptions are discharged after the bundle", async () => {
    c = (await upgraded()).c
    // Deposits: both unswept deposits of D in one sweep.
    const d1 = await c.legacy.deposits(c.depositKeys.d1)
    expect(d1.revealedAt, "d1 revealed").to.be.greaterThan(0)
    const dSweep = transaction(
      [
        [c.deposits.d1.hash, 0],
        [c.deposits.d2.hash, 0],
      ],
      [{ value: 50000 + 60000 - SWEEP_FEE, script: p2wpkh(c.wallets.D.pkh) }]
    )
    await discharges("deposit-sweep", () =>
      c.legacy
        .connect(c.maintainer)
        .submitDepositSweepProof(
          dSweep.tx,
          inclusion(dSweep.hash),
          NO_MAIN,
          ZERO_ADDRESS
        )
    )
    expect(
      (await c.legacy.deposits(c.depositKeys.d2)).sweptAt,
      "d2 swept"
    ).to.be.greaterThan(0)
    // Pending redemption R: proof.
    const r = redemptionTx("R", c.scripts.R)
    await discharges("redemption-proof", () =>
      c.legacy
        .connect(c.maintainer)
        .submitRedemptionProof(
          r.tx.tx,
          inclusion(r.tx.hash),
          r.main,
          c.wallets.R.pkh
        )
    )
    expect(
      (
        await c.legacy.pendingRedemptions(
          redemptionKey(c.wallets.R.pkh, c.scripts.R)
        )
      ).requestedAt,
      "R paid"
    ).to.equal(0)
    // Timed-out redemption U: still payable.
    const u = redemptionTx("U", c.scripts.U)
    await discharges("timed-out-redemption-proof", () =>
      c.legacy
        .connect(c.maintainer)
        .submitRedemptionProof(
          u.tx.tx,
          inclusion(u.tx.hash),
          u.main,
          c.wallets.U.pkh
        )
    )
    expect(
      (
        await c.legacy.timedOutRedemptions(
          redemptionKey(c.wallets.U.pkh, c.scripts.U)
        )
      ).requestedAt,
      "U paid"
    ).to.equal(0)
    // Rebated redemption T: timeout releases the rebate.
    await increaseTime(REDEMPTION_TIMEOUT + 1)
    const before = (await c.rebate.getRebate(c.rebater.address, 0)).feeRebate
    expect(before, "T's rebate before").to.equal(400)
    await discharges("redemption-timeout", () =>
      c.legacy
        .connect(c.alias)
        .notifyRedemptionTimeout(
          c.wallets.T.pkh,
          c.wallets.T.members,
          c.scripts.T
        )
    )
    expect(
      (await c.rebate.getRebate(c.rebater.address, 0)).feeRebate,
      "rebate released on timeout"
    ).to.equal(0)
    witnessed.add("rebate-release-timeout")
  })

  it("[3 legacy] movements, moved-funds sweeps, closing wallets and MovingFunds wallets are discharged after the bundle", async () => {
    c = (await upgraded()).c
    const a = c.movementTx("A", "B")
    await discharges("moving-funds-proof", () =>
      c.legacy
        .connect(c.maintainer)
        .submitMovingFundsProof(
          a.tx,
          inclusion(a.hash),
          c.mains.A,
          c.wallets.A.pkh
        )
    )
    expect((await wallet("A")).state, "A Closing").to.equal(LegacyState.Closing)
    const value = 99000 - SWEEP_FEE
    const sweep = transaction(
      [[c.a3Movement.hash, 0]],
      [{ value: value - SWEEP_FEE, script: p2wpkh(c.wallets.B.pkh) }]
    )
    await discharges("moved-funds-sweep-proof", () =>
      c.legacy
        .connect(c.maintainer)
        .submitMovedFundsSweepProof(sweep.tx, inclusion(sweep.hash), NO_MAIN)
    )
    expect(
      (await c.legacy.movedFundsSweepRequests(outpoint(c.a3Movement.hash, 0)))
        .state,
      "sweep request processed"
    ).to.equal(2)
    await increaseTime(CLOSING_PERIOD + 1)
    await discharges("closing-elapsed", () =>
      c.legacy
        .connect(c.alias)
        .notifyWalletClosingPeriodElapsed(c.wallets.A3.pkh)
    )
    expect((await wallet("A3")).state, "A3 Closed").to.equal(LegacyState.Closed)
    // MovingFunds without a commitment: Y, below dust, closes.
    await discharges("moving-funds-below-dust", () =>
      c.legacy
        .connect(c.alias)
        .notifyMovingFundsBelowDust(c.wallets.Y.pkh, c.mains.Y)
    )
    expect((await wallet("Y")).state, "Y Closing").to.equal(LegacyState.Closing)
  })

  it("[3 legacy] fraud challenges, Live wallets and the in-flight DKG are discharged after the bundle", async () => {
    const { c: w, bundle } = await upgraded()
    c = w
    const ch = c.challenges.preimage
    await discharges("fraud-defeat", () =>
      c.legacy
        .connect(c.alias)
        .defeatFraudChallenge(c.wallets.F.groupPubKey, ch.message, true)
    )
    expect(
      (await c.legacy.fraudChallenges(challengeKey(c.wallets.F, ch.sighash)))
        .resolved,
      "challenge resolved"
    ).to.equal(true)
    await discharges("closeable", () =>
      c.legacy
        .connect(c.alias)
        .notifyWalletCloseable(c.wallets.F.pkh, c.mains.F)
    )
    expect((await wallet("F")).state, "F MovingFunds").to.equal(
      LegacyState.MovingFunds
    )
    // V, the vetoable rebated request: its watchtower veto window (the
    // tower's delay) elapsed during the bundle's 48 h governance delay, as it
    // would with no upgrade. Its timeout route is the one T witnesses.
    const [g1] = c.guardians
    await refused(
      "V's veto window elapsed during the bundle",
      () => c.tower.connect(g1).raiseObjection(c.wallets.R.pkh, c.scripts.V),
      ["Redemption veto delay period expired"]
    )
    const r = context(c, bundle)
    let why = ""
    try {
      await completeZ(r)
    } catch (e) {
      why = reason(e)
    }
    expect(why, "in-flight-registration discharges after the bundle").to.equal(
      ""
    )
    witnessed.add("in-flight-registration")
    expect((await wallet("Z")).state, "Z registered Live").to.equal(
      LegacyState.Live
    )
  })

  it("[3 legacy] every legacy obligation class has a discharge after the bundle", async () => {
    await requireBuilder()
    for (const cls of CLASSES)
      expect(
        cls.routes.some((route) => witnessed.has(route.id)),
        `no post-bundle discharge for class ${cls.id}`
      ).to.equal(true)
  })

  it("[4 G-D] after the bundle every FROST capability is off and every FROST user entrypoint is refused", async () => {
    const { c: w, bundle } = await upgraded()
    c = w
    const r = context(c, bundle)
    const frost = await frostAt(c)
    expect(
      await frost.frostCreationMode(),
      "G-D: creation mode LegacyOpen"
    ).to.equal(Mode.LegacyOpen)
    await expectField(
      r,
      ["self", "frostFunding", "configuration", "addressesEnabled"],
      BigInt(0),
      "G-D: FROST address gate closed"
    )
    await expectField(
      r,
      ["self", "frostFunding", "configuration", "revealEnabled"],
      BigInt(0),
      "G-D: FROST reveal gate closed"
    )
    await expectField(
      r,
      ["self", "frost", "requestsEnabled"],
      BigInt(0),
      "G-D: FROST wallet requests off"
    )
    await expectField(
      r,
      ["self", "frostMovement", "drainEnabled"],
      BigInt(0),
      "G-D: drain off"
    )
    await expectField(
      r,
      ["self", "frostRedemptions", "configuration", "enabled"],
      BigInt(0),
      "G-D: FROST redemptions off"
    )
    expect(
      await frost.frostExposureController(),
      "G-D: no exposure controller installed"
    ).to.equal(ZERO_ADDRESS)
    const controller = await ethers.getContractAt(
      "FrostExposureController",
      bundle.exposureController
    )
    expect(
      await controller.period(),
      "G-D: no exposure budget period open"
    ).to.equal(0)
    expect(
      await controller.custodyCeiling(),
      "G-D: zero custody ceiling"
    ).to.equal(0)
    expect(
      await controller.issuanceCeiling(),
      "G-D: zero issuance ceiling"
    ).to.equal(0)
    const before = await c11Frame(c)
    for (const [name, call] of Object.entries(await userEntrypoints(c)))
      await refused(`G-D: outsider ${name}`, call)
    expect(
      changed(before, await c11Frame(c)),
      "G-D: frame unchanged"
    ).to.deep.equal([])
    // With a registry and one ready FROST wallet installed (governance steps
    // that open nothing), the gates themselves refuse.
    await gov(r, "configureFrostRegistry", [c.frostRegistry.address])
    const x = await frostWallet(r)
    await refused(
      "G-D: FROST wallet request with requests off",
      () => frost.connect(c.outsider).requestNewFrostWallet(),
      ["FROST requests disabled"]
    )
    await refused(
      "G-D: drain commitment with drain off",
      () =>
        c.legacy
          .connect(c.wallets.M.signers[0])
          .submitMovingFundsCommitment(
            c.wallets.M.pkh,
            c.mains.M,
            c.wallets.M.members,
            1,
            [x.label]
          ),
      ["FROST drain disabled"]
    )
  })

  for (const name of Object.keys(RECIPES))
    it(`[5 #57] ${name}: the council succeeds through BridgeGovernance at once; everyone else is refused`, async () => {
      const { c: w, bundle } = await upgraded()
      c = w
      const r = context(c, bundle)
      await setup(r, name)
      const args = await RECIPES[name].args(r)
      const data = await calldata(name, args)
      const before = await c11Frame(c)
      for (const [who, s] of Object.entries({
        outsider: c.outsider,
        deployer: c.deployer,
        "historical deployer": c.historicalDeployer,
      }))
        await refused(
          `${name}: the ${who} through BridgeGovernance`,
          () => s.sendTransaction({ to: bundle.bridgeGovernance, data }),
          [OWNABLE_REASON]
        )
      for (const [who, s] of Object.entries({
        council: c.council,
        outsider: c.outsider,
      }))
        await refused(
          `${name}: the ${who} directly on the Bridge`,
          () => s.sendTransaction({ to: c.proxy.address, data }),
          GOVERNANCE_REASONS
        )
      expect(
        changed(before, await c11Frame(c)),
        `${name}: frame unchanged by refusals`
      ).to.deep.equal([])
      await gov(r, name, args)
      await RECIPES[name].effect(r)
    })

  it("[5 runbook] with RebateStaking still set, the installs and open gates refuse a FROST reveal (D20 precondition)", async () => {
    const { c: w, bundle } = await upgraded()
    c = w
    const r = context(c, bundle)
    const frost = await frostAt(c)
    await gov(r, "configureFrostRegistry", [c.frostRegistry.address])
    await gov(r, "configureFrostFunding", [
      bundle.verifier,
      await codehash(bundle.verifier),
      RECORD,
      GENESIS,
    ])
    const controller = await ethers.getContractAt(
      "FrostExposureController",
      bundle.exposureController
    )
    await controller
      .connect(c.council)
      .openBudgetPeriod(MAX_UINT64, MAX_UINT64, BUDGET_RECORD)
    await gov(r, "installFrostExposureController", [bundle.exposureController])
    await gov(r, "setFrostFundingGates", [true, true])
    const y = await frostWallet(r, 0x3200)
    const { t, fundingTx } = await frostReveal(r, y, 200000)
    await refused(
      "runbook without the unset: FROST reveal refused",
      () => frost.connect(c.alias).revealFrostDeposit(t, fundingTx.tx, 0),
      ["FROST rebate unsupported"]
    )
  })

  it("[5 runbook] activation through the production route: retire rebated redemptions, unset RebateStaking, install registry, verifier and controller, open the gates; a FROST reveal passes the rebate check", async () => {
    const { c: w, bundle } = await upgraded()
    c = w
    const r = context(c, bundle)
    const frost = await frostAt(c)
    const admission = await ethers.getContractAt(
      "FrostDepositAdmission",
      c.proxy.address
    )
    const { wallet: x } = await activate(r)
    expect(
      await c.legacy.getRebateStaking(),
      "D20: RebateStaking unset"
    ).to.equal(ZERO_ADDRESS)
    const { t, fundingTx } = await frostReveal(r, x, 200000)
    await expect(
      frost.connect(c.alias).revealFrostDeposit(t, fundingTx.tx, 0),
      "runbook: a FROST reveal passes the rebate check"
    ).to.emit(admission, "FrostDepositRevealed")
  })

  it("[5 emergency] close the gates and contain through the production route", async () => {
    const { c: w, bundle } = await upgraded()
    c = w
    const r = context(c, bundle)
    const frost = await frostAt(c)
    const { wallet: x, controller } = await activate(r, false)
    await gov(r, "setFrostFundingGates", [false, false])
    await controller
      .connect(c.council)
      .contain(ethers.utils.id("C11 emergency"))
    await expectField(
      r,
      ["self", "frostFunding", "configuration", "addressesEnabled"],
      BigInt(0),
      "emergency: address gate closed"
    )
    await expectField(
      r,
      ["self", "frostFunding", "configuration", "revealEnabled"],
      BigInt(0),
      "emergency: reveal gate closed"
    )
    expect(await controller.contained(), "emergency: contained").to.equal(true)
    const blocked = await frostTerms(r, x, 200000)
    const fundingTx = transaction(
      [[ethers.utils.id("C11 emergency funding"), 0]],
      [{ value: 200000, script: p2tr(x.q) }]
    )
    await refused("emergency: FROST reveal refused", () =>
      frost.connect(c.alias).revealFrostDeposit(blocked, fundingTx.tx, 0)
    )
  })

  it("[6 bytecode, #56] runtime code is the artifact with every link substituted; every library has code; sizes within 24,576 bytes", async () => {
    const { c: w, bundle } = await upgraded()
    c = w
    const visited = new Set<string>()
    const check = async (
      label: string,
      address: string,
      qualified: string,
      libraries: Record<string, string>,
      isLibrary: boolean
    ) => {
      if (visited.has(qualified)) return
      visited.add(qualified)
      const artifact = await artifacts.readArtifact(qualified)
      const immutables = await immutableReferences(
        artifact.sourceName,
        artifact.contractName
      )
      let expected = artifact.deployedBytecode.toLowerCase()
      for (const [file, libs] of Object.entries(
        artifact.deployedLinkReferences
      ))
        for (const [lib, positions] of Object.entries(libs)) {
          const at = libraries[lib]
          expect(
            at,
            `bundle reports the address of library ${lib} (linked by ${label})`
          ).to.be.a("string")
          expect(
            await ethers.provider.getCode(at),
            `linked library has code: ${lib}`
          ).to.not.equal("0x")
          for (const p of positions)
            expected =
              expected.slice(0, 2 + p.start * 2) +
              at.slice(2).toLowerCase() +
              expected.slice(2 + (p.start + p.length) * 2)
          await check(lib, at, `${file}:${lib}`, libraries, true)
        }
      expect(
        /__\$[0-9a-f]{34}\$__/.test(expected),
        `${label}: no unlinked placeholder left`
      ).to.equal(false)
      if (isLibrary) {
        expect(
          expected.slice(0, 44),
          `${label}: library call-protection prefix`
        ).to.equal(`0x73${"0".repeat(40)}`)
        expected = `0x73${address.slice(2).toLowerCase()}${expected.slice(44)}`
      }
      let actual = (await ethers.provider.getCode(address)).toLowerCase()
      // Immutables: masked in both, each reference set must be consistent.
      for (const [id, refs] of Object.entries(
        immutables as Record<string, { start: number; length: number }[]>
      )) {
        const values = refs.map((x) =>
          actual.slice(2 + x.start * 2, 2 + (x.start + x.length) * 2)
        )
        expect(
          new Set(values).size,
          `${label}: immutable ${id} consistent`
        ).to.equal(1)
        for (const x of refs) {
          const mask = "00".repeat(x.length)
          actual =
            actual.slice(0, 2 + x.start * 2) +
            mask +
            actual.slice(2 + (x.start + x.length) * 2)
          expected =
            expected.slice(0, 2 + x.start * 2) +
            mask +
            expected.slice(2 + (x.start + x.length) * 2)
        }
      }
      // Metadata: the CBOR tail (its length is the last two bytes).
      const tail = 2 * (parseInt(expected.slice(-4), 16) + 2)
      expect(
        actual.slice(-tail),
        `${label}: metadata equals the artifact's`
      ).to.equal(expected.slice(-tail))
      expect(
        actual,
        `${label}: runtime code equals the artifact with links substituted`
      ).to.equal(expected)
      expect(
        (actual.length - 2) / 2,
        `${label}: runtime size within ${MAX_CODE} bytes`
      ).to.be.at.most(MAX_CODE)
    }
    await check(
      "Bridge implementation",
      bundle.bridgeImplementation,
      "contracts/bridge/Bridge.sol:Bridge",
      bundle.libraries,
      false
    )
    expect(
      Object.keys(bundle.libraries),
      "FrostBridge linked (#56)"
    ).to.include("FrostBridge")
    await check(
      "BridgeGovernance",
      bundle.bridgeGovernance,
      "contracts/bridge/BridgeGovernance.sol:BridgeGovernance",
      {
        BridgeGovernanceParameters: bundle.bridgeGovernanceParameters,
      },
      false
    )
    await check(
      "FrostVerifier",
      bundle.verifier,
      "contracts/frost/FrostVerifier.sol:FrostVerifier",
      {},
      false
    )
    await check(
      "FrostExposureController",
      bundle.exposureController,
      "contracts/frost/FrostExposureController.sol:FrostExposureController",
      {},
      false
    )
    const controller = await ethers.getContractAt(
      "FrostExposureController",
      bundle.exposureController
    )
    expect(
      await controller.bridge(),
      "controller immutable bridge is the proxy"
    ).to.equal(c.proxy.address)
  })

  it("[7 verifier] installed by code hash through the production route; a mismatched hash is refused; replacement is a recorded fact", async () => {
    const { c: w, bundle } = await upgraded()
    c = w
    const r = context(c, bundle)
    const verifierArtifact = await artifacts.readArtifact("FrostVerifier")
    const expectedHash = ethers.utils.keccak256(
      verifierArtifact.deployedBytecode
    )
    expect(
      await codehash(bundle.verifier),
      "bundle verifier is the FrostVerifier artifact"
    ).to.equal(expectedHash)
    const before = await c11Frame(c)
    for (const [label, args] of Object.entries({
      "hash of other code": [
        bundle.verifier,
        await codehash(bundle.exposureController),
        RECORD,
        GENESIS,
      ],
      "zero hash": [
        bundle.verifier,
        ethers.constants.HashZero,
        RECORD,
        GENESIS,
      ],
      "verifier hash at another address": [
        bundle.exposureController,
        expectedHash,
        RECORD,
        GENESIS,
      ],
    })) {
      const data = await calldata("configureFrostFunding", args)
      await refused(
        `mismatched verifier code hash refused (${label})`,
        () => c.council.sendTransaction({ to: bundle.bridgeGovernance, data }),
        ["FROST funding installation"]
      )
    }
    expect(
      changed(before, await c11Frame(c)),
      "frame unchanged by refused installs"
    ).to.deep.equal([])
    await gov(r, "configureFrostFunding", [
      bundle.verifier,
      expectedHash,
      RECORD,
      GENESIS,
    ])
    await expectField(
      r,
      ["self", "frostFunding", "configuration", "verifierCodeHash"],
      BigInt(expectedHash),
      "verifier code hash recorded"
    )
    // Replacement through the production route.
    const another = await (
      await ethers.getContractFactory("FrostVerifier")
    ).deploy()
    let replaced = ""
    try {
      await (
        await c.council.sendTransaction({
          to: bundle.bridgeGovernance,
          data: await calldata("configureFrostFunding", [
            another.address,
            expectedHash,
            RECORD,
            GENESIS,
          ]),
        })
      ).wait()
    } catch (e) {
      replaced = reason(e)
    }
    if (replaced !== "") {
      // FACT: the source has no replacement; a second install is refused.
      expect(
        replaced,
        "FACT: verifier replacement refused by the source"
      ).to.equal("FROST funding already installed")
      await expectField(
        r,
        ["self", "frostFunding", "configuration", "verifier"],
        BigInt(bundle.verifier),
        "verifier unchanged"
      )
    } else {
      await expectField(
        r,
        ["self", "frostFunding", "configuration", "verifier"],
        BigInt(another.address),
        "replacement installed"
      )
      const data = await calldata("configureFrostFunding", [
        bundle.verifier,
        expectedHash,
        RECORD,
        GENESIS,
      ])
      await refused(
        "outsider replacement refused at BridgeGovernance",
        () => c.outsider.sendTransaction({ to: bundle.bridgeGovernance, data }),
        [OWNABLE_REASON]
      )
      await refused(
        "outsider replacement refused at the Bridge",
        () => c.outsider.sendTransaction({ to: c.proxy.address, data }),
        GOVERNANCE_REASONS
      )
    }
  })

  it("[8 rollback] before any FROST state, a timelocked rollback to the 40a11d1d implementation restores the pre-bundle frame and legacy service", async () => {
    const { c: w, bundle, preFrame } = await upgraded()
    c = w
    expect(
      bundle.rollbackImplementation,
      "rollback target is the pre-bundle implementation"
    ).to.equal(c.preBundleImplementation)
    await runStep(c, {
      kind: "timelock",
      actions: [
        {
          target: c.admin.address,
          value: 0,
          data: c.admin.interface.encodeFunctionData("upgrade", [
            c.proxy.address,
            bundle.rollbackImplementation,
          ]),
        },
      ],
      predecessor: ethers.constants.HashZero,
      salt: ethers.utils.id("C11 rollback"),
      description: "rollback",
    })
    const allowed = await allowedDifferences(false)
    delete allowed["eip1967:implementation"]
    const after = await c11Frame(c)
    expect(
      changed(preFrame, after)
        .filter((k) => !allowed[k])
        .map((k) => `${k}: ${preFrame[k]} -> ${after[k]}`),
      "rollback frame equals the pre-bundle frame (except the governance address)"
    ).to.deep.equal([])
    const sweep = transaction(
      [
        [c.deposits.d1.hash, 0],
        [c.deposits.d2.hash, 0],
      ],
      [{ value: 50000 + 60000 - SWEEP_FEE, script: p2wpkh(c.wallets.D.pkh) }]
    )
    let why = ""
    try {
      await (
        await c.legacy
          .connect(c.maintainer)
          .submitDepositSweepProof(
            sweep.tx,
            inclusion(sweep.hash),
            NO_MAIN,
            ZERO_ADDRESS
          )
      ).wait()
    } catch (e) {
      why = reason(e)
    }
    expect(why, "legacy deposit sweep after the rollback").to.equal("")
  })
})
