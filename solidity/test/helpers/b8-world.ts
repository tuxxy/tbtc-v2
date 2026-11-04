/* eslint-disable no-await-in-loop, no-restricted-syntax */
// Remediation batch 8 world (ADV-C1 + tuxxy/tbtc-v2#49, ADV-C2, RebateStaking;
// owner decisions of 2026-11-04 in K-09-restart/DECISIONS.md).
//
// Built on the K-09 contract-only world (`k09-registry-world`), so every
// piece that is real there is real here:
// - the 40a11d1d Bank and Bridge (D1, `legacyBaselineBuild`) behind a real
//   transparent proxy, upgraded in place to this checkout's Bridge;
// - the real ECDSA WalletRegistry stack with 100 staked operators; the legacy
//   drain source and the active legacy wallet come from its real DKG, and
//   the source is funded by a real reveal and deposit sweep proof and enters
//   MovingFunds through `notifyWalletCloseable`, all on 40a11d1d;
// - the C-10 sequence after the upgrade (drain begins, cutover completes,
//   FrostOnly), with the real exposure controller (test ceilings, D-10 OPEN);
// - FROST wallets are funded by real FROST reveals and deposit sweep proofs
//   and enter MovingFunds through the real `notifyFrostWalletCloseable`.
//
// ADAPTERs and FIXTUREs (labelled; no success claim rests on them alone):
// - FIXTURE FROST registry: `FrostRegistryFixture` creates and readies the
//   FROST wallets (the callback boundary; the FROST DKG is keep-core's).
// - ADAPTER relay and beacon: as in `k09-registry-world`. Proofs are
//   synthetic regtest blocks; `deepInclusion` adds linked headers so a proof
//   carries the mainnet `txProofDifficultyFactor` (6) headers, the deepest
//   proof a maintainer submits. Bitcoin spend validity is out of scope.
// - No Bridge or registry storage is ever written.
// - The 40a11d1d rebate witness (`baselineRebate`) runs on the baseline
//   Bridge inside an EVM snapshot that is reverted before the upgrade, so
//   the world continues with RebateStaking unset; rebate cases set it again
//   on the upgraded Bridge (the same storage field) and repeat the reveal.
import { deployments, ethers } from "hardhat"
import { expect } from "chai"
import { createHash } from "crypto"
import {
  transaction,
  inclusion,
  p2tr,
  p2wpkh,
  ascending,
  split,
  TYPE,
  ZERO,
  deploy,
  outpoint,
  Tx,
} from "./frost-movement-world"
import {
  k09World,
  createLegacyWallet,
  legacyKey,
  increaseTime,
  now,
  MAX_UINT64,
  LegacyState,
} from "./k09-registry-world"
import { depositScript, Utxo } from "./k09-legacy-ledger"

export const GAS_CAP = 16777216 // 2^24, the per-transaction gas cap
export const TARGET_CAP = 128 // ADV-C1/#49 decision: at most 128 targets
export const PROOF_DEPTH = 6 // mainnet txProofDifficultyFactor
export const MOVE_FEE = 3000 // under movingFundsTxMaxTotalFee 5000
export const FROST_WALLETS = 130 // a source plus 129 eligible targets
export const SOURCE_MAIN = 13000000 // satoshi, both route sources
const SWEEP_FEE = 1000
export const REBATE_WINDOW = 30 * 86400
export const REBATE_CAP = 600 // T staked, so a 600-sat rebate cap
export const REBATE_DEPOSIT = 100000 // treasury fee 1,000 at divisor 100

const sha = (b: Buffer) => createHash("sha256").update(b).digest()
const sha256d = (b: Buffer) => sha(sha(b))

/// `inclusion` with `depth` linked regtest headers (the first carries the
/// transaction's merkle root). ADAPTER: synthetic blocks, difficulty 0.
export function deepInclusion(hash: string, depth = PROOF_DEPTH) {
  const base = inclusion(hash)
  const headers = [Buffer.from(base.bitcoinHeaders.slice(2), "hex")]
  const target = ethers.BigNumber.from("0x7fffff").shl(8 * 29)
  for (let i = 1; i < depth; i++) {
    const h = Buffer.alloc(80)
    h.writeUInt32LE(2, 0)
    sha256d(headers[i - 1]).copy(h, 4)
    sha(Buffer.from(`B8 header ${hash} ${i}`)).copy(h, 36)
    h.writeUInt32LE(1700000000 + i, 68)
    h.writeUInt32LE(0x207fffff, 72)
    let nonce = 0
    while (
      ethers.BigNumber.from(
        `0x${Buffer.from(sha256d(h)).reverse().toString("hex")}`
      ).gt(target)
    ) {
      nonce += 1
      if (nonce > 10000) throw Error("Regtest nonce search cap")
      h.writeUInt32LE(nonce, 76)
    }
    headers.push(h)
  }
  return {
    ...base,
    bitcoinHeaders: `0x${Buffer.concat(headers).toString("hex")}`,
  }
}

export type FrostWallet = {
  q: string
  id: string
  label: string
  descriptorHash: string
  main?: Tx
  value: number
}

async function b8Fixture() {
  const w = await k09World()
  const { alias, maintainer, keeper, owner } = w
  const legacy = w.bridge // the 40a11d1d ABI, before the upgrade

  // Legacy wallets through the real DKG: S (drain source) first, H last so H
  // stays the active wallet (notifyWalletCloseable refuses the active one).
  const S = await createLegacyWallet(w, legacy, legacyKey(0x8100))
  const H = await createLegacyWallet(w, legacy, legacyKey(0x8101))

  // S: one real legacy reveal and deposit sweep on 40a11d1d.
  const lockBuf = Buffer.alloc(4)
  lockBuf.writeUInt32LE((await now()) + 400 * 86400)
  const lock = `0x${lockBuf.toString("hex")}`
  const blinding = ethers.utils.hexZeroPad("0xb8", 8)
  const script = depositScript(alias.address, blinding, S.pkh, S.pkh, lock)
  const amount = SOURCE_MAIN + SWEEP_FEE
  const funding = transaction(
    [[ethers.utils.id("B8 legacy funding"), 0]],
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
  await legacy.connect(alias).revealDeposit(funding.tx, {
    fundingOutputIndex: 0,
    blindingFactor: blinding,
    walletPubKeyHash: S.pkh,
    refundPubKeyHash: S.pkh,
    refundLocktime: lock,
    vault: ethers.constants.AddressZero,
  })
  const sweep = transaction(
    [[funding.hash, 0]],
    [{ value: SOURCE_MAIN, script: p2wpkh(S.pkh) }]
  )
  await legacy
    .connect(maintainer)
    .submitDepositSweepProof(
      sweep.tx,
      inclusion(sweep.hash),
      { txHash: ZERO, txOutputIndex: 0, txOutputValue: 0 },
      ethers.constants.AddressZero
    )
  const sMain: Utxo = {
    txHash: sweep.hash,
    txOutputIndex: 0,
    txOutputValue: SOURCE_MAIN,
  }
  // RebateStaking: the real contract (unchanged since 40a11d1d) behind a
  // proxy: 1 T of stake per satoshi of rebate, 30-day rolling window. It is
  // deployed here but not set; the rebate cases set it themselves.
  const rebate = await (async () => {
    const implementation = await deploy("RebateStaking")
    const proxy = await deploy("TransparentUpgradeableProxy", [
      implementation.address,
      w.admin.address,
      implementation.interface.encodeFunctionData("initialize", [
        legacy.address,
        w.t.address,
        REBATE_WINDOW,
        REBATE_WINDOW,
        ethers.utils.parseEther("1"),
      ]),
    ])
    return implementation.attach(proxy.address)
  })()
  const { rebater } = w
  const stakeRebater = async () => {
    const stake = ethers.utils.parseEther(String(REBATE_CAP))
    await w.t.connect(w.deployer).mint(rebater.address, stake)
    await w.t.connect(rebater).approve(rebate.address, stake)
    await rebate.connect(rebater).stake(stake)
  }
  /// The same legacy reveal to H by `rebater`, on whichever Bridge runs.
  const legacyRebateReveal = async (bridgeNow: any) => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE((await now()) + 400 * 86400)
    const lk = `0x${b.toString("hex")}`
    const bl = ethers.utils.hexZeroPad("0xb8b8", 8)
    const sc = depositScript(rebater.address, bl, H.pkh, H.pkh, lk)
    const fx = transaction(
      [[ethers.utils.id("B8 legacy rebate funding"), 0]],
      [
        {
          value: REBATE_DEPOSIT,
          script: Buffer.from(
            `220020${ethers.utils.sha256(sc).slice(2)}`,
            "hex"
          ),
        },
      ]
    )
    await bridgeNow.connect(rebater).revealDeposit(fx.tx, {
      fundingOutputIndex: 0,
      blindingFactor: bl,
      walletPubKeyHash: H.pkh,
      refundPubKeyHash: H.pkh,
      refundLocktime: lk,
      vault: ethers.constants.AddressZero,
    })
    return outpoint(fx.hash, 0)
  }
  /// What the rebate looks like: the deposit's fee, the rebates recorded,
  /// the available rebate now and after the rolling window.
  const rebateRecord = async (bridgeNow: any, key: string) => {
    const length = (await rebate.getRebateLength(rebater.address)).toNumber()
    const rebates = []
    for (let i = 0; i < length; i++)
      rebates.push(
        (await rebate.getRebate(rebater.address, i)).feeRebate.toString()
      )
    const record = {
      treasuryFee: (await bridgeNow.deposits(key)).treasuryFee.toString(),
      rebates,
      available: (await rebate.getAvailableRebate(rebater.address)).toString(),
      availableAfterWindow: "",
    }
    await increaseTime(REBATE_WINDOW + 1)
    record.availableAfterWindow = (
      await rebate.getAvailableRebate(rebater.address)
    ).toString()
    return record
  }
  // The 40a11d1d witness: set, stake, reveal, record; then undone, so the
  // world continues with RebateStaking unset.
  const beforeWitness = await ethers.provider.send("evm_snapshot", [])
  await legacy.setRebateStaking(rebate.address)
  await stakeRebater()
  const baselineRebate = await rebateRecord(
    legacy,
    await legacyRebateReveal(legacy)
  )
  expect(
    await ethers.provider.send("evm_revert", [beforeWitness]),
    "baseline rebate witness reverted"
  ).to.equal(true)
  expect(await legacy.getRebateStaking()).to.equal(ethers.constants.AddressZero)

  // Old enough to be closeable (walletMaxAge 365 days in the K-09 world).
  await increaseTime(366 * 86400)
  await legacy.connect(alias).notifyWalletCloseable(S.pkh, sMain)
  expect((await legacy.wallets(S.pkh)).state).to.equal(LegacyState.MovingFunds)

  // The upgrade, FROST configuration and the C-10 cutover (FrostOnly).
  await w.admin.upgrade(w.proxy.address, w.implementation.address)
  const bridge = w.implementation.attach(w.proxy.address)
  const frost = await ethers.getContractAt("IFrostBridge", w.proxy.address)
  const lifecycle = await ethers.getContractAt(
    "IFrostLifecycleBridge",
    w.proxy.address
  )
  await frost.configureFrostRegistry(w.frostRegistry.address)
  const verifier = await deploy("FrostVerifier")
  const genesis = ethers.utils.id("B8 synthetic regtest domain")
  await frost.configureFrostFunding(
    verifier.address,
    ethers.utils.keccak256(await ethers.provider.getCode(verifier.address)),
    ethers.utils.id("UNQUALIFIED B8 local test"),
    genesis
  )
  await w.exposure.openBudgetPeriod(
    MAX_UINT64,
    MAX_UINT64,
    ethers.utils.id("B8 test budget; D-10 OPEN")
  )
  await frost.installFrostExposureController(w.exposure.address)
  await frost.setFrostFundingGates(true, true)
  await frost.beginLegacyDkgDrain()
  await frost.completeFrostCutover(ethers.utils.id("B8 cutover manifest"))
  await frost.setFrostDrainEnabled(true)

  // FROST wallets through the registry FIXTURE callbacks. Seat 0 is
  // `keeper`, the commitment submitter in every case.
  const { chainId } = await ethers.provider.getNetwork()
  const wallets: FrostWallet[] = []
  const epoch = await ethers.provider.getBlockNumber()
  const deadline = epoch + 1000000
  const created: string[] = []
  for (let i = 0; i < FROST_WALLETS; i++) {
    const pub = ethers.utils.computePublicKey(
      ethers.utils.hexZeroPad(ethers.utils.hexlify(0x9000 + i), 32),
      true
    )
    const q = `0x${pub.slice(4)}`
    const descriptor = {
      scheme: 2,
      profile: 1,
      chainId,
      registry: w.frostRegistry.address,
      epoch,
      members: [1, 2, 3],
      operators: [keeper.address, owner.address, alias.address],
      threshold: 2,
      snowfallDescriptor: ethers.utils.id(`B8 FROST wallet ${i}`),
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
    created.push(ethers.utils.defaultAbiCoder.encode([TYPE], [descriptor]))
    wallets.push({ q, id, label: id.slice(0, 42), descriptorHash, value: 0 })
  }
  // The callbacks are sent together with explicit nonces (automine still
  // mines them one by one, in nonce order); then each wallet is checked.
  // Explicit gas limits skip a per-transaction estimate.
  const send = async (calls: ((nonce: number) => Promise<any>)[]) => {
    const first = await owner.getTransactionCount()
    const sent = await Promise.all(calls.map((call, i) => call(first + i)))
    await Promise.all(sent.map((tx) => tx.wait()))
  }
  await send(
    created.map(
      (d) => (nonce: number) =>
        w.frostRegistry.connect(owner).created(d, deadline, {
          nonce,
          gasLimit: 2000000,
        })
    )
  )
  await send(
    wallets.map(
      (x) => (nonce: number) =>
        w.frostRegistry.connect(owner).ready(x.id, x.descriptorHash, {
          nonce,
          gasLimit: 2000000,
        })
    )
  )
  expect(
    (await frost.frostMovementCounters(wallets[0].id)).eligibleTargets,
    "every FROST wallet is ready"
  ).to.equal(FROST_WALLETS)

  let revealed = 0
  /// FROST deposit terms for `x`, depositor `alias`.
  const terms = async (x: FrostWallet, value: number) => {
    revealed += 1
    return {
      chainId,
      bridge: w.proxy.address,
      bitcoinGenesis: genesis,
      fullWalletId: x.id,
      descriptorHash: x.descriptorHash,
      depositor: alias.address,
      vault: ethers.constants.AddressZero,
      blinding: ethers.utils.hexZeroPad(ethers.utils.hexlify(revealed), 8),
      amount: value,
      refundKey: x.q,
      refundLocktime: (await now()) + 86400,
      extraData: ZERO,
    }
  }
  /// One FROST reveal; returns the terms and the funding transaction.
  const revealFrost = async (x: FrostWallet, value: number) => {
    const t = await terms(x, value)
    const output = await frost.frostDepositOutput(t)
    const fundingTx = transaction(
      [[ethers.utils.id(`B8 FROST funding ${revealed}`), 0]],
      [{ value, script: p2tr(output.key) }]
    )
    return { t, fundingTx }
  }
  /// Fund an unfunded FROST wallet with a real reveal and deposit sweep.
  const fundFrost = async (x: FrostWallet, value: number) => {
    const { t, fundingTx } = await revealFrost(x, value)
    await frost.connect(alias).revealFrostDeposit(t, fundingTx.tx, 0)
    const main = transaction(
      [[fundingTx.hash, 0]],
      [{ value: value - SWEEP_FEE, script: p2tr(x.q) }]
    )
    await frost.connect(maintainer).submitFrostDepositSweepProof({
      walletId: x.id,
      transaction: main.tx,
      proof: inclusion(main.hash),
      includeMain: false,
      vault: ethers.constants.AddressZero,
    })
    /* eslint-disable no-param-reassign */
    x.main = main
    x.value = value - SWEEP_FEE
    /* eslint-enable no-param-reassign */
  }
  // F, the FROST-to-FROST source: the same custody as S.
  const [F] = wallets
  await fundFrost(F, SOURCE_MAIN + SWEEP_FEE)

  return {
    ...w,
    legacy,
    bridge,
    frost,
    lifecycle,
    genesis,
    S: { ...S, main: sMain },
    H,
    F,
    pool: wallets.slice(1), // 129 FROST wallets, never funded here
    wallets,
    revealFrost,
    fundFrost,
    rebate,
    stakeRebater,
    legacyRebateReveal,
    rebateRecord,
    baselineRebate,
  }
}

export const b8World = deployments.createFixture(b8Fixture)
export type B8World = Awaited<ReturnType<typeof b8Fixture>>

/// Governance sets walletMaxBtcTransfer so that `value` needs exactly `n`
/// targets under the rule in force: ceil(value / max) == n.
export async function requireTargets(w: B8World, value: number, n: number) {
  const max = Math.ceil(value / n)
  expect(Math.ceil(value / max), "requireTargets").to.equal(n)
  const p = await w.bridge.walletParameters()
  await w.bridge.updateWalletParameters(
    p.walletCreationPeriod,
    p.walletCreationMinBtcBalance,
    p.walletCreationMaxBtcBalance,
    p.walletClosureMinBtcBalance,
    p.walletMaxAge,
    max,
    p.walletClosingPeriod
  )
}

/// Governance lowers walletMaxAge so the real age rule makes FROST wallets
/// closeable now.
export async function ageOut(w: B8World) {
  const p = await w.bridge.walletParameters()
  await w.bridge.updateWalletParameters(
    p.walletCreationPeriod,
    p.walletCreationMinBtcBalance,
    p.walletCreationMaxBtcBalance,
    p.walletClosureMinBtcBalance,
    1,
    p.walletMaxBtcTransfer,
    p.walletClosingPeriod
  )
}

/// The movement transaction of `source` (its main `hash`/`value`) to
/// `targets`: one input, the legacy equal split after MOVE_FEE.
export function movementTx(
  hash: string,
  value: number,
  targets: FrostWallet[]
) {
  const values = split(value - MOVE_FEE, targets.length)
  return transaction(
    [[hash, 0]],
    targets.map((t, i) => ({ value: values[i], script: p2tr(t.q) }))
  )
}

export const reason = (error: any) =>
  String(error?.reason ?? error?.error?.message ?? error?.message ?? error)

export { ascending, increaseTime, now, LegacyState }
