/* eslint-disable no-await-in-loop, no-restricted-syntax, no-underscore-dangle */
// K-09 contract-only world (tuxxy/tbtc-v2#16, tuxxy/keep-core#25/#31/#32).
//
// Real pieces:
// - the pre-FROST Bridge and Bank built from git at tbtc-v2 main 40a11d1d
//   (owner decision D1; `legacyBaselineBuild`), behind a real transparent
//   proxy, upgraded in place to this checkout's Bridge;
// - the real ECDSA WalletRegistry, its SortitionPool, TokenStaking, T,
//   EcdsaDkgValidator, ReimbursementPool and WalletRegistryGovernance from
//   the package deploy scripts (`deployments.fixture`), with 100 staked and
//   registered operators. Its DKG is driven only through public calls.
//
// ADAPTERs and FIXTUREs (labelled; no success claim rests on them alone):
// - ADAPTER random beacon: the registry's beacon address carries a smock fake,
//   as in base `test/integration/utils/fake-random-beacon.ts`. It only
//   delivers the relay entry (`__beaconCallback`) as the beacon would.
// - ADAPTER relay: `FrostDepositRegtestRelay` reports integer difficulty 0 and
//   proofs are synthetic two-leaf regtest blocks (`inclusion`). Chain work and
//   Bitcoin spend validity are out of scope (SHARED-RULES rule 3).
// - FIXTURE FROST registry: `FrostRegistryFixture`, the callback boundary of
//   the FROST registry; the ECDSA registry is never stubbed.
// - Legacy wallet keys are known scalars, so fraud signatures can be made.
//   No Bridge or registry storage is ever written; storage is only read for
//   whole-frame comparisons.
import { artifacts, deployments, ethers, helpers, network } from "hardhat"
import { expect } from "chai"
import { smock } from "@defi-wonderland/smock"
import fs from "fs"
import path from "path"
import type { Contract } from "ethers"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { legacyBaselineBuild } from "./frost-legacy-baseline"
import { deploy as deployCurrent } from "./frost-movement-world"

export const DkgState = {
  IDLE: 0,
  AWAITING_SEED: 1,
  AWAITING_RESULT: 2,
  CHALLENGE: 3,
}
export const Mode = { LegacyOpen: 0, LegacyDraining: 1, FrostOnly: 2 }
export const LegacyState = {
  Unknown: 0,
  Live: 1,
  MovingFunds: 2,
  Closing: 3,
  Closed: 4,
  Terminated: 5,
}
export const MAX_UINT64 = ethers.BigNumber.from(2).pow(64).sub(1)
export const NO_MAIN = {
  txHash: ethers.constants.HashZero,
  txOutputIndex: 0,
  txOutputValue: 0,
}
const OPERATORS = 100 // the ECDSA DKG group size
const STAKE = ethers.utils.parseEther("40000")
const CHAIN_ID = 31337

type Artifact = {
  abi: any
  bytecode: string
  linkReferences: Record<
    string,
    Record<string, { start: number; length: number }[]>
  >
}

/// Deploys from the 40a11d1d baseline build, linking baseline libraries.
async function deployBaseline(
  build: string,
  qualified: string,
  cache: Map<string, string>
): Promise<Contract> {
  const [source, name] = qualified.split(":")
  const artifact = JSON.parse(
    fs.readFileSync(path.join(build, source, `${name}.json`), "utf8")
  ) as Artifact
  let { bytecode } = artifact
  for (const [file, libraries] of Object.entries(artifact.linkReferences)) {
    for (const [library, positions] of Object.entries(libraries)) {
      const key = `${file}:${library}`
      if (!cache.has(key))
        cache.set(key, (await deployBaseline(build, key, cache)).address)
      const address = cache.get(key)!
      for (const p of positions)
        bytecode =
          bytecode.slice(0, 2 + p.start * 2) +
          address.slice(2) +
          bytecode.slice(2 + (p.start + p.length) * 2)
    }
  }
  const [signer] = await ethers.getSigners()
  const contract = await new ethers.ContractFactory(
    artifact.abi,
    bytecode,
    signer
  ).deploy()
  await contract.deployed()
  return contract
}

/// A legacy ECDSA wallet key: a known scalar (fixture key material).
export function legacyKey(scalar: number) {
  const priv = ethers.utils.hexZeroPad(ethers.utils.hexlify(scalar), 32)
  const pub = ethers.utils.computePublicKey(priv)
  const compressed = ethers.utils.computePublicKey(pub, true)
  return {
    priv,
    groupPubKey: `0x${pub.slice(4)}`,
    x: `0x${pub.slice(4, 68)}`,
    y: `0x${pub.slice(68)}`,
    walletID: ethers.utils.keccak256(`0x${pub.slice(4)}`),
    pkh: ethers.utils.ripemd160(ethers.utils.sha256(compressed)),
    compressed,
  }
}
export type LegacyKey = ReturnType<typeof legacyKey>

/// Signs a 32-byte digest with a legacy key: (r, s, v) as the Bridge expects.
export function signDigest(key: LegacyKey, digest: string) {
  const sig = new ethers.utils.SigningKey(key.priv).signDigest(digest)
  return { r: sig.r, s: sig.s, v: sig.v }
}

/// Fixed storage words [0, end) of a contract whose layout is in a build-info.
async function fixedSlots(address: string, end: number) {
  return Promise.all(
    Array.from({ length: end }, (_, i) =>
      ethers.provider.getStorageAt(address, i)
    )
  )
}
const layoutCache = new Map<string, number>()
async function layoutEnd(qualified: string) {
  const cached = layoutCache.get(qualified)
  if (cached !== undefined) return cached
  const [source, name] = qualified.split(":")
  // Not every build-info carries `storageLayout` (compiler overrides);
  // the layout depends on the source only, so any build-info that has it.
  for (const file of await artifacts.getBuildInfoPaths()) {
    const info = JSON.parse(fs.readFileSync(file, "utf8"))
    const contract = info.output.contracts[source]?.[name]
    if (contract?.storageLayout) {
      const { storage, types } = contract.storageLayout
      let end = 0
      for (const s of storage)
        end = Math.max(
          end,
          Number(s.slot) + Math.ceil(Number(types[s.type].numberOfBytes) / 32)
        )
      layoutCache.set(qualified, end)
      return end
    }
  }
  throw Error(`storage layout ${qualified}`)
}

async function worldFixture() {
  // The package deploy scripts, as base integration runs them: T,
  // TokenStaking, ReimbursementPool, RandomBeacon, SortitionPool,
  // EcdsaDkgValidator, WalletRegistry and its governance. They also deploy a
  // current-code Bridge as the registry's wallet owner; that Bridge is not
  // used, and ownership moves to the 40a11d1d Bridge below through the
  // registry governance's own update path.
  await deployments.fixture()
  const { deployer, governance, chaosnetOwner } =
    await helpers.signers.getNamedSigners()
  const registry = await helpers.contracts.getContract("WalletRegistry")
  const registryGovernance = await helpers.contracts.getContract(
    "WalletRegistryGovernance"
  )
  const staking = await helpers.contracts.getContract("TokenStaking")
  const t = await helpers.contracts.getContract("T")
  const pool = await helpers.contracts.getContract("ReimbursementPool")
  const sortitionPool = await ethers.getContractAt(
    "SortitionPool",
    await registry.sortitionPool()
  )
  // ADAPTER: the random beacon only delivers relay entries.
  const beacon = await smock.fake("IRandomBeacon", {
    address: await registry.callStatic.randomBeacon(),
  })
  await deployer.sendTransaction({
    to: beacon.address,
    value: ethers.utils.parseEther("10"),
  })
  await deployer.sendTransaction({
    to: pool.address,
    value: ethers.utils.parseEther("100"),
  })
  if (await sortitionPool.isChaosnetActive())
    await sortitionPool.connect(chaosnetOwner).deactivateChaosnet()

  // 100 operators, each with its own owner, provider, operator, beneficiary
  // and authorizer, staked and in the sortition pool, as base integration.
  const [signer0] = await ethers.getSigners()
  const unnamed = (await helpers.signers.getUnnamedSigners()).filter(
    (s) => s.address !== signer0.address
  )
  expect(unnamed.length).to.be.at.least(5 * OPERATORS + 9)
  const roles = (i: number) => unnamed.slice(5 * i, 5 * i + 5)
  const all = Array.from({ length: OPERATORS }, (_, i) => roles(i))
  // Independent signers' transactions are sent together (automine still
  // mines them one by one); the deployer's mints carry explicit nonces.
  const first = await deployer.getTransactionCount()
  await Promise.all(
    all.map(([owner], i) =>
      t.connect(deployer).mint(owner.address, STAKE, { nonce: first + i })
    )
  )
  await Promise.all(
    all.map(([owner]) => t.connect(owner).approve(staking.address, STAKE))
  )
  await Promise.all(
    all.map(([owner, provider, , beneficiary, authorizer]) =>
      staking
        .connect(owner)
        .stake(provider.address, beneficiary.address, authorizer.address, STAKE)
    )
  )
  await Promise.all(
    all.map(([, provider, , , authorizer]) =>
      staking
        .connect(authorizer)
        .increaseAuthorization(provider.address, registry.address, STAKE)
    )
  )
  await Promise.all(
    all.map(([, provider, operator]) =>
      registry.connect(provider).registerOperator(operator.address)
    )
  )
  // Joining the pool is sequential: each insert reads the pool's tree.
  for (const [, , operator] of all)
    await registry.connect(operator).joinSortitionPool()
  expect(await sortitionPool.operatorsInPool()).to.equal(OPERATORS)

  // The 40a11d1d Bank and Bridge behind a real proxy, wired to the real
  // ECDSA registry and reimbursement pool.
  // Actors come from the end of the signer list, apart from every operator
  // role. `alias` is one account acting as depositor, redeemer, fraud
  // challenger and permissionless notifier (aliased actors, KC-SF-V3 K-09).
  // `rebater` is a redeemer staking in RebateStaking.
  const owner = signer0
  const [rebater, alias, treasury, maintainer, keeper, manager, g1, g2, g3] =
    unnamed.slice(-9)
  const depositor = alias
  const challenger = alias
  const build = await legacyBaselineBuild(path.resolve(__dirname, "../../.."))
  const cache = new Map<string, string>()
  const bank = await deployBaseline(
    build,
    "contracts/bank/Bank.sol:Bank",
    cache
  )
  const baseline = await deployBaseline(
    build,
    "contracts/bridge/Bridge.sol:Bridge",
    cache
  )
  const relay = await deployCurrent("FrostDepositRegtestRelay")
  const admin = await deployCurrent("ProxyAdmin")
  const proxy = await deployCurrent("TransparentUpgradeableProxy", [
    baseline.address,
    admin.address,
    baseline.interface.encodeFunctionData("initialize", [
      bank.address,
      relay.address,
      treasury.address,
      registry.address,
      pool.address,
      1,
    ]),
  ])
  // `owner` (signer 0) is the Bridge governance and the deployer above.
  const bridge = baseline.attach(proxy.address)
  await bank.updateBridge(bridge.address)
  await registryGovernance
    .connect(governance)
    .beginWalletOwnerUpdate(bridge.address)
  await increaseTime((await registryGovernance.governanceDelay()).toNumber())
  await registryGovernance.connect(governance).finalizeWalletOwnerUpdate()
  expect(await registry.walletOwner()).to.equal(bridge.address)
  // A 10-block DKG result challenge period (base integration's value), set
  // through the registry governance, so a DKG completes in 10 blocks.
  await registryGovernance
    .connect(governance)
    .beginDkgResultChallengePeriodLengthUpdate(10)
  await increaseTime((await registryGovernance.governanceDelay()).toNumber())
  await registryGovernance
    .connect(governance)
    .finalizeDkgResultChallengePeriodLengthUpdate()
  await pool.connect(await poolOwner(pool)).authorize(bridge.address)
  await bridge.setSpvMaintainerStatus(maintainer.address, true)
  // Local numeric settings, set before any obligation exists. Deposit:
  // dust 10000, treasury fee 1/100, tx max fee 2000, reveal ahead 30 s.
  await bridge.updateDepositParameters(10000, 100, 2000, 30)
  // Slashing amounts are nonzero: the real TokenStaking refuses a zero seize.
  const SLASH = ethers.utils.parseEther("1")
  // Moving funds: tx max total fee 5000, dust 20000, reset delay 3600,
  // timeout 7 days, slashing 1 T, notifier multiplier 100, commitment gas
  // offset 0, sweep max fee 5000, sweep timeout 10 days, slashing 1 T,
  // notifier multiplier 100.
  await bridge.updateMovingFundsParameters(
    5000,
    20000,
    3600,
    7 * 86400,
    SLASH,
    100,
    0,
    5000,
    10 * 86400,
    SLASH,
    100
  )
  // Redemption: dust 30000 (above the moving-funds dust), fee 1/100, tx
  // max fee 2000, total fee 2000, timeout 5 days, notifier
  // multiplier 100 (slashing 1 T).
  await bridge.updateRedemptionParameters(
    30000,
    100,
    2000,
    2000,
    5 * 86400,
    SLASH,
    100
  )
  // Wallets: creation period 0 and min balance 0, so a new wallet can be
  // requested at any time; max age 365 days; max transfer 250000; closing
  // period 7 days; closure min balance 0.
  const walletParams = await bridge.walletParameters()
  await bridge.updateWalletParameters(
    0,
    0,
    walletParams.walletCreationMaxBtcBalance,
    0,
    365 * 86400,
    250000,
    7 * 86400
  )
  // Fraud: deposit 1 ETH, defeat timeout 7 days, slashing 1 T, notifier 100.
  await bridge.updateFraudParameters(
    ethers.utils.parseEther("1"),
    7 * 86400,
    SLASH,
    100
  )

  // The current implementation and the FROST pieces, deployed but unused
  // until a case upgrades. FIXTURE: the FROST registry callback boundary.
  const implementation = await deployCurrent("Bridge")
  const frostRegistry = await deployCurrent("FrostRegistryFixture", [
    proxy.address,
  ])
  const exposure = await deployCurrent("FrostExposureController", [
    proxy.address,
    owner.address,
  ])
  const sortitionLocked = () => sortitionPool.isLocked()

  return {
    owner,
    alias,
    rebater,
    depositor,
    treasury,
    maintainer,
    challenger,
    keeper,
    manager,
    guardians: [g1, g2, g3],
    deployer,
    governance,
    registry,
    registryGovernance,
    sortitionPool,
    staking,
    t,
    pool,
    beacon,
    bank,
    bridge,
    baseline,
    proxy,
    admin,
    relay,
    implementation,
    frostRegistry,
    exposure,
    build,
    sortitionLocked,
  }
}

async function poolOwner(pool: Contract) {
  return ethers.getSigner(await pool.owner())
}

/// The shared world, built once per process and restored by snapshot.
export const k09World = deployments.createFixture(worldFixture)
export type K09World = Awaited<ReturnType<typeof worldFixture>>

/// Upgrades the proxy in place to this checkout's Bridge and installs the
/// FROST registry FIXTURE and the real exposure controller with test
/// ceilings (D-10 values OPEN). Returns the FROST views on the same proxy.
export async function upgradeToFrost(w: K09World) {
  await w.admin.upgrade(w.proxy.address, w.implementation.address)
  const bridge = w.implementation.attach(w.proxy.address)
  const frost = await ethers.getContractAt("IFrostBridge", w.proxy.address)
  await frost.configureFrostRegistry(w.frostRegistry.address)
  await w.exposure.openBudgetPeriod(
    MAX_UINT64,
    MAX_UINT64,
    ethers.utils.id("K-09 test budget; D-10 OPEN")
  )
  await frost.installFrostExposureController(w.exposure.address)
  return { bridge, frost }
}

/// Mines `count` blocks at once.
export async function mine(count: number) {
  await network.provider.send("hardhat_mine", [ethers.utils.hexValue(count)])
}
export async function increaseTime(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds])
  await mine(1)
}
export async function now() {
  return (await ethers.provider.getBlock("latest")).timestamp
}

/// The real DKG, driven through public calls only.
export function dkg(w: K09World) {
  const selectGroup = async () => {
    const ids: number[] = await w.registry.selectGroup()
    const addresses: string[] = await w.sortitionPool.getIDOperators(ids)
    return Promise.all(
      ids.map(async (id, i) => ({
        id,
        signer: await ethers.getSigner(addresses[i]),
      }))
    )
  }
  /// The relay entry, delivered by the beacon ADAPTER.
  const seed = async () =>
    w.registry
      .connect(w.beacon.wallet)
      .__beaconCallback(ethers.utils.randomBytes(32), 0)
  /// Signs a DKG result for `key` (51 of 100 signatures), not submitted.
  const prepare = async (key: LegacyKey) => {
    const members = await selectGroup()
    const dkgStart = await dkgStartBlock()
    const resultHash = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["uint256", "bytes", "uint8[]", "uint256"],
        [CHAIN_ID, key.groupPubKey, [], dkgStart]
      )
    )
    const signing = members.slice(0, OPERATORS / 2 + 1)
    const signatures = await Promise.all(
      signing.map((m) =>
        m.signer.signMessage(ethers.utils.arrayify(resultHash))
      )
    )
    const ids = members.map((m) => m.id)
    const result = {
      submitterMemberIndex: 1,
      groupPubKey: key.groupPubKey,
      misbehavedMembersIndices: [],
      signatures: ethers.utils.hexConcat(signatures),
      signingMembersIndices: signing.map((_, i) => i + 1),
      members: ids,
      membersHash: ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(["uint32[]"], [ids])
      ),
    }
    return { result, submitter: members[0].signer, members }
  }
  /// Signs and submits a DKG result for `key`.
  const submit = async (key: LegacyKey) => {
    const prepared = await prepare(key)
    await w.registry
      .connect(prepared.submitter)
      .submitDkgResult(prepared.result)
    return prepared
  }
  /// The DKG start block: the block of the last DkgStarted event.
  const dkgStartBlock = async () => {
    const events = await w.registry.queryFilter(w.registry.filters.DkgStarted())
    return events[events.length - 1].blockNumber
  }
  const challengeOver = async () =>
    mine(
      (await w.registry.dkgParameters()).resultChallengePeriodLength.toNumber()
    )
  const state = async (): Promise<number> => w.registry.getWalletCreationState()
  return {
    seed,
    prepare,
    submit,
    challengeOver,
    state,
    selectGroup,
    dkgStartBlock,
  }
}

/// Registers a legacy wallet through the whole real DKG on whatever Bridge
/// implementation the proxy runs: request, seed, result, challenge period,
/// approval by the submitter. Returns the key and the group members.
export async function createLegacyWallet(
  w: K09World,
  bridge: Contract,
  key: LegacyKey,
  activeMain = NO_MAIN
) {
  const d = dkg(w)
  await bridge.requestNewWallet(activeMain)
  await d.seed()
  const { result, submitter, members } = await d.submit(key)
  await d.challengeOver()
  await w.registry.connect(submitter).approveDkgResult(result)
  expect((await bridge.wallets(key.pkh)).state).to.equal(LegacyState.Live)
  return {
    ...key,
    members: members.map((m) => m.id),
    signers: members.map((m) => m.signer),
  }
}
export type LegacyWallet = Awaited<ReturnType<typeof createLegacyWallet>>

/// Fixed-layout storage of the proxy (Bridge), registry and sortition pool,
/// plus the exposure controller. Mappings are covered by the per-test
/// getters each frame adds.
export async function storageFrame(w: K09World) {
  const bridgeEnd = await layoutEnd("contracts/bridge/Bridge.sol:Bridge")
  const registryEnd = await layoutEnd(
    "@keep-network/ecdsa/contracts/WalletRegistry.sol:WalletRegistry"
  )
  const exposureEnd = await layoutEnd(
    "contracts/frost/FrostExposureController.sol:FrostExposureController"
  )
  return {
    bridge: await fixedSlots(w.proxy.address, bridgeEnd),
    registry: await fixedSlots(w.registry.address, registryEnd),
    sortitionPool: await fixedSlots(w.sortitionPool.address, 16),
    exposure: await fixedSlots(w.exposure.address, exposureEnd),
    poolBalance: (await ethers.provider.getBalance(w.pool.address)).toString(),
  }
}
