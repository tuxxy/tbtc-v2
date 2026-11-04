/* eslint-disable no-await-in-loop, no-restricted-syntax, no-bitwise */
// K-09 legacy obligation ledger world (tuxxy/tbtc-v2#16, tuxxy/keep-core#25).
//
// Every legacy obligation class of the 40a11d1d Bridge is created on that
// Bridge, through public calls only, by legacy wallets registered through the
// real ECDSA WalletRegistry DKG (`k09-registry-world`). The proxy is then
// upgraded in place, the legacy DKG drain begins while a DKG is in flight, the
// in-flight DKG completes, the C-10 cutover completes (FrostOnly), a FROST
// wallet is created after the cutover, and exposure is contained. Each
// witness case starts from that composed snapshot and discharges one class.
//
// Bitcoin side: synthetic regtest inclusion proofs over an ADAPTER relay
// (integer difficulty 0). Transactions carry no signatures: the Bridge checks
// structure and inclusion only. Spend validity is out of scope (rule 3).
import { deployments, ethers } from "hardhat"
import { expect } from "chai"
import type { Contract } from "ethers"
import {
  transaction,
  inclusion,
  p2wpkh,
  p2tr,
  outpoint,
  raw,
  TYPE,
  Tx,
} from "./frost-movement-world"
import {
  k09World,
  K09World,
  createLegacyWallet,
  dkg,
  legacyKey,
  LegacyWallet,
  signDigest,
  increaseTime,
  mine,
  now,
  NO_MAIN,
  MAX_UINT64,
  storageFrame,
} from "./k09-registry-world"

export type Utxo = {
  txHash: string
  txOutputIndex: number
  txOutputValue: number
}
export const utxoHash = (u: Utxo) =>
  ethers.utils.solidityKeccak256(
    ["bytes32", "uint32", "uint64"],
    [u.txHash, u.txOutputIndex, u.txOutputValue]
  )
const sha = (hex: string) => ethers.utils.sha256(hex)
export const hash256 = (hex: string) => sha(sha(hex))
export const redemptionKey = (pkh: string, script: string) =>
  ethers.utils.solidityKeccak256(
    ["bytes32", "bytes20"],
    [ethers.utils.keccak256(script), pkh]
  )
export const challengeKey = (key: LegacyWallet, sighash: string) =>
  ethers.utils.solidityKeccak256(
    ["bytes", "bytes32"],
    [key.groupPubKey, sighash]
  )

/// The legacy deposit script of the 40a11d1d Bridge (`Deposit._revealDeposit`).
export function depositScript(
  depositor: string,
  blinding: string,
  pkh: string,
  refundPkh: string,
  locktime: string,
  extraData?: string
) {
  const extra = extraData ? `20${extraData.slice(2)}75` : ""
  return `0x14${depositor.slice(2)}75${extra}08${blinding.slice(
    2
  )}7576a914${pkh.slice(2)}8763ac6776a914${refundPkh.slice(
    2
  )}8804${locktime.slice(2)}b175ac68`
}

// Amounts (satoshi). Deposit dust 10000, treasury fee 1/100, sweep fee 1000.
export const SWEEP_FEE = 1000
export const FUND = 100000
export const RED_AMOUNT = 40000
export const BOND = ethers.utils.parseEther("1")

async function ledgerFixture() {
  const w = await k09World()
  const { alias, maintainer } = w
  const legacy = w.bridge // the 40a11d1d ABI, before the upgrade
  let nonce = 0
  const fresh = (label: string) => {
    nonce += 1
    return ethers.utils.id(`K09 ${label} ${nonce}`)
  }

  // Watchtower: the real RedemptionWatchtower (unchanged since 40a11d1d)
  // behind a proxy, enabled with three guardians.
  const { deploy } = await import("./frost-movement-world")
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

  // Legacy wallets through the real DKG. H is created last and stays the
  // active wallet; notifyWalletCloseable refuses the active wallet.
  const names = [
    "R", // pending redemption (proof) and a vetoed redemption
    "T", // pending redemption (timeout)
    "U", // redemption timed out before the upgrade (proof after)
    "M", // MovingFunds, no commitment (timeout, reset)
    "Y", // MovingFunds below dust
    "A", // MovingFunds with a legacy commitment (proof, timeout)
    "A3", // moved its funds to B before the upgrade, now Closing
    "B", // target with a pending moved-funds sweep request
    "F", // three open fraud challenges
    "L", // Live, closeable after the cutover
    "D", // two revealed, unswept deposits
    "H", // Live, heartbeat failure through the registry; active wallet
  ] as const
  type Name = typeof names[number]
  const wallets = {} as Record<Name, LegacyWallet>
  let active: Utxo = NO_MAIN
  const mains = {} as Partial<Record<Name, Utxo>>
  for (const [i, name] of names.entries()) {
    wallets[name] = await createLegacyWallet(
      w,
      legacy,
      legacyKey(0x1000 + i),
      active
    )
    active = NO_MAIN // every new wallet starts without a main
  }

  // Reveal and sweep one deposit into a wallet; returns its new main.
  const locktime = async () => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE((await now()) + 120 * 86400)
    return `0x${b.toString("hex")}`
  }
  const revealTo = async (
    x: LegacyWallet,
    amount: number,
    extraData?: string
  ) => {
    nonce += 1
    const blinding = ethers.utils.hexZeroPad(ethers.utils.hexlify(nonce), 8)
    const lock = await locktime()
    const script = depositScript(
      alias.address,
      blinding,
      x.pkh,
      x.pkh,
      lock,
      extraData
    )
    const funding = transaction(
      [[fresh("funding"), 0]],
      [
        {
          value: amount,
          script: Buffer.from(`220020${sha(script).slice(2)}`, "hex"),
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
    if (extraData)
      await legacy
        .connect(alias)
        .revealDepositWithExtraData(funding.tx, reveal, extraData)
    else await legacy.connect(alias).revealDeposit(funding.tx, reveal)
    return funding
  }
  const sweepTx = (x: LegacyWallet, fundings: Tx[], amounts: number[]) =>
    transaction(
      fundings.map((f) => [f.hash, 0] as [string, number]),
      [
        {
          value: amounts.reduce((a, b) => a + b, 0) - SWEEP_FEE,
          script: p2wpkh(x.pkh),
        },
      ]
    )
  const fund = async (name: Name, amount: number) => {
    const x = wallets[name]
    const funding = await revealTo(x, amount)
    const sweep = sweepTx(x, [funding], [amount])
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
    return { funding, sweep }
  }
  for (const name of ["R", "T", "U", "M", "A", "A3", "L", "H"] as Name[])
    await fund(name, FUND)
  const fFunding = await fund("F", FUND)
  await fund("Y", 15000) // main 14000, below the 20000 moving-funds dust

  // Wallets old enough to be closeable.
  await increaseTime(366 * 86400)

  // Redemptions: the redeemer holds Bank balance from the sweeps above.
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
  // U: redemption timed out before the upgrade; U is MovingFunds.
  const uScript = await request("U", 3)
  await increaseTime(5 * 86400 + 1)
  await legacy
    .connect(alias)
    .notifyRedemptionTimeout(wallets.U.pkh, wallets.U.members, uScript)

  // MovingFunds without commitment (M, Y), with a commitment (A), and A3
  // whose movement to B was proven before the upgrade (A3 Closing, B owes a
  // moved-funds sweep).
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
      [[(mains[name] as Utxo).txHash, 0]],
      [
        {
          value: (mains[name] as Utxo).txOutputValue - SWEEP_FEE,
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

  // RebateStaking, live on mainnet: the real contract (unchanged since
  // 40a11d1d) behind a proxy, set on the 40a11d1d Bridge before the
  // requests. 1 T of stake per satoshi of rebate, 30-day window. `rebater`
  // stakes 600 T (a 600-sat cap) for redemption fees only.
  const rebate = await (async () => {
    const implementation = await deploy("RebateStaking")
    const proxy = await deploy("TransparentUpgradeableProxy", [
      implementation.address,
      w.admin.address,
      implementation.interface.encodeFunctionData("initialize", [
        legacy.address,
        w.t.address,
        30 * 86400,
        30 * 86400,
        ethers.utils.parseEther("1"),
      ]),
    ])
    return implementation.attach(proxy.address)
  })()
  await legacy.setRebateStaking(rebate.address)
  const { rebater } = w
  const stake = ethers.utils.parseEther("600")
  await w.t.connect(w.deployer).mint(rebater.address, stake)
  await w.t.connect(rebater).approve(rebate.address, stake)
  await rebate.connect(rebater).stake(stake)
  await rebate.connect(rebater).setRebateTreasuryFeeMode(2) // RedemptionOnly
  await w.bank.connect(alias).transferBalance(rebater.address, 2 * RED_AMOUNT)

  // Pending redemptions created now: R (proof; alias, no rebate), T
  // (timeout; rebater through receiveBalanceApproval, the Bank
  // approve-and-call creator: rebate 400 of the 400-sat fee) and R's second
  // request (veto; rebater: rebate 200, the rest of the cap).
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
          mains.T?.txHash,
          0,
          mains.T?.txOutputValue,
          tScript,
        ]
      )
    )
  const vScript = script(4)
  await w.bank.connect(rebater).approveBalance(legacy.address, RED_AMOUNT)
  await legacy
    .connect(rebater)
    .requestRedemption(wallets.R.pkh, mains.R, vScript, RED_AMOUNT)

  // D: two revealed, never swept deposits (plain and with extra data).
  const d1 = await revealTo(wallets.D, 50000)
  const d2 = await revealTo(wallets.D, 60000, fresh("extra data"))

  // F: three open challenges, each signed by F's key: a sighash whose input
  // spends F's swept deposit (BIP-143 shaped preimage), a heartbeat, and an
  // arbitrary digest (only the timeout can resolve it).
  const le32 = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(n)
    return b.toString("hex")
  }
  const preimage = `0x${"02000000"}${"11".repeat(32)}${"22".repeat(
    32
  )}${fFunding.funding.hash.slice(2)}${le32(0)}1976a914${wallets.F.pkh.slice(
    2
  )}88ac${"a086010000000000"}${"ffffffff"}${"33".repeat(32)}${le32(0)}${le32(
    1
  )}`
  const heartbeat = `0xffffffffffffffff${"0000000000000007"}`
  const arbitrary = fresh("arbitrary signed digest")
  const challenge = async (message: string) => {
    const preimageSha256 = sha(message)
    const sighash = sha(preimageSha256)
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
  const fPreimage = await challenge(preimage)
  const fHeartbeat = await challenge(heartbeat)
  const fArbitrary = await challenge(arbitrary)

  // Z: a DKG in flight (AWAITING_RESULT) across the upgrade.
  const d = dkg(w)
  // H is the active wallet; the request names its current main.
  await legacy.requestNewWallet(mains.H)
  await d.seed()
  const zKey = legacyKey(0x2000)
  const preUpgrade = await storageFrame(w)

  // The upgrade, FROST configuration and the C-10 sequence.
  await w.admin.upgrade(w.proxy.address, w.implementation.address)
  const bridge = w.implementation.attach(w.proxy.address)
  const frost = await ethers.getContractAt("IFrostBridge", w.proxy.address)
  await frost.configureFrostRegistry(w.frostRegistry.address)
  const verifier = await deploy("FrostVerifier")
  const genesis = ethers.utils.id("K09 synthetic regtest domain")
  await frost.configureFrostFunding(
    verifier.address,
    ethers.utils.keccak256(await ethers.provider.getCode(verifier.address)),
    ethers.utils.id("UNQUALIFIED K09 local test"),
    genesis
  )
  await w.exposure.openBudgetPeriod(
    MAX_UINT64,
    MAX_UINT64,
    ethers.utils.id("K-09 test budget; D-10 OPEN")
  )
  await frost.installFrostExposureController(w.exposure.address)
  await frost.setFrostFundingGates(true, true)
  await frost.beginLegacyDkgDrain()
  const z = await d.submit(zKey)
  await d.challengeOver()
  await w.registry.connect(z.submitter).approveDkgResult(z.result)
  const zRegisteredIn = Number(await frost.frostCreationMode())
  const manifest = ethers.utils.id("K09 cutover manifest")
  await frost.completeFrostCutover(manifest)

  // K09-4: a new wallet after the cutover is a FROST wallet, created through
  // the FROST registry callbacks (FIXTURE boundary; the FROST DKG itself is
  // keep-core's).
  await frost.setFrostRequestsEnabled(true)
  await frost.requestNewFrostWallet()
  const { chainId } = await ethers.provider.getNetwork()
  const qKey = ethers.utils.computePublicKey(
    ethers.utils.hexZeroPad("0x3000", 32),
    true
  )
  const q = `0x${qKey.slice(4)}`
  const descriptor = {
    scheme: 2,
    profile: 1,
    chainId,
    registry: w.frostRegistry.address,
    epoch: await ethers.provider.getBlockNumber(),
    members: [1, 2, 3],
    operators: [
      wallets.H.signers[0].address,
      wallets.H.signers[1].address,
      wallets.H.signers[2].address,
    ],
    threshold: 2,
    snowfallDescriptor: ethers.utils.id("K09 post-cutover FROST wallet"),
    outputKey: q,
  }
  const descriptorHash = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["bytes32", TYPE],
      [ethers.utils.id("tbtc-v2/frost-descriptor/v1"), descriptor]
    )
  )
  const qId = ethers.utils.keccak256(
    ethers.utils.concat([ethers.utils.id("tbtc-v2/frost-wallet-id/v1"), q])
  )
  await w.frostRegistry.created(
    ethers.utils.defaultAbiCoder.encode([TYPE], [descriptor]),
    (await ethers.provider.getBlockNumber()) + 100000
  )
  await w.frostRegistry.ready(qId, descriptorHash)
  await frost.setFrostDrainEnabled(true)
  const containReason = ethers.utils.id("K09 containment")
  await w.exposure.contain(containReason)

  const frostWallet = {
    q,
    id: qId,
    label: qId.slice(0, 42),
    descriptor,
    descriptorHash,
    privateScalar: "0x3000",
  }
  return {
    ...w,
    legacy,
    bridge,
    frost,
    tower,
    rebate,
    genesis,
    wallets,
    mains: mains as Record<Name, Utxo>,
    scripts: { R: rScript, T: tScript, U: uScript, V: vScript },
    deposits: { d1, d2 },
    a3Movement,
    movementTx,
    sweepTx,
    challenges: {
      preimage: fPreimage,
      heartbeat: fHeartbeat,
      arbitrary: fArbitrary,
    },
    z: {
      key: zKey,
      members: z.members.map((m) => m.id),
      registeredIn: zRegisteredIn,
    },
    manifest,
    frostWallet,
    containReason,
    preUpgrade,
  }
}

export const ledgerWorld = deployments.createFixture(ledgerFixture)
export type LedgerWorld = Awaited<ReturnType<typeof ledgerFixture>>

/// The whole observable frame of the composed world, keyed so a witness can
/// name exactly which entries its discharge changes. Contract ETH balances
/// are included; EOA balances (gas) are not.
export async function ledgerFrame(l: LedgerWorld) {
  const f: Record<string, string> = {}
  const put = (k: string, v: unknown) => {
    f[k] = JSON.stringify(v, (_, x) =>
      x && x.type === "BigNumber" ? x.hex : x
    )
  }
  for (const [name, x] of Object.entries(l.wallets)) {
    put(`wallet:${name}`, await l.bridge.wallets(x.pkh))
    put(`registry:${name}`, await l.registry.isWalletRegistered(x.walletID))
  }
  put("wallet:Z", await l.bridge.wallets(l.z.key.pkh))
  put("activeWallet", await l.bridge.activeWalletPubKeyHash())
  const depositKeys = {
    d1: outpoint(l.deposits.d1.hash, 0),
    d2: outpoint(l.deposits.d2.hash, 0),
  }
  for (const [k, key] of Object.entries(depositKeys))
    put(`deposit:${k}`, await l.bridge.deposits(key))
  for (const [k, s] of Object.entries(l.scripts)) {
    const name = k === "V" ? "R" : k
    const key = redemptionKey(l.wallets[name as "R"].pkh, s)
    put(`pending:${k}`, await l.bridge.pendingRedemptions(key))
    put(`timedOut:${k}`, await l.bridge.timedOutRedemptions(key))
    put(`veto:${k}`, await l.tower.vetoProposals(key))
  }
  for (const [k, c] of Object.entries(l.challenges))
    put(
      `challenge:${k}`,
      await l.bridge.fraudChallenges(challengeKey(l.wallets.F, c.sighash))
    )
  put(
    "sweepRequest:A3",
    await l.bridge.movedFundsSweepRequests(outpoint(l.a3Movement.hash, 0))
  )
  put("rebate:rebater", [
    await l.rebate.getAvailableRebate(l.rebater.address),
    await Promise.all(
      Array.from(
        {
          length: (
            await l.rebate.getRebateLength(l.rebater.address)
          ).toNumber(),
        },
        (_, i) => l.rebate.getRebate(l.rebater.address, i)
      )
    ),
  ])
  for (const [k, a] of Object.entries({
    alias: l.alias.address,
    rebater: l.rebater.address,
    treasury: l.treasury.address,
    bridge: l.bridge.address,
    tower: l.tower.address,
  }))
    put(`bank:${k}`, await l.bank.balanceOf(a))
  put("eth:bridge", await ethers.provider.getBalance(l.bridge.address))
  put("eth:pool", await ethers.provider.getBalance(l.pool.address))
  put("frost:mode", await l.frost.frostCreationMode())
  put("frost:manifest", await l.frost.frostCutoverManifest())
  put("frost:lifecycle", await l.frost.frostWalletLifecycle(l.frostWallet.id))
  put("frost:custody", await l.frost.frostWalletCustody(l.frostWallet.id))
  put("frost:descriptor", await l.frost.walletDescriptor(l.frostWallet.label))
  put("frost:counters", await l.frost.frostMovementCounters(l.frostWallet.id))
  put(
    "frost:obligations",
    await l.frost.frostClosureObligations(l.frostWallet.id)
  )
  put("exposure", (await storageFrame(l)).exposure)
  put("exposure:contained", await l.exposure.contained())
  return f
}

/// Asserts that exactly `expected` frame entries changed.
export function changedKeys(
  before: Record<string, string>,
  after: Record<string, string>
) {
  return Object.keys(after)
    .filter((k) => before[k] !== after[k])
    .sort()
}

export { raw, p2tr, mine }
export type { Contract }
