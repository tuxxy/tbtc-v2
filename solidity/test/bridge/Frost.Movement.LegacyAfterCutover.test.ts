/* eslint-disable no-await-in-loop */
// Remediation batch 2, contract side of the ECDSA-to-FROST drain
// (tuxxy/keep-core#34). Tests only; written before any fix.
//
// tuxxy/tbtc-v2#18 (K09-16): after FrostOnly the Bridge still accepts new
//   ECDSA-to-ECDSA moving-funds commitments.
// tuxxy/tbtc-v2#20 (K09-28): after FrostOnly, a legacy MovingFunds source with
//   no commitment and no admissible route must keep a legal recovery (the
//   timeout reset) whatever the legacy Live count, so it is not terminated.
//   Before the cutover with zero Live wallets (K09-39, tuxxy/keep-core#54) the
//   same holds, including a partial custody budget.
// tuxxy/tbtc-v2#22 (K09-50) with owner decision D7: the reimbursed path
//   (MaintainerProxy) must service every reset the Bridge offers a legacy
//   source, before and after the cutover.
// D8: below dust, notifyMovingFundsBelowDust stays permissionless.
//
// Not covered (pending): tuxxy/tbtc-v2#21 (K09-36, reset while an admissible
// drain exists): DECISIONS.md D6 leaves the K09-36 approval unanswered.
//
// Every legacy wallet is reached through public calls only: the real registry
// callback (FrostDrainRegistryFixture, a labelled fixture: no DKG), a real
// legacy deposit reveal and its sweep proof, notifyWalletCloseable after the
// wallet's maximum age, and a fraud challenge left undefended for the
// zero-Live variants. FROST wallets come from movementWorld (registry FIXTURE
// callbacks). Inclusion proofs are movementWorld's synthetic regtest proofs:
// these tests check contract accounting and lifecycle, not Bitcoin script
// validity. D-10 budget values are test values (OPEN).
import { ethers, network, artifacts } from "hardhat"
import { expect } from "chai"
import {
  MAX_UINT64,
  movementWorld,
  transaction,
  inclusion,
  p2tr,
  p2wpkh,
  deploy,
  ascending,
  split,
  TYPE,
  World,
  Wallet,
} from "../helpers/frost-movement-world"

const Mode = { LegacyOpen: 0, LegacyDraining: 1, FrostOnly: 2 }
const ModeName = ["LegacyOpen", "LegacyDraining", "FrostOnly"]
const LegacyState = { Live: 1, MovingFunds: 2, Closing: 3, Terminated: 5 }
const MANIFEST = ethers.utils.id("batch-2 test cutover manifest")
const RECORD = ethers.utils.id("batch-2 test record")
const MOVE_FEE = 3000
const TIMED_OUT = "Moving funds has not timed out yet"

type Blocker =
  | "contained"
  | "drain-off"
  | "zero-eligible"
  | "budget-exhausted"
  | "budget-partial"
  | "below-dust"

type Legacy = { pkh: string; key: string; publicKey: string }

/// The legacy side of one world, through public calls only.
function legacyHelpers(get: () => World) {
  let created = 0
  /// A legacy wallet registered through the registry callback.
  const legacyWallet = async (): Promise<Legacy> => {
    created += 1
    const key = ethers.utils.hexZeroPad(ethers.utils.hexlify(9000 + created), 32)
    const pub = ethers.utils.computePublicKey(key)
    await get().legacyRegistry.publish(
      ethers.utils.id(`batch-2 legacy wallet ${created}`),
      `0x${pub.slice(4, 68)}`,
      `0x${pub.slice(68)}`
    )
    const compressed = ethers.utils.computePublicKey(pub, true)
    return {
      pkh: ethers.utils.ripemd160(ethers.utils.sha256(compressed)),
      key,
      publicKey: `0x${pub.slice(4)}`,
    }
  }
  /// A real legacy deposit to a Live wallet and its sweep proof: the wallet's
  /// main UTXO.
  const fundLegacy = async (pkh: string, amount: number) => {
    const w = get()
    created += 1
    const locktime = Buffer.alloc(4)
    locktime.writeUInt32LE((await w.now()) + 30 * 86400)
    const blinding = ethers.utils.hexZeroPad(ethers.utils.hexlify(created), 8)
    const script = `0x14${w.depositor.address.slice(2)}7508${blinding.slice(
      2
    )}7576a914${pkh.slice(2)}8763ac6776a914${pkh.slice(
      2
    )}8804${locktime.toString("hex")}b175ac68`
    const funding = transaction(
      [[ethers.utils.id(`batch-2 legacy funding ${created}`), 0]],
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
    await w.bridge.connect(w.depositor).revealDeposit(funding.tx, {
      fundingOutputIndex: 0,
      blindingFactor: blinding,
      walletPubKeyHash: pkh,
      refundPubKeyHash: pkh,
      refundLocktime: `0x${locktime.toString("hex")}`,
      vault: ethers.constants.AddressZero,
    })
    const value = amount - 1500
    const sweep = transaction(
      [[funding.hash, 0]],
      [{ value, script: p2wpkh(pkh) }]
    )
    await w.bridge.submitDepositSweepProof(
      sweep.tx,
      inclusion(sweep.hash),
      { txHash: ethers.constants.HashZero, txOutputIndex: 0, txOutputValue: 0 },
      ethers.constants.AddressZero
    )
    return { txHash: sweep.hash, txOutputIndex: 0, txOutputValue: value }
  }
  /// The wallet is older than walletMaxAge: anyone may move it to
  /// MovingFunds (notifyWalletCloseable).
  const ageOut = async () => {
    const { walletMaxAge } = await get().bridge.walletParameters()
    await network.provider.send("evm_increaseTime", [walletMaxAge + 1])
    await network.provider.send("evm_mine")
  }
  /// A fraud challenge the wallet does not defeat: the wallet is Terminated
  /// (and no longer Live).
  const terminate = async (wallet: Legacy) => {
    const w = get()
    const p = await w.bridge.fraudParameters()
    await w.bridge.updateFraudParameters(
      p.fraudChallengeDepositAmount,
      1,
      p.fraudSlashingAmount,
      p.fraudNotifierRewardMultiplier
    )
    const preimage = ethers.utils.sha256(
      ethers.utils.toUtf8Bytes(`batch-2 undefended digest ${wallet.pkh}`)
    )
    const sighash = ethers.utils.sha256(preimage)
    const signature = new ethers.utils.SigningKey(wallet.key).signDigest(
      sighash
    )
    await w.bridge.submitFraudChallenge(
      wallet.publicKey,
      preimage,
      { r: signature.r, s: signature.s, v: signature.v },
      { value: p.fraudChallengeDepositAmount }
    )
    await network.provider.send("evm_increaseTime", [2])
    await network.provider.send("evm_mine")
    await w.bridge.notifyFraudChallengeDefeatTimeout(
      wallet.publicKey,
      [1],
      preimage
    )
  }
  const legacyState = async (pkh: string) =>
    (await get().bridge.wallets(pkh)).state
  return { legacyWallet, fundLegacy, ageOut, terminate, legacyState }
}

/// One more Live FROST wallet, created through the registry FIXTURE exactly
/// as movementWorld creates its wallets.
async function addFrostWallet(w: World, n: number): Promise<Wallet> {
  const { chainId } = await ethers.provider.getNetwork()
  const pub = ethers.utils.computePublicKey(
    ethers.utils.hexZeroPad(ethers.utils.hexlify(5000 + n), 32),
    true
  )
  const q = `0x${pub.slice(4)}`
  const descriptor = {
    scheme: 2,
    profile: 1,
    chainId,
    registry: w.registry.address,
    epoch: await ethers.provider.getBlockNumber(),
    members: [1, 2, 3],
    operators: [w.operator.address, w.owner.address, w.depositor.address],
    threshold: 2,
    snowfallDescriptor: ethers.utils.id(`batch-2 FROST wallet ${n}`),
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
  await w.registry.created(
    ethers.utils.defaultAbiCoder.encode([TYPE], [descriptor]),
    (await ethers.provider.getBlockNumber()) + 100000
  )
  await w.registry.ready(id, descriptorHash)
  const wallet = {
    q,
    id,
    label: id.slice(0, 42),
    descriptor,
    descriptorHash,
    value: 0,
  }
  w.wallets.push(wallet)
  return wallet
}

/// Every reset entrypoint the upgraded Bridge exposes for a legacy wallet,
/// whatever its name: functions named reset...MovingFundsTimeout on the
/// Bridge or any FROST Bridge interface, taking the wallet's 20-byte key hash
/// and optionally its main UTXO. resetFrostMovingFundsTimeout (FROST wallets)
/// is not one.
async function legacyResetEntrypoints() {
  const names = (await artifacts.getAllFullyQualifiedNames()).filter(
    (n) =>
      n === "contracts/bridge/Bridge.sol:Bridge" ||
      /^contracts\/frost\/IFrost\w*\.sol:IFrost\w*$/.test(n)
  )
  const found = new Map<string, ethers.utils.FunctionFragment>()
  for (const name of names) {
    const iface = new ethers.utils.Interface(
      (await artifacts.readArtifact(name)).abi
    )
    for (const fragment of Object.values(iface.functions)) {
      const legacyInputs =
        fragment.inputs.length >= 1 &&
        fragment.inputs[0].type === "bytes20" &&
        (fragment.inputs.length === 1 ||
          (fragment.inputs.length === 2 &&
            fragment.inputs[1].type === "tuple" &&
            fragment.inputs[1].components.length === 3))
      if (
        /^reset\w*MovingFundsTimeout$/.test(fragment.name) &&
        fragment.name !== "resetFrostMovingFundsTimeout" &&
        legacyInputs
      )
        found.set(fragment.format(), fragment)
    }
  }
  return [...found.values()]
}

/// Advances the chain clock to at least timestamp.
async function advanceTo(timestamp: number) {
  const now = (await ethers.provider.getBlock("latest")).timestamp
  if (timestamp > now) {
    await network.provider.send("evm_setNextBlockTimestamp", [timestamp])
    await network.provider.send("evm_mine")
  }
}

const resetArgs = (
  fragment: ethers.utils.FunctionFragment,
  pkh: string,
  main: any
) => (fragment.inputs.length === 1 ? [pkh] : [pkh, main])

describe("Batch 2: legacy sources after the FROST cutover", () => {
  let base: World
  let w: World
  let snapshot: string
  let stranger: any
  const h = legacyHelpers(() => w)

  before(async () => {
    base = await movementWorld(3)
    w = base
    ;[, , , , , , stranger] = w.signers
    await w.legacyRegistry.setMember(w.operator.address)
    snapshot = await network.provider.send("evm_snapshot")
  })
  beforeEach(async () => {
    // A zero-eligible case builds its own world; the snapshot restores the
    // shared one.
    w = base
    expect(await network.provider.send("evm_revert", [snapshot])).to.equal(true)
    snapshot = await network.provider.send("evm_snapshot")
  })

  /// A legacy source in MovingFunds with its main, through public calls, and
  /// a second legacy wallet, Live unless live is false (then Terminated).
  async function legacySource(amount: number, live: boolean) {
    const source = await h.legacyWallet()
    // The second wallet is the active one, so the source may be closed.
    const other = await h.legacyWallet()
    const main = await h.fundLegacy(source.pkh, amount)
    await h.ageOut()
    await w.bridge.notifyWalletCloseable(source.pkh, main)
    expect(await h.legacyState(source.pkh)).to.equal(LegacyState.MovingFunds)
    if (!live) await h.terminate(other)
    expect(await w.bridge.liveWalletsCount()).to.equal(live ? 1 : 0)
    return { source, other, main }
  }

  async function setMode(mode: number) {
    if (mode >= Mode.LegacyDraining) await w.frost.beginLegacyDkgDrain()
    if (mode === Mode.FrostOnly) await w.frost.completeFrostCutover(MANIFEST)
    expect(await w.frost.frostCreationMode()).to.equal(mode)
  }

  /// Puts the drain route into the blocker's state; returns how to open it.
  async function block(blocker: Blocker, main: any) {
    switch (blocker) {
      case "contained":
        await w.exposure.contain(RECORD)
        return () => w.exposure.lift(RECORD)
      case "drain-off":
        await w.frost.setFrostDrainEnabled(false)
        return () => w.frost.setFrostDrainEnabled(true)
      case "zero-eligible":
        // This world was built without FROST wallets (noRouteWorld); the
        // route opens when one becomes ready.
        return () => addFrostWallet(w, 1)
      case "budget-exhausted":
        await w.exposure.openBudgetPeriod(0, MAX_UINT64, RECORD)
        return () => w.exposure.openBudgetPeriod(MAX_UINT64, MAX_UINT64, RECORD)
      case "budget-partial":
        await w.exposure.openBudgetPeriod(
          Math.floor(main.txOutputValue / 2),
          MAX_UINT64,
          RECORD
        )
        return () => w.exposure.openBudgetPeriod(MAX_UINT64, MAX_UINT64, RECORD)
      default:
        throw Error(`no route to open for ${blocker}`)
    }
  }

  /// The drain commitment into the C-06 number of FROST targets, and its
  /// movement transaction.
  function drainOf(main: any) {
    const eligible = ascending(w.wallets)
    const count = Math.min(
      eligible.length,
      Math.ceil(main.txOutputValue / 250000)
    )
    const targets = eligible.slice(0, count)
    const values = split(main.txOutputValue - MOVE_FEE, count)
    const tx = transaction(
      [[main.txHash, 0]],
      targets.map((t, i) => ({ value: values[i], script: p2tr(t.q) }))
    )
    return { targets, tx }
  }

  const commit = (source: Legacy, main: any, targets: string[]) =>
    w.bridge
      .connect(w.operator)
      .submitMovingFundsCommitment(source.pkh, main, [1, 2, 3], 0, targets)

  /// The revert reason of a call, or "" if it succeeds. Only the reason
  /// string is kept: the full provider message embeds a stack trace whose
  /// source excerpts can contain other reason strings.
  async function revertReason(call: () => Promise<any>) {
    try {
      await (await call())?.wait?.()
    } catch (e: any) {
      const message = String(e.message ?? e)
      const match = message.match(/reverted with reason string '((?:[^'\\]|\\.)*)'/)
      if (match) return match[1]
      return e.reason ? String(e.reason) : message.split("\n")[0]
    }
    return ""
  }

  /// Some legacy reset entrypoint accepts the reset now; returns its name.
  async function resetBy(signer: any, source: Legacy, main: any) {
    const reasons: string[] = []
    for (const fragment of await legacyResetEntrypoints()) {
      const c = new ethers.Contract(w.proxy.address, [fragment], signer)
      const args = resetArgs(fragment, source.pkh, main)
      const reason = await revertReason(() =>
        c.callStatic[fragment.format()](...args)
      )
      if (reason === "") {
        await (await c[fragment.format()](...args)).wait()
        return { name: fragment.format(), reasons }
      }
      reasons.push(`${fragment.format()}: ${reason}`)
    }
    return { name: "", reasons }
  }

  describe("tuxxy/tbtc-v2#18: no new legacy obligation after the cutover", () => {
    // Invariant (KC-SF-V3 line 616, line 729): after the cutover, a new
    // moving-funds commitment names eligible ready FROST wallets only. A
    // legacy-target commitment is refused for its own reason (not "FROST drain
    // disabled"), while the drain is accepted and its proof closes the source.
    it("refuses a new legacy-target commitment after the cutover and accepts the drain", async () => {
      const { source, other, main } = await legacySource(400000, true)
      await w.frost.setFrostDrainEnabled(true)
      await setMode(Mode.FrostOnly)
      const reason = await revertReason(() =>
        commit(source, main, [other.pkh])
      )
      expect(
        reason,
        "after the cutover, a new legacy-target commitment was accepted"
      ).to.not.equal("")
      expect(
        reason,
        "the post-cutover legacy-target refusal reuses the drain-disabled reason"
      ).to.not.contain("FROST drain disabled")
      expect((await w.bridge.wallets(source.pkh)).state).to.equal(
        LegacyState.MovingFunds
      )
      const { targets, tx } = drainOf(main)
      expect(
        await revertReason(() =>
          commit(
            source,
            main,
            targets.map((t) => t.label)
          )
        ),
        "after the cutover, the drain commitment was refused"
      ).to.equal("")
      expect(
        await revertReason(() =>
          w.bridge.submitMovingFundsProof(
            tx.tx,
            inclusion(tx.hash),
            main,
            source.pkh
          )
        ),
        "after the cutover, the drain proof was refused"
      ).to.equal("")
      expect(await h.legacyState(source.pkh)).to.equal(LegacyState.Closing)
    })

    // Guard: before the cutover the legacy route stays legal (spec line 448).
    for (const mode of [Mode.LegacyOpen, Mode.LegacyDraining]) {
      it(`keeps accepting a legacy-target commitment in ${ModeName[mode]}`, async () => {
        const { source, other, main } = await legacySource(400000, true)
        await w.frost.setFrostDrainEnabled(true)
        await setMode(mode)
        expect(
          await revertReason(() => commit(source, main, [other.pkh])),
          `in ${ModeName[mode]}, a legacy-target commitment was refused`
        ).to.equal("")
        const tx = transaction(
          [[main.txHash, 0]],
          [{ value: main.txOutputValue - MOVE_FEE, script: p2wpkh(other.pkh) }]
        )
        expect(
          await revertReason(() =>
            w.bridge.submitMovingFundsProof(
              tx.tx,
              inclusion(tx.hash),
              main,
              source.pkh
            )
          ),
          `in ${ModeName[mode]}, the legacy movement proof was refused`
        ).to.equal("")
        expect(await h.legacyState(source.pkh)).to.equal(LegacyState.Closing)
      })
    }

    // Guard: "except completion of an existing legal commitment" (line 616).
    it("completes a legacy commitment made before the cutover", async () => {
      const { source, other, main } = await legacySource(400000, true)
      await w.frost.setFrostDrainEnabled(true)
      expect(
        await revertReason(() => commit(source, main, [other.pkh])),
        "before the cutover, a legacy-target commitment was refused"
      ).to.equal("")
      await setMode(Mode.FrostOnly)
      const tx = transaction(
        [[main.txHash, 0]],
        [{ value: main.txOutputValue - MOVE_FEE, script: p2wpkh(other.pkh) }]
      )
      expect(
        await revertReason(() =>
          w.bridge.submitMovingFundsProof(
            tx.tx,
            inclusion(tx.hash),
            main,
            source.pkh
          )
        ),
        "after the cutover, the proof of a legacy commitment made before it was refused"
      ).to.equal("")
      expect(
        await h.legacyState(source.pkh),
        "a legacy commitment made before the cutover could not complete after it"
      ).to.equal(LegacyState.Closing)
    })
  })

  // tuxxy/tbtc-v2#20 (FrostOnly) and the contract half of tuxxy/keep-core#54
  // (LegacyOpen/LegacyDraining with zero Live wallets).
  //
  // Invariant (spec line 729, P-K11-CONTAINMENT-KEEPS-EXITS): a legacy
  // MovingFunds source with no commitment and no admissible route keeps a
  // legal reset: some legacy reset entrypoint accepts it once the reset delay
  // has passed, for two consecutive periods, so notifyMovingFundsTimeout is
  // refused for the deadline past each previous one; and once the route opens
  // the drain is accepted. The precondition that the drain really is refused
  // is checked first.
  const recoveryCases: { mode: number; live: boolean; blocker: Blocker }[] =
    []
  for (const blocker of [
    "contained",
    "drain-off",
    "zero-eligible",
    "budget-exhausted",
  ] as Blocker[])
    for (const live of [true, false])
      recoveryCases.push({ mode: Mode.FrostOnly, live, blocker })
  for (const mode of [Mode.LegacyOpen, Mode.LegacyDraining])
    for (const blocker of [
      "budget-partial",
      "budget-exhausted",
      "contained",
      "drain-off",
      "zero-eligible",
    ] as Blocker[])
      recoveryCases.push({ mode, live: false, blocker })

  async function noRouteWorld(c: { mode: number; live: boolean; blocker: Blocker }) {
    if (c.blocker === "zero-eligible") {
      w = await movementWorld(0)
      ;[, , , , , , stranger] = w.signers
      await w.legacyRegistry.setMember(w.operator.address)
    }
    const { source, main } = await legacySource(400000, c.live)
    await w.frost.setFrostDrainEnabled(true)
    await setMode(c.mode)
    const open = await block(c.blocker, main)
    // Precondition: the drain is refused.
    if (w.wallets.length > 0) {
      const { targets } = drainOf(main)
      expect(
        await revertReason(() =>
          w.bridge
            .connect(w.operator)
            .callStatic.submitMovingFundsCommitment(
              source.pkh,
              main,
              [1, 2, 3],
              0,
              targets.map((t) => t.label)
            )
        ),
        "precondition: the drain is admissible"
      ).to.not.equal("")
    }
    return { source, main, open }
  }

  describe("tuxxy/tbtc-v2#20 and tuxxy/keep-core#54: the reset stays reachable with no route", () => {
    for (const c of recoveryCases) {
      it(`${ModeName[c.mode]}, ${c.live ? "a legacy Live wallet" : "zero Live wallets"}, ${c.blocker}`, async () => {
        const { source, main, open } = await noRouteWorld(c)
        const { movingFundsTimeoutResetDelay, movingFundsTimeout } =
          await w.bridge.movingFundsParameters()
        let requestedAt = (await w.bridge.wallets(source.pkh))
          .movingFundsRequestedAt
        for (let period = 1; period <= 2; period += 1) {
          await advanceTo(requestedAt + movingFundsTimeoutResetDelay + 60)
          const { name, reasons } = await resetBy(stranger, source, main)
          expect(
            name,
            `period ${period}: no legacy reset entrypoint accepts the reset of a source with no admissible route (${reasons.join(
              "; "
            )})`
          ).to.not.equal("")
          const next = (await w.bridge.wallets(source.pkh))
            .movingFundsRequestedAt
          expect(next, `period ${period}: the reset did not move the timeout`).to.be.gt(requestedAt)
          await advanceTo(requestedAt + movingFundsTimeout + 60)
          expect(
            await revertReason(() =>
              w.bridge.callStatic.notifyMovingFundsTimeout(source.pkh, [1])
            ),
            `period ${period}: past the previous deadline the source can be terminated`
          ).to.contain(TIMED_OUT)
          requestedAt = next
        }
        // The route opens: the drain is accepted.
        await open()
        const { targets } = drainOf(main)
        expect(
          await revertReason(() =>
            commit(
              source,
              main,
              targets.map((t) => t.label)
            )
          ),
          "after the route opened, the drain commitment was refused"
        ).to.equal("")
        expect(
          (await w.bridge.wallets(source.pkh))
            .movingFundsTargetWalletsCommitmentHash
        ).to.not.equal(ethers.constants.HashZero)
      })
    }
  })

  // tuxxy/tbtc-v2#22 (K09-50) with D7 ("a contract change: add the
  // verified-main selector path"). Invariant: the reimbursed MaintainerProxy
  // path services every legacy reset the Bridge offers, before and after the
  // cutover: each reset entrypoint has a MaintainerProxy function of the same
  // name and inputs, and in each no-route state where the Bridge accepts a
  // reset, calling that wrapper resets the timeout and refunds the caller
  // from the ReimbursementPool.
  describe("tuxxy/tbtc-v2#22 (D7): the reimbursed reset path", () => {
    async function maintainerProxy() {
      const pool = await deploy(
        "@keep-network/random-beacon/contracts/ReimbursementPool.sol:ReimbursementPool",
        [40000, ethers.utils.parseUnits("500", "gwei")]
      )
      const proxy = await deploy("MaintainerProxy", [
        w.proxy.address,
        pool.address,
      ])
      await pool.authorize(proxy.address)
      await w.owner.sendTransaction({
        to: pool.address,
        value: ethers.utils.parseEther("10"),
      })
      return { pool, proxy }
    }

    it("wraps every legacy reset entrypoint of the Bridge", async () => {
      const entrypoints = await legacyResetEntrypoints()
      expect(entrypoints.length, "the Bridge exposes no legacy reset").to.be.gt(0)
      const proxyFunctions = new ethers.utils.Interface(
        (await artifacts.readArtifact("MaintainerProxy")).abi
      ).functions
      for (const fragment of entrypoints)
        expect(
          Object.keys(proxyFunctions),
          `MaintainerProxy has no reimbursed wrapper for ${fragment.format()}`
        ).to.include(fragment.format())
    })

    for (const c of [
      { mode: Mode.FrostOnly, live: true, blocker: "contained" as Blocker },
      { mode: Mode.FrostOnly, live: true, blocker: "budget-exhausted" as Blocker },
      { mode: Mode.FrostOnly, live: false, blocker: "budget-exhausted" as Blocker },
      { mode: Mode.LegacyOpen, live: false, blocker: "budget-partial" as Blocker },
      { mode: Mode.LegacyDraining, live: false, blocker: "budget-partial" as Blocker },
    ]) {
      it(`reimburses the reset: ${ModeName[c.mode]}, ${c.live ? "a legacy Live wallet" : "zero Live wallets"}, ${c.blocker}`, async () => {
        const { source, main } = await noRouteWorld(c)
        const { pool, proxy } = await maintainerProxy()
        const { movingFundsTimeoutResetDelay } =
          await w.bridge.movingFundsParameters()
        const requestedAt = (await w.bridge.wallets(source.pkh))
          .movingFundsRequestedAt
        await advanceTo(requestedAt + movingFundsTimeoutResetDelay + 60)
        const reasons: string[] = []
        let done = ""
        for (const fragment of await legacyResetEntrypoints()) {
          const wrapper = proxy.connect(stranger)
          if (!wrapper.functions[fragment.format()]) continue
          const args = resetArgs(fragment, source.pkh, main)
          const reason = await revertReason(() =>
            wrapper.callStatic[fragment.format()](...args)
          )
          if (reason !== "") {
            reasons.push(`${fragment.format()}: ${reason}`)
            continue
          }
          const before = await ethers.provider.getBalance(pool.address)
          await (await wrapper[fragment.format()](...args)).wait()
          expect(
            await ethers.provider.getBalance(pool.address),
            "the MaintainerProxy reset refunded nothing"
          ).to.be.lt(before)
          done = fragment.format()
          break
        }
        expect(
          done,
          `no reimbursed reset through MaintainerProxy for a source with no admissible route (${reasons.join(
            "; "
          )})`
        ).to.not.equal("")
        expect(
          (await w.bridge.wallets(source.pkh)).movingFundsRequestedAt
        ).to.be.gt(requestedAt)
      })
    }
  })

  // D8: below dust, the recovery is notifyMovingFundsBelowDust, which stays
  // permissionless in every mode, with a legacy Live wallet or none, while the
  // drain is otherwise open. The drain itself is refused below dust.
  describe("D8: below dust", () => {
    for (const mode of [Mode.LegacyOpen, Mode.LegacyDraining, Mode.FrostOnly])
      for (const live of [true, false])
        it(`lets anyone end a below-dust source: ${ModeName[mode]}, ${live ? "a legacy Live wallet" : "zero Live wallets"}`, async () => {
          const { source, main } = await legacySource(15000, live)
          await w.frost.setFrostDrainEnabled(true)
          await setMode(mode)
          const { movingFundsDustThreshold } =
            await w.bridge.movingFundsParameters()
          expect(main.txOutputValue).to.be.lt(movingFundsDustThreshold)
          const { targets } = drainOf(main)
          expect(
            await revertReason(() =>
              commit(
                source,
                main,
                targets.map((t) => t.label)
              )
            ),
            "a below-dust drain was accepted"
          ).to.contain("FROST drain below dust")
          expect(
            await revertReason(() =>
              w.bridge
                .connect(stranger)
                .notifyMovingFundsBelowDust(source.pkh, main)
            ),
            "a third party cannot end a below-dust source"
          ).to.equal("")
          expect(await h.legacyState(source.pkh)).to.equal(LegacyState.Closing)
        })
  })
})
