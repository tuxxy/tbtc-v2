/* eslint-disable no-await-in-loop, no-restricted-syntax, no-bitwise, @typescript-eslint/no-explicit-any */
// C-11a FROST Bridge upgrade bundle world (tuxxy/tbtc-v2#58, #57, #56).
//
// Real pieces:
// - the K-09 contract world (`k09-registry-world`, frozen, imported): the
//   pre-FROST Bank and Bridge built from git at tbtc-v2 main 40a11d1d (D1)
//   behind a real transparent proxy, the real ECDSA WalletRegistry with 100
//   staked operators and its DKG driven through public calls;
// - every legacy obligation class of the 40a11d1d Bridge, created on that
//   Bridge through public calls, as the frozen K-09 ledger creates them
//   (`k09-legacy-ledger` builds them and then upgrades inside its own fixture,
//   so the pre-upgrade part is rebuilt here, not edited there): pending,
//   rebated, vetoable and timed-out redemptions, MovingFunds wallets with and
//   without a commitment and below dust, a moved-funds sweep request, a
//   Closing wallet, three open fraud challenges, two unswept deposits, Live
//   wallets and a DKG in flight. RebateStaking and the RedemptionWatchtower
//   are the real contracts behind proxies;
// - the production authority shape: the Bridge proxy's ProxyAdmin is owned by
//   a real `Timelock` (base deploy 42, OpenZeppelin TimelockController), the
//   Bridge's governance is a real 40a11d1d BridgeGovernance (compiled from git
//   at 40a11d1d, BridgeGovernanceParameters linked) installed with base's own
//   `transferGovernance` (deploy 21) and owned by the council stand-in (deploy
//   22). The watchtower, RebateStaking and Bank owners are the council too.
//   The historical deployer (signer 0) holds no role after the handover.
//
// TEST VALUES (labelled):
// - `TIMELOCK_TEST_DELAY` is a short test delay (base deploy 42: 86400 s);
// - the council stand-in is one EOA; on mainnet it is the Council Safe;
// - the exposure controller's governance is the council stand-in (D-10 OPEN).
//
// ADAPTERs and FIXTUREs are k09-registry-world's (relay, random beacon, FROST
// registry callback boundary), labelled there.
import { artifacts, deployments, ethers, helpers, network, run } from "hardhat"
import { expect } from "chai"
import { execFileSync } from "child_process"
import fs from "fs"
import path from "path"
import type { BigNumberish, Contract } from "ethers"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { LEGACY_BASELINE } from "./frost-legacy-baseline"
import {
  deploy,
  transaction,
  inclusion,
  p2wpkh,
  outpoint,
  Tx,
} from "./frost-movement-world"
import {
  k09World,
  createLegacyWallet,
  dkg,
  legacyKey,
  LegacyWallet,
  signDigest,
  increaseTime,
  now,
  NO_MAIN,
  storageFrame,
} from "./k09-registry-world"
import {
  depositScript,
  redemptionKey,
  challengeKey,
  utxoHash,
  Utxo,
  SWEEP_FEE,
  FUND,
  RED_AMOUNT,
  BOND,
} from "./k09-legacy-ledger"

/// TEST VALUE: base deploy 42 uses 86400 s.
export const TIMELOCK_TEST_DELAY = 3600
/// Base deploy 09/70 value for every network but Sepolia.
export const BRIDGE_GOVERNANCE_DELAY = 172800
export const EIP1967_IMPLEMENTATION =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
export const EIP1967_ADMIN =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
export const GOVERNANCE_REASONS = [
  "Caller is not governance",
  "Caller is not the governance",
]
export const OWNABLE_REASON = "Ownable: caller is not the owner"
export const MAX_CODE = 24576

// ---------------------------------------------------------------------------
// The C-11 bundle builder (the production deploy script). Its interface is
// defined by these tests; see test/c11/README.md.
// ---------------------------------------------------------------------------
export const BUILDER_FILE = "deploy/87_deploy_frost_bridge_upgrade.ts"
export const BUILDER_TAG = "DeployFrostBridgeUpgrade"
export const BUILDER_SKIP_ENV = "DEPLOY_FROST_UPGRADE"

export type FrostUpgradeInputs = {
  bridge: string
  proxyAdmin: string
  timelock: string
  bridgeGovernance: string
  council: string
  exposureGovernance: string
}
export type FrostUpgradeStep =
  | {
      kind: "timelock"
      actions: { target: string; value: BigNumberish; data: string }[]
      predecessor: string
      salt: string
      description: string
    }
  | {
      kind: "council"
      to: string
      value: BigNumberish
      data: string
      description: string
    }
  | { kind: "wait"; seconds: number; description: string }
export type FrostUpgradeBundle = {
  bridgeImplementation: string
  libraries: Record<string, string>
  bridgeGovernance: string
  bridgeGovernanceParameters: string
  verifier: string
  exposureController: string
  rollbackImplementation: string
  steps: FrostUpgradeStep[]
}
export type Builder = {
  default: any
  deployFrostBridgeUpgrade: (
    hre: any,
    inputs: FrostUpgradeInputs
  ) => Promise<FrostUpgradeBundle>
}

/// The builder module, or null when the file does not exist yet. A control
/// run points `C11_BUILDER` at a `.wrong` variant.
export function builderPath() {
  return process.env.C11_BUILDER
    ? path.resolve(process.env.C11_BUILDER)
    : path.resolve(__dirname, "../..", BUILDER_FILE)
}
export async function loadBuilder(): Promise<Builder | null> {
  const file = builderPath()
  if (!fs.existsSync(file)) return null
  // eslint-disable-next-line import/no-dynamic-require, global-require
  return import(file)
}

// ---------------------------------------------------------------------------
// The 40a11d1d BridgeGovernance, compiled from git at the D1 baseline with
// the current BridgeGovernance compiler settings (only BridgeGovernance and
// BridgeGovernanceParameters are emitted). Built once per process.
// ---------------------------------------------------------------------------
type Compiled = { abi: any; bytecode: string; linkReferences: any }
let governanceBuild: Promise<Record<string, Compiled>> | undefined
async function buildBaselineGovernance(): Promise<Record<string, Compiled>> {
  const repository = path.resolve(__dirname, "../../..")
  const root = "contracts/bridge/BridgeGovernance.sol"
  const info = await artifacts.getBuildInfo(`${root}:BridgeGovernance`)
  if (!info) throw Error("current BridgeGovernance build-info")
  const input = JSON.parse(JSON.stringify(info.input))
  input.sources = {}
  const pending = [root]
  while (pending.length > 0) {
    const key = pending.pop()!
    if (!input.sources[key]) {
      const content = key.startsWith("contracts/")
        ? execFileSync("git", ["show", `${LEGACY_BASELINE}:solidity/${key}`], {
            cwd: repository,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
          })
        : info.input.sources[key].content
      input.sources[key] = { content }
      for (const [, spec] of content.matchAll(
        /import\s+(?:[^"';]*\s+from\s+)?["']([^"']+)["']/g
      ))
        pending.push(
          spec.startsWith(".")
            ? path.posix.join(path.posix.dirname(key), spec)
            : spec
        )
    }
  }
  const outputs = ["abi", "evm.bytecode", "evm.deployedBytecode"]
  // Every source keeps an ABI output: with no output for a file solc skips
  // part of its analysis and the import cycle BitcoinTx <-> BridgeState fails
  // to resolve. Code is generated for the two contracts only.
  input.settings.outputSelection = {
    "*": { "*": ["abi"] },
    [root]: { BridgeGovernance: outputs },
    "contracts/bridge/BridgeGovernanceParameters.sol": {
      BridgeGovernanceParameters: outputs,
    },
  }
  const compiler = await run("compile:solidity:solc:get-build", {
    quiet: true,
    solcVersion: info.solcVersion,
  })
  const output = await run(
    compiler.isSolcJs
      ? "compile:solidity:solcjs:run"
      : "compile:solidity:solc:run",
    compiler.isSolcJs
      ? { input, solcJsPath: compiler.compilerPath }
      : { input, solcPath: compiler.compilerPath }
  )
  const errors = (output.errors || []).filter(
    (e: { severity: string }) => e.severity === "error"
  )
  expect(errors, "the 40a11d1d BridgeGovernance compiles").to.deep.equal([])
  const pick = (source: string, name: string): Compiled => {
    const c = output.contracts[source][name]
    return {
      abi: c.abi,
      bytecode: `0x${c.evm.bytecode.object}`,
      linkReferences: c.evm.bytecode.linkReferences,
    }
  }
  return {
    BridgeGovernance: pick(root, "BridgeGovernance"),
    BridgeGovernanceParameters: pick(
      "contracts/bridge/BridgeGovernanceParameters.sol",
      "BridgeGovernanceParameters"
    ),
  }
}
export function baselineGovernance() {
  if (!governanceBuild) governanceBuild = buildBaselineGovernance()
  return governanceBuild
}

function link(
  bytecode: string,
  references: any,
  addresses: Record<string, string>
) {
  let linked = bytecode
  for (const libraries of Object.values(references ?? {}))
    for (const [library, positions] of Object.entries(libraries as any)) {
      const address = addresses[library]
      if (!address) throw Error(`no address for library ${library}`)
      for (const p of positions as { start: number; length: number }[])
        linked =
          linked.slice(0, 2 + p.start * 2) +
          address.slice(2).toLowerCase() +
          linked.slice(2 + (p.start + p.length) * 2)
    }
  return linked
}

// ---------------------------------------------------------------------------
// World: the populated 40a11d1d world under the production authority shape.
// ---------------------------------------------------------------------------
async function c11Fixture() {
  // The 40a11d1d BridgeGovernance compiles (a solc process) while the K-09
  // world builds.
  const governanceReady = baselineGovernance()
  const timing = process.env.C11_TIMING ? Date.now() : 0
  const w = await k09World()
  if (timing) console.log(`C11 TIMING k09World ${Date.now() - timing} ms`)
  const { alias, maintainer, owner } = w
  const legacy = w.bridge // the 40a11d1d ABI
  let nonce = 0
  const fresh = (label: string) => {
    nonce += 1
    return ethers.utils.id(`C11 ${label} ${nonce}`)
  }

  // Watchtower: the real RedemptionWatchtower behind a proxy, three guardians.
  const towerImplementation = await deploy("RedemptionWatchtower")
  const towerProxy = await deploy("TransparentUpgradeableProxy", [
    towerImplementation.address,
    w.admin.address,
    towerImplementation.interface.encodeFunctionData("initialize", [
      legacy.address,
    ]),
  ])
  const tower = towerImplementation.attach(towerProxy.address)
  await tower.enableWatchtower(
    w.manager.address,
    w.guardians.map((g) => g.address)
  )
  await legacy.setRedemptionWatchtower(tower.address)

  // Legacy wallets through the real DKG, as the K-09 ledger (H last: active).
  const names = [
    "R", // pending redemption (proof) and a vetoable rebated redemption
    "T", // pending rebated redemption (timeout)
    "U", // redemption timed out before the upgrade
    "M", // MovingFunds, no commitment
    "Y", // MovingFunds below dust
    "A", // MovingFunds with a legacy commitment to B
    "A3", // moved its funds to B, now Closing
    "B", // target with a pending moved-funds sweep request
    "F", // three open fraud challenges; Live and closeable
    "D", // two revealed, unswept deposits
    "H", // Live, active wallet
  ] as const
  type Name = typeof names[number]
  const wallets = {} as Record<Name, LegacyWallet>
  for (const [i, name] of names.entries())
    wallets[name] = await createLegacyWallet(w, legacy, legacyKey(0x1100 + i))
  const mains = {} as Record<Name, Utxo>
  const depositKeys: Record<string, string> = {}

  const locktime = async () => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE((await now()) + 120 * 86400)
    return `0x${b.toString("hex")}`
  }
  const revealTo = async (x: LegacyWallet, amount: number, extra?: string) => {
    nonce += 1
    const blinding = ethers.utils.hexZeroPad(ethers.utils.hexlify(nonce), 8)
    const lock = await locktime()
    const script = depositScript(
      alias.address,
      blinding,
      x.pkh,
      x.pkh,
      lock,
      extra
    )
    const funding = transaction(
      [[fresh("funding"), 0]],
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
    const reveal = {
      fundingOutputIndex: 0,
      blindingFactor: blinding,
      walletPubKeyHash: x.pkh,
      refundPubKeyHash: x.pkh,
      refundLocktime: lock,
      vault: ethers.constants.AddressZero,
    }
    if (extra)
      await legacy
        .connect(alias)
        .revealDepositWithExtraData(funding.tx, reveal, extra)
    else await legacy.connect(alias).revealDeposit(funding.tx, reveal)
    return funding
  }
  const fund = async (name: Name, amount: number) => {
    const x = wallets[name]
    const funding = await revealTo(x, amount)
    depositKeys[`swept:${name}`] = outpoint(funding.hash, 0)
    const sweep = transaction(
      [[funding.hash, 0]],
      [{ value: amount - SWEEP_FEE, script: p2wpkh(x.pkh) }]
    )
    await legacy
      .connect(maintainer)
      .submitDepositSweepProof(
        sweep.tx,
        inclusion(sweep.hash),
        NO_MAIN,
        ethers.constants.AddressZero
      )
    mains[name] = {
      txHash: sweep.hash,
      txOutputIndex: 0,
      txOutputValue: amount - SWEEP_FEE,
    }
    return funding
  }
  for (const name of ["R", "T", "U", "M", "A", "A3", "H"] as Name[])
    await fund(name, FUND)
  const fFunding = await fund("F", FUND)
  await fund("Y", 15000) // main 14000, below the 20000 moving-funds dust

  await increaseTime(366 * 86400) // old enough to be closeable

  const script = (tag: number) =>
    `0x160014${ethers.utils.hexZeroPad(ethers.utils.hexlify(tag), 20).slice(2)}`
  await w.bank.connect(alias).approveBalance(legacy.address, 4 * RED_AMOUNT)
  const request = async (name: Name, tag: number) => {
    await legacy
      .connect(alias)
      .requestRedemption(
        wallets[name].pkh,
        mains[name],
        script(tag),
        RED_AMOUNT
      )
    return script(tag)
  }
  const uScript = await request("U", 3)
  await increaseTime(5 * 86400 + 1)
  await legacy
    .connect(alias)
    .notifyRedemptionTimeout(wallets.U.pkh, wallets.U.members, uScript)

  for (const name of ["M", "Y", "A", "A3"] as Name[])
    await legacy
      .connect(alias)
      .notifyWalletCloseable(wallets[name].pkh, mains[name])
  const commit = async (name: Name, target: Name) =>
    legacy
      .connect(wallets[name].signers[0])
      .submitMovingFundsCommitment(
        wallets[name].pkh,
        mains[name],
        wallets[name].members,
        1,
        [wallets[target].pkh]
      )
  const movementTx = (name: Name, target: Name) =>
    transaction(
      [[mains[name].txHash, 0]],
      [
        {
          value: mains[name].txOutputValue - SWEEP_FEE,
          script: p2wpkh(wallets[target].pkh),
        },
      ]
    )
  await commit("A3", "B")
  const a3Movement = movementTx("A3", "B")
  await legacy
    .connect(maintainer)
    .submitMovingFundsProof(
      a3Movement.tx,
      inclusion(a3Movement.hash),
      mains.A3,
      wallets.A3.pkh
    )
  await commit("A", "B")

  // RebateStaking, live on mainnet (unchanged since 40a11d1d).
  const rebateImplementation = await deploy("RebateStaking")
  const rebateProxy = await deploy("TransparentUpgradeableProxy", [
    rebateImplementation.address,
    w.admin.address,
    rebateImplementation.interface.encodeFunctionData("initialize", [
      legacy.address,
      w.t.address,
      30 * 86400,
      30 * 86400,
      ethers.utils.parseEther("1"),
    ]),
  ])
  const rebate = rebateImplementation.attach(rebateProxy.address)
  await legacy.setRebateStaking(rebate.address)
  const { rebater } = w
  const stake = ethers.utils.parseEther("600")
  await w.t.connect(w.deployer).mint(rebater.address, stake)
  await w.t.connect(rebater).approve(rebate.address, stake)
  await rebate.connect(rebater).stake(stake)
  await rebate.connect(rebater).setRebateTreasuryFeeMode(2) // RedemptionOnly
  await w.bank.connect(alias).transferBalance(rebater.address, 2 * RED_AMOUNT)

  const rScript = await request("R", 1)
  const tScript = script(2)
  await w.bank
    .connect(rebater)
    .approveBalanceAndCall(
      legacy.address,
      RED_AMOUNT,
      ethers.utils.defaultAbiCoder.encode(
        ["address", "bytes20", "bytes32", "uint32", "uint64", "bytes"],
        [
          rebater.address,
          wallets.T.pkh,
          mains.T.txHash,
          0,
          mains.T.txOutputValue,
          tScript,
        ]
      )
    )
  const vScript = script(4)
  await w.bank.connect(rebater).approveBalance(legacy.address, RED_AMOUNT)
  await legacy
    .connect(rebater)
    .requestRedemption(wallets.R.pkh, mains.R, vScript, RED_AMOUNT)

  const d1 = await revealTo(wallets.D, 50000)
  const d2 = await revealTo(wallets.D, 60000, fresh("extra data"))
  depositKeys.d1 = outpoint(d1.hash, 0)
  depositKeys.d2 = outpoint(d2.hash, 0)

  // F: three open challenges signed by F's key.
  const le32 = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(n)
    return b.toString("hex")
  }
  const preimage = `0x${"02000000"}${"11".repeat(32)}${"22".repeat(
    32
  )}${fFunding.hash.slice(2)}${le32(0)}1976a914${wallets.F.pkh.slice(
    2
  )}88ac${"a086010000000000"}${"ffffffff"}${"33".repeat(32)}${le32(0)}${le32(
    1
  )}`
  const heartbeat = `0xffffffffffffffff${"0000000000000007"}`
  const arbitrary = fresh("arbitrary signed digest")
  const challenge = async (message: string) => {
    const preimageSha256 = ethers.utils.sha256(message)
    const sighash = ethers.utils.sha256(preimageSha256)
    await legacy
      .connect(alias)
      .submitFraudChallenge(
        wallets.F.groupPubKey,
        preimageSha256,
        signDigest(wallets.F, sighash),
        { value: BOND }
      )
    return { message, preimageSha256, sighash }
  }
  const challenges = {
    preimage: await challenge(preimage),
    heartbeat: await challenge(heartbeat),
    arbitrary: await challenge(arbitrary),
  }

  // Z: a DKG in flight (AWAITING_RESULT) across the bundle.
  const d = dkg(w)
  await legacy.requestNewWallet(mains.H)
  await d.seed()
  const zKey = legacyKey(0x2100)

  // --- The production authority shape (handover from signer 0). ---
  const unnamed = (await helpers.signers.getUnnamedSigners()).filter(
    (s: SignerWithAddress) => s.address !== owner.address
  )
  const council = unnamed[unnamed.length - 10]
  const outsider = unnamed[unnamed.length - 11]
  // TimelockController as base deploy 42, with a TEST delay; the council
  // stand-in is the proposer and the executor.
  const timelock = await deploy("Timelock", [
    TIMELOCK_TEST_DELAY,
    [council.address],
    [council.address],
  ])
  await w.admin.transferOwnership(timelock.address)
  // The 40a11d1d BridgeGovernance (deploy 09), installed with the Bridge's
  // own transferGovernance (deploy 21), owned by the council (deploy 22).
  const governance = await governanceReady
  const deployCompiled = async (
    c: Compiled,
    libraries: Record<string, string>,
    args: unknown[] = []
  ) => {
    const factory = new ethers.ContractFactory(
      c.abi,
      link(c.bytecode, c.linkReferences, libraries),
      owner
    )
    const contract = await factory.deploy(...args)
    await contract.deployed()
    return contract
  }
  const oldGovernanceParameters = await deployCompiled(
    governance.BridgeGovernanceParameters,
    {}
  )
  const oldGovernance = await deployCompiled(
    governance.BridgeGovernance,
    { BridgeGovernanceParameters: oldGovernanceParameters.address },
    [legacy.address, BRIDGE_GOVERNANCE_DELAY]
  )
  await legacy.transferGovernance(oldGovernance.address)
  await oldGovernance.transferOwnership(council.address)
  await tower.transferOwnership(council.address)
  await rebate.transferOwnership(council.address)
  await w.bank.transferOwnership(council.address)
  // k09-registry-world's own exposure controller is unused here; its
  // governance moves too, so signer 0 keeps no role.
  await w.exposure.transferGovernance(council.address)
  await w.exposure.connect(council).acceptGovernance()

  if (timing) console.log(`C11 TIMING c11World ${Date.now() - timing} ms`)
  const preBundleImplementation = await w.admin.getProxyImplementation(
    w.proxy.address
  )
  expect(preBundleImplementation, "pre-bundle implementation").to.equal(
    w.baseline.address
  )
  return {
    ...w,
    legacy,
    tower,
    rebate,
    wallets,
    mains,
    depositKeys,
    deposits: { d1, d2 },
    scripts: { R: rScript, T: tScript, U: uScript, V: vScript },
    a3Movement,
    movementTx,
    challenges,
    z: { key: zKey },
    council,
    outsider,
    historicalDeployer: owner,
    timelock,
    oldGovernance,
    oldGovernanceParameters,
    preBundleImplementation,
  }
}
export const c11World = deployments.createFixture(c11Fixture)
export type C11World = Awaited<ReturnType<typeof c11Fixture>>
export type LegacyName = keyof C11World["wallets"]

/// The builder inputs for this world.
export function inputs(c: C11World): FrostUpgradeInputs {
  return {
    bridge: c.proxy.address,
    proxyAdmin: c.admin.address,
    timelock: c.timelock.address,
    bridgeGovernance: c.oldGovernance.address,
    council: c.council.address,
    exposureGovernance: c.council.address, // TEST VALUE: D-10 OPEN
  }
}

// ---------------------------------------------------------------------------
// Running a bundle: the council stand-in executes the steps in order.
// ---------------------------------------------------------------------------
export function reason(e: any): string {
  const text =
    [e?.reason, e?.message, e?.error?.message, e?.error?.error?.message]
      .filter((x) => typeof x === "string")
      .join(" | ") || String(e)
  const m =
    /reverted with reason string '([^']*)'/.exec(text) ??
    /reverted with custom error '([^']*)'/.exec(text)
  if (m) return m[1]
  if (/reverted without a reason/.test(text)) return "<no reason>"
  return text.slice(0, 200)
}

/// The revert reason of a static call ("" when it does not revert). The
/// Hardhat provider returns revert data from eth_call instead of throwing.
export async function callReason(from: string, to: string, data: string) {
  let result: string
  try {
    result = await ethers.provider.call({ from, to, data })
  } catch (e) {
    return reason(e)
  }
  if (result.startsWith("0x08c379a0"))
    return ethers.utils.defaultAbiCoder.decode(
      ["string"],
      `0x${result.slice(10)}`
    )[0]
  return ""
}

export async function implementationOf(c: C11World) {
  const word = await ethers.provider.getStorageAt(
    c.proxy.address,
    EIP1967_IMPLEMENTATION
  )
  return ethers.utils.getAddress(`0x${word.slice(26)}`)
}

export async function schedule(
  c: C11World,
  step: Extract<FrostUpgradeStep, { kind: "timelock" }>,
  from: SignerWithAddress = c.council
) {
  return c.timelock.connect(from).scheduleBatch(
    step.actions.map((a) => a.target),
    step.actions.map((a) => a.value),
    step.actions.map((a) => a.data),
    step.predecessor,
    step.salt,
    await c.timelock.getMinDelay()
  )
}
export async function execute(
  c: C11World,
  step: Extract<FrostUpgradeStep, { kind: "timelock" }>,
  from: SignerWithAddress = c.council,
  overrides: Record<string, unknown> = {}
) {
  return c.timelock.connect(from).executeBatch(
    step.actions.map((a) => a.target),
    step.actions.map((a) => a.value),
    step.actions.map((a) => a.data),
    step.predecessor,
    step.salt,
    overrides
  )
}

/// Executes one step as the council stand-in.
export async function runStep(c: C11World, step: FrostUpgradeStep) {
  if (step.kind === "timelock") {
    await (await schedule(c, step)).wait()
    await increaseTime((await c.timelock.getMinDelay()).toNumber())
    await (await execute(c, step)).wait()
  } else if (step.kind === "council") {
    await (
      await c.council.sendTransaction({
        to: step.to,
        value: step.value,
        data: step.data,
      })
    ).wait()
  } else if (step.kind === "wait") {
    await increaseTime(step.seconds)
  } else {
    throw Error(`unknown step kind ${(step as any).kind}`)
  }
}

/// Runs every step; a failing step fails at its own named assertion.
export async function runSteps(
  c: C11World,
  steps: FrostUpgradeStep[],
  after?: (index: number, step: FrostUpgradeStep) => Promise<void>
) {
  for (const [i, step] of steps.entries()) {
    let refused = ""
    try {
      await runStep(c, step)
    } catch (e) {
      refused = reason(e)
    }
    expect(
      refused,
      `C-11 bundle step ${i} (${step.kind}: ${step.description}) executes`
    ).to.equal("")
    if (after) await after(i, step)
  }
}

// ---------------------------------------------------------------------------
// Storage layout of this checkout's Bridge (for named FROST fields).
// ---------------------------------------------------------------------------
type Layout = { storage: any[]; types: Record<string, any> }
let bridgeLayoutCache: Layout | undefined
export async function bridgeLayout(): Promise<Layout> {
  if (bridgeLayoutCache) return bridgeLayoutCache
  for (const file of await artifacts.getBuildInfoPaths()) {
    const info = JSON.parse(fs.readFileSync(file, "utf8"))
    const contract =
      info.output.contracts["contracts/bridge/Bridge.sol"]?.Bridge
    if (contract?.storageLayout) {
      bridgeLayoutCache = contract.storageLayout
      return contract.storageLayout
    }
  }
  throw Error("Bridge storage layout")
}
/// Slot, byte offset and size of a member path, e.g. ["self", "frost", "registry"].
export async function locate(fieldPath: string[]) {
  const layout = await bridgeLayout()
  const top = layout.storage.find((s) => s.label === fieldPath[0])
  if (!top) throw Error(`no storage member ${fieldPath[0]}`)
  let slot = BigInt(top.slot)
  let { offset } = top
  let { type } = top
  for (const label of fieldPath.slice(1)) {
    const member = layout.types[type].members?.find(
      (m: any) => m.label === label
    )
    if (!member) throw Error(`no storage member ${fieldPath.join(".")}`)
    slot += BigInt(member.slot)
    offset = member.offset
    type = member.type
  }
  return {
    slot,
    offset: Number(offset),
    bytes: Number(layout.types[type].numberOfBytes),
    words: Math.ceil(Number(layout.types[type].numberOfBytes) / 32),
  }
}
export async function readField(address: string, fieldPath: string[]) {
  const f = await locate(fieldPath)
  const word = BigInt(
    await ethers.provider.getStorageAt(address, ethers.BigNumber.from(f.slot))
  )
  if (f.bytes >= 32) return word
  return (
    (word >> BigInt(8 * f.offset)) &
    ((BigInt(1) << BigInt(8 * f.bytes)) - BigInt(1))
  )
}
/// Every storage slot occupied by the FROST members of BridgeState.Storage.
export async function frostSlots() {
  const layout = await bridgeLayout()
  const self = layout.storage.find((s) => s.label === "self")
  const members = layout.types[self.type].members.filter((m: any) =>
    /^frost/.test(m.label)
  )
  expect(members.length, "FROST storage members found").to.be.greaterThan(0)
  const slots: { member: string; slot: bigint }[] = []
  for (const m of members) {
    const words = Math.ceil(Number(layout.types[m.type].numberOfBytes) / 32)
    for (let i = 0; i < words; i++)
      slots.push({
        member: m.label,
        slot: BigInt(self.slot) + BigInt(m.slot) + BigInt(i),
      })
  }
  return slots
}

// ---------------------------------------------------------------------------
// Governance surface: derived from the ABI by behaviour, not hand-picked.
// ---------------------------------------------------------------------------
function argument(t: any, max: boolean): unknown {
  const { baseType } = t
  if (baseType === "tuple")
    return t.components.map((x: any) => argument(x, max))
  if (baseType === "array") {
    if (t.arrayLength >= 0)
      return Array.from({ length: t.arrayLength }, () =>
        argument(t.arrayChildren, max)
      )
    return max ? [argument(t.arrayChildren, max)] : []
  }
  if (baseType === "bool") return max
  if (baseType === "address")
    return max
      ? "0xffffffffffffffffffffffffffffffffffffffff"
      : ethers.constants.AddressZero
  if (baseType === "string") return max ? "x" : ""
  if (baseType === "bytes") return max ? "0x01" : "0x"
  if (/^bytes\d+$/.test(baseType)) {
    const n = Number(baseType.slice(5))
    return `0x${(max ? "ff" : "00").repeat(n)}`
  }
  if (/^uint\d*$/.test(baseType)) {
    const bits = Number(baseType.slice(4) || 256)
    return max ? ethers.BigNumber.from(2).pow(bits).sub(1) : 0
  }
  if (/^int\d*$/.test(baseType)) {
    const bits = Number(baseType.slice(3) || 256)
    return max
      ? ethers.BigNumber.from(2)
          .pow(bits - 1)
          .sub(1)
      : 0
  }
  throw Error(`argument for ${t.type}`)
}
export const defaultArguments = (f: any, max: boolean) =>
  f.inputs.map((t: any) => argument(t, max))

/// The base (40a11d1d) Bridge ABI, from the D1 baseline build.
const baselineAbis = new Map<string, any>()
export function baselineBridgeAbi(c: C11World) {
  if (!baselineAbis.has(c.build))
    baselineAbis.set(
      c.build,
      JSON.parse(
        fs.readFileSync(
          path.join(c.build, "contracts/bridge/Bridge.sol", "Bridge.json"),
          "utf8"
        )
      ).abi
    )
  return baselineAbis.get(c.build)
}
const abis = new Map<string, any>()
/// A current artifact's ABI, read once.
export async function abiOf(name: string) {
  if (!abis.has(name)) abis.set(name, (await artifacts.readArtifact(name)).abi)
  return abis.get(name)
}

/// The Bridge's non-view functions that are new since 40a11d1d: this
/// checkout's Bridge ABI plus the FROST interface reached by its fallback.
export async function newBridgeFunctions(c: C11World) {
  const base = new ethers.utils.Interface(baselineBridgeAbi(c))
  const baseNames = new Set(Object.values(base.functions).map((f) => f.name))
  const fragments = new Map<string, any>()
  for (const name of ["Bridge", "IFrostBridge"]) {
    const i = new ethers.utils.Interface(await abiOf(name))
    for (const f of Object.values(i.functions))
      if (!fragments.has(f.format())) fragments.set(f.format(), f)
  }
  return [...fragments.values()].filter(
    (f) =>
      !baseNames.has(f.name) &&
      f.stateMutability !== "view" &&
      f.stateMutability !== "pure"
  )
}

/// Governance-guarded new functions: those that refuse an outsider with the
/// governance reason on a bare implementation (whose governance is 0x0), with
/// all-zero or all-max arguments.
export async function governanceGuarded(
  c: C11World,
  implementation: string
): Promise<any[]> {
  const guarded = []
  for (const f of await newBridgeFunctions(c)) {
    const i = new ethers.utils.Interface([f])
    let hit = false
    for (const max of [false, true]) {
      const why = await callReason(
        c.outsider.address,
        implementation,
        i.encodeFunctionData(f, defaultArguments(f, max))
      )
      if (GOVERNANCE_REASONS.includes(why)) hit = true
    }
    if (hit) guarded.push(f)
  }
  return guarded
}

/// The frame key and current value of the Bridge's `_initialized` slot (the
/// Initializable version): a reinitializer is detected by this slot, not by
/// its name.
export async function initializedKey() {
  return `bridge:slot:${(await locate(["_initialized"])).slot}`
}
export async function initializedVersion(c: C11World) {
  return Number(await readField(c.proxy.address, ["_initialized"]))
}

/// Every call the bundle makes into the Bridge: `upgradeAndCall` payloads
/// and the data of council or Timelock calls whose target is the proxy.
export function bundleBridgeCalls(c: C11World, steps: FrostUpgradeStep[]) {
  const admin = c.admin.address.toLowerCase()
  const proxy = c.proxy.address.toLowerCase()
  const calls: string[] = []
  for (const s of steps) {
    let actions: { to: string; data: string }[] = []
    if (s.kind === "timelock")
      actions = s.actions.map((a) => ({ to: a.target, data: a.data }))
    if (s.kind === "council") actions = [{ to: s.to, data: s.data }]
    for (const a of actions) {
      if (a.to.toLowerCase() === proxy && a.data !== "0x") calls.push(a.data)
      if (a.to.toLowerCase() === admin) {
        const call = c.admin.interface.parseTransaction({ data: a.data })
        if (call.name === "upgradeAndCall" && call.args[2] !== "0x")
          calls.push(call.args[2])
      }
    }
  }
  return calls
}

/// New initializers (reinitializers) of this checkout's Bridge, by name
/// (used only as extra outsider probes; detection is by `_initialized`).
export async function newInitializers(c: C11World) {
  const base = new ethers.utils.Interface(baselineBridgeAbi(c))
  const baseNames = new Set(Object.values(base.functions).map((f) => f.name))
  const i = new ethers.utils.Interface(await abiOf("Bridge"))
  return Object.values(i.functions).filter(
    (f) => /^initialize/.test(f.name) && !baseNames.has(f.name)
  )
}

// ---------------------------------------------------------------------------
// The frame: every inventoried legacy object, the 40a11d1d-ABI reads, the
// Bridge's fixed storage, and the authority around it.
// ---------------------------------------------------------------------------
export function frameKeys(c: C11World) {
  const wallets = { ...c.wallets, Z: c.z.key } as Record<
    string,
    { pkh: string; walletID: string }
  >
  const redemptionKeys: Record<string, string> = {}
  for (const [k, s] of Object.entries(c.scripts))
    redemptionKeys[k] = redemptionKey(
      c.wallets[(k === "V" ? "R" : k) as "R"].pkh,
      s
    )
  const challengeKeys: Record<string, string> = {}
  for (const [k, ch] of Object.entries(c.challenges))
    challengeKeys[k] = challengeKey(c.wallets.F, ch.sighash)
  const mainKeys: Record<string, string> = {}
  for (const [k, m] of Object.entries(c.mains)) mainKeys[k] = utxoHash(m)
  return { wallets, redemptionKeys, challengeKeys, mainKeys }
}

/// Keyed reads of the 40a11d1d Bridge ABI. Every base view with inputs must
/// appear here (`unmappedBaseViews`).
function keyedBaseReads(c: C11World): Record<string, [string, unknown[]][]> {
  const k = frameKeys(c)
  const each = <T>(o: Record<string, T>, f: (v: T) => unknown[]) =>
    Object.entries(o).map(([n, v]) => [n, f(v)] as [string, unknown[]])
  return {
    deposits: each(c.depositKeys, (v) => [v]),
    pendingRedemptions: each(k.redemptionKeys, (v) => [v]),
    timedOutRedemptions: each(k.redemptionKeys, (v) => [v]),
    spentMainUTXOs: each(k.mainKeys, (v) => [v]),
    wallets: each(k.wallets, (v) => [v.pkh]),
    fraudChallenges: each(k.challengeKeys, (v) => [v]),
    movedFundsSweepRequests: [["A3", [outpoint(c.a3Movement.hash, 0)]]],
    isVaultTrusted: [
      ["zero", [ethers.constants.AddressZero]],
      ["alias", [c.alias.address]],
    ],
  }
}
export function unmappedBaseViews(c: C11World) {
  const keyed = keyedBaseReads(c)
  return baselineBridgeAbi(c)
    .filter(
      (f: any) =>
        f.type === "function" &&
        ["view", "pure"].includes(f.stateMutability) &&
        f.inputs.length > 0 &&
        !keyed[f.name]
    )
    .map((f: any) => f.name)
}

const json = (v: unknown) =>
  JSON.stringify(v, (_, x) => (x && x.type === "BigNumber" ? x.hex : x))
type Reads = [string, () => Promise<unknown>][]
function zeroArgumentViews(reads: Reads, prefix: string, contract: Contract) {
  for (const f of Object.values(contract.interface.functions))
    if (["view", "pure"].includes(f.stateMutability) && f.inputs.length === 0)
      reads.push([`${prefix}:${f.name}`, () => contract[f.format()]()])
}

/// The whole frame. Reads run concurrently; a reverting read is recorded as
/// `REVERT <reason>` so that a changed ABI shows up as a difference.
export async function c11Frame(c: C11World) {
  const reads: Reads = []
  const base = new ethers.Contract(
    c.proxy.address,
    baselineBridgeAbi(c),
    ethers.provider
  )
  // 40a11d1d-ABI reads of the Bridge: every zero-argument view, and every
  // keyed view over the inventory.
  zeroArgumentViews(reads, "bridge", base)
  for (const [name, entries] of Object.entries(keyedBaseReads(c)))
    for (const [key, args] of entries)
      reads.push([`bridge:${name}:${key}`, () => base[name](...args)])
  const k = frameKeys(c)
  for (const [name, x] of Object.entries(k.wallets))
    reads.push([
      `registry:isWalletRegistered:${name}`,
      () => c.registry.isWalletRegistered(x.walletID),
    ])
  reads.push([
    "registry:walletCreationState",
    () => c.registry.getWalletCreationState(),
  ])
  // Watchtower.
  zeroArgumentViews(reads, "tower", c.tower)
  for (const [name, key] of Object.entries(k.redemptionKeys))
    reads.push([
      `tower:vetoProposals:${name}`,
      () => c.tower.vetoProposals(key),
    ])
  for (const [i, g] of [...c.guardians, c.outsider].entries())
    reads.push([`tower:isGuardian:${i}`, () => c.tower.isGuardian(g.address)])
  for (const a of [c.alias, c.rebater])
    reads.push([
      `tower:isBanned:${a.address}`,
      () => c.tower.isBanned(a.address),
    ])
  // RebateStaking: its views and every rebate entry of the staker.
  zeroArgumentViews(reads, "rebate", c.rebate)
  reads.push([
    "rebate:available:rebater",
    () => c.rebate.getAvailableRebate(c.rebater.address),
  ])
  reads.push([
    "rebate:entries:rebater",
    async () => {
      const length = (
        await c.rebate.getRebateLength(c.rebater.address)
      ).toNumber()
      return Promise.all(
        Array.from({ length }, (_, i) =>
          c.rebate.getRebate(c.rebater.address, i)
        )
      )
    },
  ])
  // Bank balances and allowances.
  zeroArgumentViews(reads, "bank", c.bank)
  const holders = {
    alias: c.alias.address,
    rebater: c.rebater.address,
    treasury: c.treasury.address,
    bridge: c.proxy.address,
    tower: c.tower.address,
  }
  for (const [name, a] of Object.entries(holders))
    reads.push([`bank:balance:${name}`, () => c.bank.balanceOf(a)])
  for (const [owner, a] of Object.entries({
    alias: c.alias.address,
    rebater: c.rebater.address,
  }))
    for (const [spender, sp] of Object.entries({
      bridge: c.proxy.address,
      tower: c.tower.address,
    }))
      reads.push([
        `bank:allowance:${owner}:${spender}`,
        () => c.bank.allowance(a, sp),
      ])
  // ETH held by contracts.
  for (const [name, a] of Object.entries({
    bridge: c.proxy.address,
    pool: c.pool.address,
    tower: c.tower.address,
    rebate: c.rebate.address,
  }))
    reads.push([
      `eth:${name}`,
      async () => (await ethers.provider.getBalance(a)).toString(),
    ])
  // Authority around the Bridge.
  reads.push(["proxyAdmin:owner", () => c.admin.owner()])
  for (const [name, px] of Object.entries({
    tower: c.tower.address,
    rebate: c.rebate.address,
  })) {
    reads.push([
      `proxyAdmin:implementation:${name}`,
      () => c.admin.getProxyImplementation(px),
    ])
    reads.push([`proxyAdmin:admin:${name}`, () => c.admin.getProxyAdmin(px)])
  }
  for (const [name, slot] of Object.entries({
    implementation: EIP1967_IMPLEMENTATION,
    admin: EIP1967_ADMIN,
  }))
    reads.push([
      `eip1967:${name}`,
      () => ethers.provider.getStorageAt(c.proxy.address, slot),
    ])
  const [values, storage] = await Promise.all([
    Promise.all(
      reads.map(async ([, read]) => {
        try {
          const v = await read()
          return json(v)
        } catch (e) {
          return `REVERT ${reason(e)}`
        }
      })
    ),
    storageFrame(c),
  ])
  const f: Record<string, string> = {}
  reads.forEach(([key], i) => {
    f[key] = values[i]
  })
  // Fixed storage of the Bridge proxy, the registry and the sortition pool.
  storage.bridge.forEach((v, i) => {
    f[`bridge:slot:${i}`] = v
  })
  storage.registry.forEach((v, i) => {
    f[`registry:slot:${i}`] = v
  })
  storage.sortitionPool.forEach((v, i) => {
    f[`sortitionPool:slot:${i}`] = v
  })
  return f
}

/// The frame keys that differ.
export function changed(
  before: Record<string, string>,
  after: Record<string, string>
) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((k) => before[k] !== after[k])
    .sort()
}

/// The named allow-list of frame differences a bundle may make.
export async function allowedDifferences(reinitialized: boolean) {
  const allowed: Record<string, string> = {
    "eip1967:implementation": "the implementation slot (the upgrade)",
    "bridge:governance":
      "the Bridge governance address (moved to the new BridgeGovernance)",
  }
  const governance = await locate(["governance"])
  allowed[`bridge:slot:${governance.slot}`] =
    "the Bridge governance address (storage)"
  if (reinitialized) {
    const initialized = await locate(["_initialized"])
    allowed[`bridge:slot:${initialized.slot}`] =
      "the initializer version (a new reinitializer ran)"
  }
  return allowed
}

export { increaseTime, now, NO_MAIN, transaction, inclusion, p2wpkh, outpoint }
export type { Tx }
