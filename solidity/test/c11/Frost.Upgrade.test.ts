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
import hre, { artifacts, ethers } from "hardhat"
import { expect } from "chai"
import {
  BUILDER_SKIP_ENV,
  BUILDER_TAG,
  C11World,
  CLASSES,
  CLOSING_PERIOD,
  FrostUpgradeStep,
  GENESIS,
  GOVERNANCE_REASONS,
  ISSUE_57,
  LegacyName,
  LegacyState,
  MAX_CODE,
  Mode,
  NO_MAIN,
  OWNABLE_REASON,
  RECIPES,
  RECORD,
  REDEMPTION_TIMEOUT,
  RED_AMOUNT,
  SWEEP_FEE,
  ZERO_ADDRESS,
  abiOf,
  allowedDifferences,
  attemptAuthority,
  bundleBridgeCalls,
  c11Frame,
  c11World,
  calldata,
  challengeKey,
  changed,
  codehash,
  completeZ,
  context,
  deployed,
  execute,
  expectField,
  field,
  frostAt,
  frostSlots,
  frostWallet,
  gov,
  governanceGuarded,
  immutableReferences,
  implementationOf,
  inclusion,
  increaseTime,
  initializedKey,
  initializedVersion,
  inputs,
  named,
  outpoint,
  p2wpkh,
  probeOutsider,
  reason,
  redemptionKey,
  refused,
  requireBuilder,
  runStep,
  runSteps,
  schedule,
  setup,
  transaction,
  unmappedBaseViews,
  upgraded,
  userEntrypoints,
} from "./c11-cases"

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
      if (upgradedAt >= 0)
        await probeOutsider(
          r,
          guarded,
          `after step ${i}`,
          bundleBridgeCalls(c, bundle.steps)
        )
    })
    expect(upgradedAt, "the bundle upgrades the implementation").to.be.at.least(
      0
    )
  })

  it("[2 initialization] a reinitializer (detected by the _initialized slot) uses an unused version, runs atomically with the upgrade and refuses repeat, bare and wrong-address calls; without one no FROST field is set", async () => {
    const { c: w, bundle } = await deployed()
    c = w
    const proxyAdmin = c.admin.interface
    const upgradeCalls = bundle.steps
      .flatMap((s) => (s.kind === "timelock" ? s.actions : []))
      .filter((a) => a.target.toLowerCase() === c.admin.address.toLowerCase())
      .map((a) => proxyAdmin.parseTransaction({ data: a.data }))
    expect(
      upgradeCalls.length,
      "the bundle has a ProxyAdmin upgrade"
    ).to.be.greaterThan(0)
    const payloads = upgradeCalls
      .filter((call) => call.name === "upgradeAndCall" && call.args[2] !== "0x")
      .map((call) => call.args[2] as string)
    const bridge = new ethers.utils.Interface(await abiOf("Bridge"))
    // Before the bundle: each payload is a Bridge function; with any address
    // argument wrong (0x0, an EOA) the timelocked upgradeAndCall is refused;
    // the bare implementation refuses it.
    const before = await implementationOf(c)
    for (const payload of payloads) {
      let f: any
      try {
        f = bridge.getFunction(payload.slice(0, 10))
      } catch (e) {
        f = undefined
      }
      expect(
        f,
        `upgradeAndCall payload ${payload.slice(0, 10)} is a Bridge function`
      ).to.not.equal(undefined)
      const args = bridge.decodeFunctionData(f, payload)
      for (const [index, input] of f.inputs.entries()) {
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
                  bridge.encodeFunctionData(f, mutated),
                ]),
              },
            ],
            predecessor: ethers.constants.HashZero,
            salt: ethers.utils.id(`C11 wrong ${index} ${wrong}`),
            description: "wrong address",
          }
          await refused(
            `wrong-address initialization refused (${f.name} argument ${index} = ${wrong})`,
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
          data: payload,
        })
      )
    }
    // The bundle, step by step: where the implementation and the version change.
    const version = await initializedVersion(c)
    let upgradeStep = -1
    let initStep = -1
    for (const [i, step] of bundle.steps.entries()) {
      await runSteps(c, [step])
      if (
        upgradeStep < 0 &&
        (await implementationOf(c)) ===
          ethers.utils.getAddress(bundle.bridgeImplementation)
      )
        upgradeStep = i
      if (initStep < 0 && (await initializedVersion(c)) !== version)
        initStep = i
    }
    if (initStep < 0) {
      expect(
        payloads,
        "no reinitializer: upgradeAndCall carries no call"
      ).to.deep.equal([])
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
    const next = await initializedVersion(c)
    expect(
      next,
      `reinitializer version unused (> 5 and > ${version})`
    ).to.be.greaterThan(Math.max(5, version))
    expect(
      initStep,
      "reinitializer runs atomically with the upgrade (same step)"
    ).to.equal(upgradeStep)
    expect(
      payloads.length,
      "reinitializer runs atomically through upgradeAndCall"
    ).to.be.greaterThan(0)
    for (const payload of payloads)
      for (const s of [c.council, c.outsider])
        await refused("repeated initialization refused", () =>
          s.sendTransaction({ to: c.proxy.address, data: payload })
        )
  })

  it("[1, 3 side effects] the bundle's steps emit only the named events; the governance delay, Timelock delay and roles are unchanged", async () => {
    const { c: w, bundle } = await deployed()
    c = w
    const newGovernance = await ethers.getContractAt(
      "BridgeGovernance",
      bundle.bridgeGovernance
    )
    expect(
      (await newGovernance.governanceDelays(0)).toString(),
      "new BridgeGovernance governance delay equals the old one's"
    ).to.equal((await c.oldGovernance.governanceDelays(0)).toString())
    const minDelay = (await c.timelock.getMinDelay()).toString()
    const from = (await ethers.provider.getBlockNumber()) + 1
    await runSteps(c, bundle.steps)
    const logs = await ethers.provider.getLogs({
      fromBlock: from,
      toBlock: "latest",
    })
    const emitters: Record<
      string,
      { label: string; abi: string[]; allowed: string[] }
    > = {
      [c.proxy.address.toLowerCase()]: {
        label: "Bridge",
        abi: ["Bridge", "TransparentUpgradeableProxy"],
        allowed: ["Upgraded", "Initialized", "GovernanceTransferred"],
      },
      [c.oldGovernance.address.toLowerCase()]: {
        label: "old BridgeGovernance",
        abi: ["BridgeGovernance"],
        allowed: ["BridgeGovernanceTransferStarted"],
      },
      [bundle.bridgeGovernance.toLowerCase()]: {
        label: "new BridgeGovernance",
        abi: ["BridgeGovernance"],
        allowed: [],
      },
      [c.timelock.address.toLowerCase()]: {
        label: "Timelock",
        abi: ["Timelock"],
        allowed: ["CallScheduled", "CallExecuted", "CallSalt"],
      },
      [c.admin.address.toLowerCase()]: {
        label: "ProxyAdmin",
        abi: ["ProxyAdmin"],
        allowed: [],
      },
    }
    const unexpected: string[] = []
    for (const log of logs) {
      const e = emitters[log.address.toLowerCase()]
      if (!e) {
        unexpected.push(`${log.address}: ${log.topics[0]}`)
        continue
      }
      let name = `unknown ${log.topics[0]}`
      for (const a of e.abi)
        try {
          name = new ethers.utils.Interface(await abiOf(a)).parseLog(log).name
          break
        } catch (err) {
          // not this ABI
        }
      if (!e.allowed.includes(name)) unexpected.push(`${e.label}: ${name}`)
      if (name === "Upgraded")
        expect(
          ethers.utils.getAddress(ethers.utils.hexDataSlice(log.topics[1], 12)),
          "Upgraded to the bundle's implementation"
        ).to.equal(ethers.utils.getAddress(bundle.bridgeImplementation))
    }
    expect(unexpected, "bundle steps emit only the named events").to.deep.equal(
      []
    )
    expect(
      (await c.timelock.getMinDelay()).toString(),
      "Timelock min delay unchanged by the bundle"
    ).to.equal(minDelay)
    expect(
      await c.legacy.governance(),
      "Bridge governance is the bundle's BridgeGovernance"
    ).to.equal(ethers.utils.getAddress(bundle.bridgeGovernance))
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
    const after = await c11Frame(c)
    const initKey = await initializedKey()
    const reinitialized = preFrame[initKey] !== after[initKey]
    if (reinitialized)
      expect(
        await initializedVersion(c),
        "reinitialized version > 5"
      ).to.be.greaterThan(5)
    const allowed = await allowedDifferences(reinitialized)
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
    const after = await c11Frame(c)
    // A reinitializer's version survives the rollback: harmless, since the
    // 40a11d1d reinitializers (2, 5) are already spent.
    const initKey = await initializedKey()
    const allowed = await allowedDifferences(
      preFrame[initKey] !== after[initKey]
    )
    delete allowed["eip1967:implementation"]
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
