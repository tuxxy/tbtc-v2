/* eslint-disable no-await-in-loop, no-restricted-syntax, no-continue, @typescript-eslint/no-explicit-any, @typescript-eslint/no-loop-func */
// Shared fixtures, recipes and probes of the C-11a cases (tuxxy/tbtc-v2#58,
// #57, #56). The cases are in Frost.Upgrade.test.ts and
// Frost.Upgrade.Governance.test.ts; see the first for the invariants.
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
  initializedKey,
  initializedVersion,
  bundleBridgeCalls,
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

// Re-exported for the case files.
export {
  BUILDER_FILE,
  BUILDER_SKIP_ENV,
  BUILDER_TAG,
  Builder,
  C11World,
  CLASSES,
  FrostUpgradeBundle,
  FrostUpgradeStep,
  GOVERNANCE_REASONS,
  LegacyName,
  LegacyState,
  MAX_CODE,
  MAX_UINT64,
  Mode,
  NO_MAIN,
  OWNABLE_REASON,
  RED_AMOUNT,
  SWEEP_FEE,
  TYPE,
  ZERO,
  abiOf,
  allowedDifferences,
  c11Frame,
  c11World,
  challengeKey,
  changed,
  defaultArguments,
  dkg,
  execute,
  frostSlots,
  governanceGuarded,
  implementationOf,
  inclusion,
  increaseTime,
  inputs,
  loadBuilder,
  newInitializers,
  initializedKey,
  initializedVersion,
  bundleBridgeCalls,
  now,
  outpoint,
  p2tr,
  p2wpkh,
  readField,
  reason,
  redemptionKey,
  runStep,
  runSteps,
  schedule,
  transaction,
  unmappedBaseViews,
}

export const GENESIS = ethers.utils.id("C11 synthetic regtest domain")
export const RECORD = ethers.utils.id("UNQUALIFIED C11 local test record")
export const EVIDENCE = ethers.utils.id("C11 legacy transition evidence")
export const ABORT_RECORD = ethers.utils.id("C11 reviewed abort policy")
export const MANIFEST = ethers.utils.id("C11 cutover manifest")
export const BUDGET_RECORD = ethers.utils.id("C11 test budget; D-10 OPEN")
export const ZERO_ADDRESS = ethers.constants.AddressZero
export const REDEMPTION_TIMEOUT = 5 * 86400
export const CLOSING_PERIOD = 7 * 86400
/// The entrypoints #57 names; the derivation must find at least these.
export const ISSUE_57 = [
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
export async function requireBuilder(): Promise<Builder> {
  builder = await loadBuilder()
  expect(builder, `C-11 bundle builder present: ${BUILDER_FILE}`).to.not.equal(
    null
  )
  return builder as Builder
}

/// The bundle deployed by the builder (contracts only, no step executed).
export const deployedFixture = deployments.createFixture(async () => {
  const c = await c11World()
  const preFrame = await c11Frame(c)
  const bundle = await (builder as Builder).deployFrostBridgeUpgrade(
    hre,
    inputs(c)
  )
  return { c, bundle, preFrame }
})
/// The bundle executed: every step, as the council stand-in.
export const upgradedFixture = deployments.createFixture(async () => {
  const d = await deployedFixture()
  await runSteps(d.c, d.bundle.steps)
  return d
})
/// A fixture call whose own failures surface as `label`; named assertions
/// raised inside it (a failing bundle step) pass through.
export async function named<T>(
  label: string,
  fixture: () => Promise<T>
): Promise<T> {
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
export const deployed = () => named("C-11 bundle deploys", deployedFixture)
export const upgraded = () => named("C-11 bundle deploys", upgradedFixture)

/// Context for the governance cases.
export type Run = {
  c: C11World
  bundle: FrostUpgradeBundle
  bg: Contract
  frost: Contract
}
export function context(c: C11World, bundle: FrostUpgradeBundle): Run {
  return {
    c,
    bundle,
    bg: new ethers.Contract(bundle.bridgeGovernance, [], c.council),
    frost: new ethers.Contract(c.proxy.address, [], ethers.provider),
  }
}
export async function frostAt(c: C11World) {
  return ethers.getContractAt("IFrostBridge", c.proxy.address)
}
/// The FROST/Bridge fragment of a governance entrypoint by name.
export async function fragment(name: string) {
  for (const a of ["IFrostBridge", "Bridge"]) {
    const i = new ethers.utils.Interface(await abiOf(a))
    const f = Object.values(i.functions).find((x) => x.name === name)
    if (f) return { i, f }
  }
  throw Error(`no fragment ${name}`)
}
/// Calldata of a Bridge governance entrypoint; a D22 forwarder has the same
/// name and types, so the same calldata addresses it on BridgeGovernance.
export async function calldata(name: string, args: unknown[]) {
  const { i, f } = await fragment(name)
  return i.encodeFunctionData(f, args)
}
/// The council stand-in through the new BridgeGovernance, as a named step.
export async function gov(r: Run, name: string, args: unknown[]) {
  let why = ""
  try {
    await (
      await r.c.council.sendTransaction({
        to: r.bundle.bridgeGovernance,
        data: await calldata(name, args),
      })
    ).wait()
  } catch (e) {
    why = reason(e)
  }
  expect(why, `council through BridgeGovernance: ${name}`).to.equal("")
}
/// A refused call: reverted with one of `reasons` (any reason when empty).
export async function refused(
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
export const codehash = async (a: string) =>
  ethers.utils.keccak256(await ethers.provider.getCode(a))

// ---------------------------------------------------------------------------
// Valid-call recipes for every governance-guarded FROST entrypoint. The
// derivation case fails if a derived entrypoint has none.
// ---------------------------------------------------------------------------
/// One forwarder call of a recipe: its arguments, the Bridge event it must
/// emit with exactly these argument values (by name), and the storage or
/// view effect of every argument.
export type Call = {
  args: unknown[]
  event: string
  values: Record<string, unknown>
  check: (r: Run) => Promise<void>
}
export type Recipe = {
  setup?: (string | ((r: Run) => Promise<void>))[]
  /// The first call's arguments are the ones the refusal checks use.
  calls: (r: Run) => Promise<Call[]>
}
export const field = (r: Run, p: string[]) => readField(r.c.proxy.address, p)
export const expectField = async (
  r: Run,
  p: string[],
  v: bigint | string,
  label: string
) =>
  expect((await field(r, p)).toString(), label).to.equal(BigInt(v).toString())

/// Completes the in-flight legacy DKG Z through the real registry.
export async function completeZ(r: Run) {
  const d = dkg(r.c)
  const z = await d.submit(r.c.z.key)
  await d.challengeOver()
  await r.c.registry.connect(z.submitter).approveDkgResult(z.result)
  return z
}

/// A FROST wallet through the registry FIXTURE callbacks (C-11b is the real
/// registry stack); ready, so Live.
export async function frostWallet(r: Run, scalar = 0x3100) {
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
export type FrostWallet = Awaited<ReturnType<typeof frostWallet>>

let blinding = 0
export async function frostTerms(r: Run, x: FrostWallet, amount: number) {
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
export async function frostReveal(r: Run, x: FrostWallet, amount: number) {
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
export async function retireRebatedRedemptions(r: Run) {
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
export async function activate(r: Run, retire = true) {
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
export async function fundFrostWallet(r: Run, x: FrostWallet, amount: number) {
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
const QUARANTINE_REASON = ethers.utils.id("C11 quarantine reason")
const QUARANTINE_EVIDENCE = ethers.utils.id("C11 quarantine evidence")
const fieldIs = (r: Run, p: string[], v: unknown, label: string) =>
  expectField(r, p, BigInt(v as any), label)
/// An on/off switch: on, then off, each through BridgeGovernance.
function toggle(event: string, p: string[]) {
  return async (): Promise<Call[]> =>
    [true, false].map((on) => ({
      args: [on],
      event,
      values: { enabled: on },
      check: (r: Run) => fieldIs(r, p, on ? 1 : 0, `${p.join(".")} ${on}`),
    }))
}
const GATES = ["self", "frostFunding", "configuration"]
const REDEMPTIONS = ["self", "frostRedemptions", "configuration"]
/// Valid calls of every governance-guarded FROST entrypoint. Same-typed
/// arguments get distinct values and on/off switches run both ways, so a
/// forwarder that swaps or drops an argument fails at a named check.
export const RECIPES: Record<string, Recipe> = {
  configureFrostRegistry: {
    calls: async (r) => [
      {
        args: [r.c.frostRegistry.address],
        event: "FrostRegistryConfigured",
        values: { registry: r.c.frostRegistry.address },
        check: async () =>
          expect(
            await (await frostAt(r.c)).frostRegistry(),
            "registry bound"
          ).to.equal(r.c.frostRegistry.address),
      },
    ],
  },
  setFrostRequestsEnabled: {
    setup: ["configureFrostRegistry"],
    calls: toggle("FrostRequestsEnabled", ["self", "frost", "requestsEnabled"]),
  },
  configureFrostFunding: {
    calls: async (r) => {
      const hash = await codehash(r.bundle.verifier)
      return [
        {
          args: [r.bundle.verifier, hash, RECORD, GENESIS],
          event: "FrostFundingInstalled",
          values: {
            verifier: r.bundle.verifier,
            runtimeHash: hash,
            qualificationRecord: RECORD,
            bitcoinGenesis: GENESIS,
          },
          check: async () => {
            await fieldIs(
              r,
              [...GATES, "verifier"],
              r.bundle.verifier,
              "verifier"
            )
            await fieldIs(
              r,
              [...GATES, "verifierCodeHash"],
              hash,
              "verifier code hash"
            )
            await fieldIs(
              r,
              [...GATES, "qualificationRecord"],
              RECORD,
              "qualification record"
            )
            await fieldIs(
              r,
              [...GATES, "bitcoinGenesis"],
              GENESIS,
              "funding genesis"
            )
          },
        },
      ]
    },
  },
  installFrostExposureController: {
    calls: async (r) => [
      {
        args: [r.bundle.exposureController],
        event: "FrostExposureControllerInstalled",
        values: { controller: r.bundle.exposureController },
        check: async () =>
          expect(
            await (await frostAt(r.c)).frostExposureController(),
            "controller installed"
          ).to.equal(r.bundle.exposureController),
      },
    ],
  },
  setFrostFundingGates: {
    setup: ["configureFrostFunding", "installFrostExposureController"],
    calls: async () =>
      [
        [true, false],
        [false, true],
        [false, false],
      ].map(([addresses, reveal]) => ({
        args: [addresses, reveal],
        event: "FrostFundingGatesChanged",
        values: { addressesEnabled: addresses, revealEnabled: reveal },
        check: async (r: Run) => {
          await fieldIs(
            r,
            [...GATES, "addressesEnabled"],
            addresses ? 1 : 0,
            `address gate ${addresses}`
          )
          await fieldIs(
            r,
            [...GATES, "revealEnabled"],
            reveal ? 1 : 0,
            `reveal gate ${reveal}`
          )
        },
      })),
  },
  setFrostDrainEnabled: {
    setup: ["installFrostExposureController"],
    calls: toggle("FrostDrainEnabled", [
      "self",
      "frostMovement",
      "drainEnabled",
    ]),
  },
  configureFrostRedemptions: {
    calls: async (r) => [
      {
        args: [GENESIS, 6, 100, r.c.tower.address, EVIDENCE],
        event: "FrostRedemptionsConfigured",
        values: {
          genesis: GENESIS,
          finalityBlocks: 6,
          maximumCertificateBlocks: 100,
          watchtower: r.c.tower.address,
          legacyTransitionEvidence: EVIDENCE,
        },
        check: async () => {
          await fieldIs(
            r,
            [...REDEMPTIONS, "bitcoinGenesis"],
            GENESIS,
            "redemption genesis"
          )
          await fieldIs(
            r,
            [...REDEMPTIONS, "finalityBlocks"],
            6,
            "finality blocks"
          )
          await fieldIs(
            r,
            [...REDEMPTIONS, "maximumCertificateBlocks"],
            100,
            "maximum certificate blocks"
          )
          await fieldIs(
            r,
            [...REDEMPTIONS, "watchtower"],
            r.c.tower.address,
            "redemption watchtower"
          )
          await fieldIs(
            r,
            [...REDEMPTIONS, "legacyTransitionEvidence"],
            EVIDENCE,
            "transition evidence"
          )
        },
      },
    ],
  },
  setFrostRedemptionsEnabled: {
    setup: ["configureFrostFunding", "configureFrostRedemptions"],
    calls: toggle("FrostRedemptionsEnabled", [...REDEMPTIONS, "enabled"]),
  },
  setFrostDepositReservationMargin: {
    calls: async (r) =>
      [3600, 12345].map((margin) => ({
        args: [margin],
        event: "FrostDepositReservationMarginSet",
        values: { margin },
        check: async () =>
          expect(
            await (await frostAt(r.c)).frostDepositReservationMargin(),
            `margin ${margin}`
          ).to.equal(margin),
      })),
  },
  beginLegacyDkgDrain: {
    calls: async (r) => [
      {
        args: [],
        event: "LegacyDkgDrainBegun",
        values: {},
        check: async () =>
          expect(
            await (await frostAt(r.c)).frostCreationMode(),
            "LegacyDraining"
          ).to.equal(Mode.LegacyDraining),
      },
    ],
  },
  abortLegacyDkgDrain: {
    setup: ["beginLegacyDkgDrain"],
    calls: async (r) => [
      {
        args: [ABORT_RECORD],
        event: "LegacyDkgDrainAborted",
        values: { policyRecord: ABORT_RECORD },
        check: async () =>
          expect(
            await (await frostAt(r.c)).frostCreationMode(),
            "LegacyOpen again"
          ).to.equal(Mode.LegacyOpen),
      },
    ],
  },
  completeFrostCutover: {
    setup: [
      "configureFrostRegistry",
      "beginLegacyDkgDrain",
      async (r) => {
        await completeZ(r)
      },
    ],
    calls: async (r) => [
      {
        args: [MANIFEST],
        event: "FrostCutoverCompleted",
        values: { manifestHash: MANIFEST },
        check: async () => {
          const frost = await frostAt(r.c)
          expect(await frost.frostCreationMode(), "FrostOnly").to.equal(
            Mode.FrostOnly
          )
          expect(await frost.frostCutoverManifest(), "manifest").to.equal(
            MANIFEST
          )
        },
      },
    ],
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
    calls: async (r) => {
      const { id, version } = quarantined!
      return [
        {
          args: [id, version, QUARANTINE_REASON, QUARANTINE_EVIDENCE],
          event: "FrostWalletQuarantined",
          values: {
            walletId: id,
            stateVersion: version + 1,
            reasonHash: QUARANTINE_REASON,
            evidenceHash: QUARANTINE_EVIDENCE,
          },
          check: async () => {
            const record = await (
              await frostAt(r.c)
            ).frostWalletQuarantine(id, version + 1)
            expect(
              record.previousStateVersion,
              "quarantine previous version"
            ).to.equal(version)
            expect(record.stateVersion, "quarantine version").to.equal(
              version + 1
            )
            expect(record.reasonHash, "quarantine reason").to.equal(
              QUARANTINE_REASON
            )
            expect(record.evidenceHash, "quarantine evidence").to.equal(
              QUARANTINE_EVIDENCE
            )
          },
        },
      ]
    },
  },
}

/// Every event the Bridge's linked FROST code can emit, by name.
let frostEvents: any
async function frostEventInterface() {
  if (frostEvents) return frostEvents
  const fragments = new Map<string, string>()
  for (const name of await artifacts.getAllFullyQualifiedNames()) {
    if (!/^contracts\/(frost|bridge)\//.test(name)) continue
    for (const f of (await artifacts.readArtifact(name)).abi)
      if (f.type === "event") {
        const e = ethers.utils.EventFragment.from(f)
        fragments.set(e.format(), e.format("full"))
      }
  }
  frostEvents = new ethers.utils.Interface(
    [...fragments.values()].map((x) => `event ${x.replace(/^event /, "")}`)
  )
  return frostEvents
}
function normal(v: unknown) {
  if (typeof v === "string") return v.toLowerCase()
  if (ethers.BigNumber.isBigNumber(v)) return v.toString()
  return String(v)
}

/// A recipe call through BridgeGovernance by the council: it succeeds, the
/// Bridge emits `event` once with exactly the call's values, and `check`
/// holds.
export async function forward(r: Run, name: string, call: Call) {
  let why = ""
  let receipt: any
  try {
    receipt = await (
      await r.c.council.sendTransaction({
        to: r.bundle.bridgeGovernance,
        data: await calldata(name, call.args),
      })
    ).wait()
  } catch (e) {
    why = reason(e)
  }
  expect(
    why,
    `council through BridgeGovernance: ${name}(${call.args.join(", ")})`
  ).to.equal("")
  const events = await frostEventInterface()
  const emitted = receipt.logs
    .filter(
      (l: any) => l.address.toLowerCase() === r.c.proxy.address.toLowerCase()
    )
    .map((l: any) => {
      try {
        return events.parseLog(l)
      } catch (e) {
        return undefined
      }
    })
    .filter((e: any) => e?.name === call.event)
  expect(
    emitted.length,
    `${name}: the Bridge emits ${call.event} once`
  ).to.equal(1)
  for (const [arg, value] of Object.entries(call.values))
    expect(
      normal(emitted[0].args[arg]),
      `${name}(${call.args.join(", ")}): ${
        call.event
      }.${arg} carries the argument`
    ).to.equal(normal(value))
  await call.check(r)
}

/// Runs a recipe's setup through the production route.
export async function setup(r: Run, name: string) {
  for (const s of RECIPES[name].setup ?? []) {
    if (typeof s === "string") {
      await setup(r, s)
      await gov(r, s, (await RECIPES[s].calls(r))[0].args)
    } else await s(r)
  }
}

/// FROST user entrypoints, called by an outsider (property 4 and the window).
export async function userEntrypoints(c: C11World) {
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
export async function frostLikeTerms(c: C11World) {
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
export async function probeOutsider(
  r: Run,
  guarded: any[],
  label: string,
  bridgeCalls: string[] = []
) {
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
  // An outsider replaying any call the bundle makes into the Bridge (an
  // upgradeAndCall payload, a council or Timelock call to the proxy) is
  // refused: no front-running of an initializer or configuration.
  for (const data of bridgeCalls)
    await refused(
      `${label}: outsider replays bundle call ${data.slice(0, 10)}`,
      () => r.c.outsider.sendTransaction({ to: r.c.proxy.address, data })
    )
  for (const [name, call] of Object.entries(await userEntrypoints(r.c)))
    await refused(`${label}: outsider ${name}`, call)
  expect(
    changed(before, await c11Frame(r.c)),
    `${label}: frame unchanged by outsider calls`
  ).to.deep.equal([])
}

/// ProxyAdmin, Timelock, Bridge and BridgeGovernance attempts by `who`.
export async function attemptAuthority(
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
export const buildInfos = new Map<string, any>()
export async function immutableReferences(source: string, name: string) {
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
