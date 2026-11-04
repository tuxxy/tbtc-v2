/* eslint-disable no-await-in-loop, no-restricted-syntax */
// K-09 legacy obligations across the upgrade, the cutover and containment.
//
// Issues: tuxxy/tbtc-v2#16 (K09-5: obligation-class inventory, each class
// carried across the upgrade and the cutover and discharged, with a full
// state-frame check), tuxxy/keep-core#25 (K09-4: "legacy pending work
// survives cutoff and containment").
//
// World: `k09-legacy-ledger` (real 40a11d1d Bridge upgraded in place, real
// ECDSA WalletRegistry; ADAPTER relay and beacon; FIXTURE FROST registry).
// Every case starts from the composed snapshot: FrostOnly, a FROST wallet
// created after the cutover, exposure contained. Each case discharges one
// route of one class and asserts that exactly the expected frame entries
// changed (invariant: a legacy discharge touches only its own obligation, and
// never FROST creation mode, cutover manifest or exposure state).
import { ethers } from "hardhat"
import { expect } from "chai"
import {
  ledgerWorld,
  ledgerFrame,
  changedKeys,
  LedgerWorld,
  utxoHash,
  redemptionKey,
  challengeKey,
  SWEEP_FEE,
  RED_AMOUNT,
} from "../helpers/k09-legacy-ledger"
import {
  transaction,
  inclusion,
  p2wpkh,
  p2tr,
  outpoint,
} from "../helpers/frost-movement-world"
import {
  LegacyState,
  Mode,
  NO_MAIN,
  increaseTime,
  now,
} from "../helpers/k09-registry-world"
import {
  CLASSES,
  DEFERRED_ROUTES,
  NOT_OBLIGATIONS,
  baselineEntrypoints,
  baselineMappings,
  baselineWalletStates,
} from "./obligation-ledger"

const MOVING_FUNDS_TIMEOUT = 7 * 86400
const REDEMPTION_TIMEOUT = 5 * 86400
const SWEEP_TIMEOUT = 10 * 86400
const FRAUD_TIMEOUT = 7 * 86400
const CLOSING_PERIOD = 7 * 86400
const RESET_DELAY = 3600

/// Routes witnessed by a passing case in this run.
const witnessed = new Set<string>()

describe("K-09 legacy obligations across upgrade, cutover and containment (tbtc-v2#16, keep-core#25)", function () {
  this.timeout(180_000)
  let l: LedgerWorld
  let start: Record<string, string>

  // The world is built once (suite setup); each case reverts to it.
  before(async () => {
    await ledgerWorld()
  })
  beforeEach(async () => {
    l = await ledgerWorld()
    // The composed state every case starts from.
    expect(await l.frost.frostCreationMode()).to.equal(Mode.FrostOnly)
    expect(await l.exposure.contained()).to.equal(true)
    start = await ledgerFrame(l)
  })

  /// Runs a witness of `route` and records it only if every assertion held.
  const witness = (route: string, title: string, body: () => Promise<void>) =>
    it(`[${route}] ${title}`, async () => {
      await body()
      witnessed.add(route)
    })
  const expectChanged = async (keys: string[]) =>
    expect(
      changedKeys(start, await ledgerFrame(l)),
      "changed frame"
    ).to.deep.equal([...keys].sort())
  const wallet = (name: keyof LedgerWorld["wallets"]) =>
    l.bridge.wallets(l.wallets[name].pkh)
  /// The discharge call itself, as a named assertion: a refusal fails here.
  const discharges = (route: string, call: Promise<unknown>) =>
    expect(call, `${route} discharges`).to.not.be.reverted

  it("builds the obligations on the pinned 40a11d1d Bridge and keeps them across the upgrade", async () => {
    // Every class was created before the upgrade, on the baseline code.
    expect(l.preUpgrade.bridge.length).to.be.greaterThan(0)
    for (const name of ["R", "T", "L", "D", "B", "F", "H"] as const)
      expect((await wallet(name)).state, name).to.equal(LegacyState.Live)
    for (const name of ["U", "M", "Y", "A"] as const)
      expect((await wallet(name)).state, name).to.equal(LegacyState.MovingFunds)
    expect((await wallet("A3")).state).to.equal(LegacyState.Closing)
    expect(
      (await wallet("A")).movingFundsTargetWalletsCommitmentHash
    ).to.not.equal(ethers.constants.HashZero)
    expect((await wallet("B")).pendingMovedFundsSweepRequestsCount).to.equal(1)
    expect(
      (
        await l.bridge.timedOutRedemptions(
          redemptionKey(l.wallets.U.pkh, l.scripts.U)
        )
      ).requestedAt
    ).to.be.greaterThan(0)
    for (const k of ["R", "T", "V"] as const) {
      const { pkh } = l.wallets[k === "V" ? "R" : k]
      expect(
        (await l.bridge.pendingRedemptions(redemptionKey(pkh, l.scripts[k])))
          .requestedAt,
        k
      ).to.be.greaterThan(0)
    }
    for (const c of Object.values(l.challenges))
      expect(
        (await l.bridge.fraudChallenges(challengeKey(l.wallets.F, c.sighash)))
          .reportedAt
      ).to.be.greaterThan(0)
    for (const d of Object.values(l.deposits)) {
      const deposit = await l.bridge.deposits(outpoint(d.hash, 0))
      expect(deposit.revealedAt).to.be.greaterThan(0)
      expect(deposit.sweptAt).to.equal(0)
    }
    // The proxy now runs this checkout's Bridge.
    expect(await l.admin.getProxyImplementation(l.proxy.address)).to.equal(
      l.implementation.address
    )
    expect(await l.frost.frostCutoverManifest()).to.equal(l.manifest)
  })

  witness(
    "deposit-sweep",
    "sweeps both revealed deposits after the cutover and containment",
    async () => {
      const { d1, d2 } = l.deposits
      const sweep = transaction(
        [
          [d1.hash, 0],
          [d2.hash, 0],
        ],
        [{ value: 50000 + 60000 - SWEEP_FEE, script: p2wpkh(l.wallets.D.pkh) }]
      )
      const alias = await l.bank.balanceOf(l.alias.address)
      const treasury = await l.bank.balanceOf(l.treasury.address)
      await discharges(
        "deposit-sweep",
        l.bridge
          .connect(l.maintainer)
          .submitDepositSweepProof(
            sweep.tx,
            inclusion(sweep.hash),
            NO_MAIN,
            ethers.constants.AddressZero
          )
      )
      expect(
        (await l.bridge.deposits(outpoint(d1.hash, 0))).sweptAt
      ).to.be.greaterThan(0)
      expect(
        (await l.bridge.deposits(outpoint(d2.hash, 0))).sweptAt
      ).to.be.greaterThan(0)
      expect((await wallet("D")).mainUtxoHash).to.equal(
        utxoHash({
          txHash: sweep.hash,
          txOutputIndex: 0,
          txOutputValue: 109000,
        })
      )
      // 50000 - 500 fee - 500 tx fee share, 60000 - 600 - 500.
      expect((await l.bank.balanceOf(l.alias.address)).sub(alias)).to.equal(
        49000 + 58900
      )
      expect(
        (await l.bank.balanceOf(l.treasury.address)).sub(treasury)
      ).to.equal(1100)
      await expectChanged([
        "deposit:d1",
        "deposit:d2",
        "wallet:D",
        "bank:alias",
        "bank:treasury",
      ])
    }
  )

  /// The redemption transaction paying `script` from `name`'s main.
  const redemptionTx = (name: "R" | "U", script: string) => {
    const main = l.mains[name]
    const paid = RED_AMOUNT - RED_AMOUNT / 100 - 1000
    return {
      main,
      tx: transaction(
        [[main.txHash, 0]],
        [
          { value: paid, script: Buffer.from(script.slice(2), "hex") },
          {
            value: main.txOutputValue - paid - 1000,
            script: p2wpkh(l.wallets[name].pkh),
          },
        ]
      ),
    }
  }

  witness(
    "redemption-proof",
    "pays a pending redemption after the cutover and containment",
    async () => {
      const { main, tx } = redemptionTx("R", l.scripts.R)
      const treasury = await l.bank.balanceOf(l.treasury.address)
      const escrow = await l.bank.balanceOf(l.bridge.address)
      await discharges(
        "redemption-proof",
        l.bridge
          .connect(l.maintainer)
          .submitRedemptionProof(
            tx.tx,
            inclusion(tx.hash),
            main,
            l.wallets.R.pkh
          )
      )
      expect(
        (
          await l.bridge.pendingRedemptions(
            redemptionKey(l.wallets.R.pkh, l.scripts.R)
          )
        ).requestedAt
      ).to.equal(0)
      const r = await wallet("R")
      // The vetoable second request is still pending.
      expect(r.pendingRedemptionsValue).to.equal(RED_AMOUNT - RED_AMOUNT / 100)
      expect(r.mainUtxoHash).to.equal(
        utxoHash({
          txHash: tx.hash,
          txOutputIndex: 1,
          txOutputValue: 99000 - 38600 - 1000,
        })
      )
      expect(escrow.sub(await l.bank.balanceOf(l.bridge.address))).to.equal(
        RED_AMOUNT
      )
      expect(
        (await l.bank.balanceOf(l.treasury.address)).sub(treasury)
      ).to.equal(400)
      await expectChanged([
        "pending:R",
        "wallet:R",
        "bank:bridge",
        "bank:treasury",
      ])
    }
  )

  witness(
    "redemption-timeout",
    "times out a pending redemption after the cutover and containment",
    async () => {
      await increaseTime(REDEMPTION_TIMEOUT + 1)
      const alias = await l.bank.balanceOf(l.alias.address)
      await discharges(
        "redemption-timeout",
        l.bridge
          .connect(l.alias)
          .notifyRedemptionTimeout(
            l.wallets.T.pkh,
            l.wallets.T.members,
            l.scripts.T
          )
      )
      const key = redemptionKey(l.wallets.T.pkh, l.scripts.T)
      expect((await l.bridge.pendingRedemptions(key)).requestedAt).to.equal(0)
      expect(
        (await l.bridge.timedOutRedemptions(key)).requestedAt
      ).to.be.greaterThan(0)
      expect((await wallet("T")).state).to.equal(LegacyState.MovingFunds)
      expect((await l.bank.balanceOf(l.alias.address)).sub(alias)).to.equal(
        RED_AMOUNT
      )
      await expectChanged([
        "pending:T",
        "timedOut:T",
        "wallet:T",
        "bank:alias",
        "bank:bridge",
      ])
    }
  )

  witness(
    "redemption-veto",
    "vetoes a pending redemption through the watchtower after the cutover and containment",
    async () => {
      const tower = await l.bank.balanceOf(l.tower.address)
      const [g1, g2, g3] = l.guardians
      await l.tower.connect(g1).raiseObjection(l.wallets.R.pkh, l.scripts.V)
      await l.tower.connect(g2).raiseObjection(l.wallets.R.pkh, l.scripts.V)
      // The third objection finalizes the veto and calls the Bridge.
      await discharges(
        "redemption-veto",
        l.tower.connect(g3).raiseObjection(l.wallets.R.pkh, l.scripts.V)
      )
      const key = redemptionKey(l.wallets.R.pkh, l.scripts.V)
      expect((await l.bridge.pendingRedemptions(key)).requestedAt).to.equal(0)
      expect((await l.tower.vetoProposals(key)).objectionsCount).to.equal(3)
      expect((await wallet("R")).pendingRedemptionsValue).to.equal(
        RED_AMOUNT - RED_AMOUNT / 100
      )
      // The Bridge detains the whole requested amount in the watchtower, which
      // burns its penalty and keeps the redeemer's withdrawable rest.
      const veto = await l.tower.vetoProposals(key)
      expect(veto.finalizedAt).to.be.greaterThan(0)
      expect((await l.bank.balanceOf(l.tower.address)).sub(tower)).to.equal(
        veto.withdrawableAmount
      )
      await expectChanged([
        "pending:V",
        "veto:V",
        "wallet:R",
        "bank:bridge",
        ...(veto.withdrawableAmount.gt(0) ? ["bank:tower"] : []),
      ])
    }
  )

  witness(
    "timed-out-redemption-proof",
    "pays a request that timed out before the upgrade",
    async () => {
      const { main, tx } = redemptionTx("U", l.scripts.U)
      await discharges(
        "timed-out-redemption-proof",
        l.bridge
          .connect(l.maintainer)
          .submitRedemptionProof(
            tx.tx,
            inclusion(tx.hash),
            main,
            l.wallets.U.pkh
          )
      )
      expect(
        (
          await l.bridge.timedOutRedemptions(
            redemptionKey(l.wallets.U.pkh, l.scripts.U)
          )
        ).requestedAt
      ).to.equal(0)
      const u = await wallet("U")
      expect(u.state).to.equal(LegacyState.MovingFunds)
      expect(u.mainUtxoHash).to.equal(
        utxoHash({
          txHash: tx.hash,
          txOutputIndex: 1,
          txOutputValue: 99000 - 38600 - 1000,
        })
      )
      await expectChanged(["timedOut:U", "wallet:U"])
    }
  )

  witness(
    "moving-funds-timeout",
    "terminates a MovingFunds wallet with no commitment at its timeout",
    async () => {
      await increaseTime(MOVING_FUNDS_TIMEOUT + 1)
      await discharges(
        "moving-funds-timeout",
        l.bridge
          .connect(l.alias)
          .notifyMovingFundsTimeout(l.wallets.M.pkh, l.wallets.M.members)
      )
      expect((await wallet("M")).state).to.equal(LegacyState.Terminated)
      // Termination also closes the wallet in the real registry.
      expect(
        await l.registry.isWalletRegistered(l.wallets.M.walletID)
      ).to.equal(false)
      await expectChanged(["wallet:M", "registry:M"])
    }
  )

  witness(
    "moving-funds-reset",
    "resets the timeout of a MovingFunds wallet with no route under containment",
    async () => {
      await increaseTime(RESET_DELAY + 1)
      await discharges(
        "moving-funds-reset",
        l.bridge.connect(l.alias).resetMovingFundsTimeout(l.wallets.M.pkh)
      )
      expect((await wallet("M")).movingFundsRequestedAt).to.equal(await now())
      await expectChanged(["wallet:M"])
    }
  )

  witness(
    "drain-commitment",
    "drains a MovingFunds wallet into the post-cutover FROST wallet once containment lifts",
    async () => {
      const m = l.wallets.M
      const commit = () =>
        l.bridge
          .connect(m.signers[0])
          .submitMovingFundsCommitment(m.pkh, l.mains.M, m.members, 1, [
            l.frostWallet.label,
          ])
      // Containment refuses the new exposure, with the frame unchanged.
      await expect(
        commit(),
        "containment refuses the drain"
      ).to.be.revertedWith("FROST exposure contained")
      await expectChanged([])
      // A legacy target is refused after the cutover.
      await expect(
        l.bridge
          .connect(m.signers[0])
          .submitMovingFundsCommitment(m.pkh, l.mains.M, m.members, 1, [
            l.wallets.L.pkh,
          ]),
        "the legacy-target fence refuses a legacy target"
      ).to.be.revertedWith("Legacy targets after cutover")
      await expectChanged([])
      await l.exposure.lift(ethers.utils.id("K09 lift"))
      await discharges("drain-commitment", commit())
      const movement = transaction(
        [[l.mains.M.txHash, 0]],
        [
          {
            value: l.mains.M.txOutputValue - SWEEP_FEE,
            script: p2tr(l.frostWallet.q),
          },
        ]
      )
      await l.bridge
        .connect(l.maintainer)
        .submitMovingFundsProof(
          movement.tx,
          inclusion(movement.hash),
          l.mains.M,
          m.pkh
        )
      expect((await wallet("M")).state).to.equal(LegacyState.Closing)
      // The drain is FROST exposure: reserved and completed in the controller,
      // and an incoming obligation of the FROST target. The commitment's gas is
      // refunded from the reimbursement pool, as in base.
      const counters = await l.frost.frostMovementCounters(l.frostWallet.id)
      expect(counters.pendingIncoming).to.equal(1)
      expect(await l.exposure.custodyAdmitted()).to.equal(
        l.mains.M.txOutputValue - SWEEP_FEE
      )
      await expectChanged([
        "wallet:M",
        "exposure",
        "exposure:contained",
        "frost:counters",
        "frost:obligations",
        "eth:pool",
      ])
    }
  )

  witness(
    "moving-funds-below-dust",
    "closes a below-dust MovingFunds wallet after the cutover and containment",
    async () => {
      await discharges(
        "moving-funds-below-dust",
        l.bridge
          .connect(l.alias)
          .notifyMovingFundsBelowDust(l.wallets.Y.pkh, l.mains.Y)
      )
      expect((await wallet("Y")).state).to.equal(LegacyState.Closing)
      await expectChanged(["wallet:Y"])
    }
  )

  witness(
    "moving-funds-proof",
    "proves a movement committed to a legacy target before the cutover",
    async () => {
      const tx = l.movementTx("A", "B")
      await discharges(
        "moving-funds-proof",
        l.bridge
          .connect(l.maintainer)
          .submitMovingFundsProof(
            tx.tx,
            inclusion(tx.hash),
            l.mains.A,
            l.wallets.A.pkh
          )
      )
      expect((await wallet("A")).state).to.equal(LegacyState.Closing)
      expect((await wallet("B")).pendingMovedFundsSweepRequestsCount).to.equal(
        2
      )
      expect(
        (await l.bridge.movedFundsSweepRequests(outpoint(tx.hash, 0))).state
      ).to.equal(1)
      await expectChanged(["wallet:A", "wallet:B"])
    }
  )

  witness(
    "committed-moving-funds-timeout",
    "terminates a wallet whose legacy commitment was never proven",
    async () => {
      await increaseTime(MOVING_FUNDS_TIMEOUT + 1)
      await discharges(
        "committed-moving-funds-timeout",
        l.bridge
          .connect(l.alias)
          .notifyMovingFundsTimeout(l.wallets.A.pkh, l.wallets.A.members)
      )
      expect((await wallet("A")).state).to.equal(LegacyState.Terminated)
      expect(
        await l.registry.isWalletRegistered(l.wallets.A.walletID)
      ).to.equal(false)
      await expectChanged(["wallet:A", "registry:A"])
    }
  )

  witness(
    "moved-funds-sweep-proof",
    "sweeps funds moved in before the upgrade",
    async () => {
      const value = 99000 - SWEEP_FEE
      const sweep = transaction(
        [[l.a3Movement.hash, 0]],
        [{ value: value - SWEEP_FEE, script: p2wpkh(l.wallets.B.pkh) }]
      )
      await discharges(
        "moved-funds-sweep-proof",
        l.bridge
          .connect(l.maintainer)
          .submitMovedFundsSweepProof(sweep.tx, inclusion(sweep.hash), NO_MAIN)
      )
      expect(
        (await l.bridge.movedFundsSweepRequests(outpoint(l.a3Movement.hash, 0)))
          .state
      ).to.equal(2)
      const b = await wallet("B")
      expect(b.pendingMovedFundsSweepRequestsCount).to.equal(0)
      expect(b.mainUtxoHash).to.equal(
        utxoHash({
          txHash: sweep.hash,
          txOutputIndex: 0,
          txOutputValue: value - SWEEP_FEE,
        })
      )
      await expectChanged(["sweepRequest:A3", "wallet:B"])
    }
  )

  witness(
    "moved-funds-sweep-timeout",
    "times out a moved-funds sweep request after the cutover and containment",
    async () => {
      await increaseTime(SWEEP_TIMEOUT + 1)
      await discharges(
        "moved-funds-sweep-timeout",
        l.bridge
          .connect(l.alias)
          .notifyMovedFundsSweepTimeout(
            l.a3Movement.hash,
            0,
            l.wallets.B.members
          )
      )
      expect(
        (await l.bridge.movedFundsSweepRequests(outpoint(l.a3Movement.hash, 0)))
          .state
      ).to.equal(3)
      // B is Live with no main, so the timeout terminates it.
      expect((await wallet("B")).state).to.equal(LegacyState.Terminated)
      await expectChanged(["sweepRequest:A3", "wallet:B", "registry:B"])
    }
  )

  witness(
    "closing-elapsed",
    "closes a wallet that was Closing at the upgrade",
    async () => {
      await increaseTime(CLOSING_PERIOD + 1)
      await discharges(
        "closing-elapsed",
        l.bridge
          .connect(l.alias)
          .notifyWalletClosingPeriodElapsed(l.wallets.A3.pkh)
      )
      expect((await wallet("A3")).state).to.equal(LegacyState.Closed)
      expect(
        await l.registry.isWalletRegistered(l.wallets.A3.walletID)
      ).to.equal(false)
      await expectChanged(["wallet:A3", "registry:A3"])
    }
  )

  witness(
    "fraud-defeat",
    "defeats a challenge with the preimage of a correctly spent deposit",
    async () => {
      const c = l.challenges.preimage
      await discharges(
        "fraud-defeat",
        l.bridge
          .connect(l.alias)
          .defeatFraudChallenge(l.wallets.F.groupPubKey, c.message, true)
      )
      expect(
        (await l.bridge.fraudChallenges(challengeKey(l.wallets.F, c.sighash)))
          .resolved
      ).to.equal(true)
      expect((await wallet("F")).state).to.equal(LegacyState.Live)
      await expectChanged(["challenge:preimage", "eth:bridge"])
    }
  )

  witness(
    "fraud-defeat-heartbeat",
    "defeats a challenge with a heartbeat message",
    async () => {
      const c = l.challenges.heartbeat
      await discharges(
        "fraud-defeat-heartbeat",
        l.bridge
          .connect(l.alias)
          .defeatFraudChallengeWithHeartbeat(l.wallets.F.groupPubKey, c.message)
      )
      expect(
        (await l.bridge.fraudChallenges(challengeKey(l.wallets.F, c.sighash)))
          .resolved
      ).to.equal(true)
      await expectChanged(["challenge:heartbeat", "eth:bridge"])
    }
  )

  witness(
    "fraud-timeout",
    "terminates a wallet whose challenge was not defeated in time",
    async () => {
      const c = l.challenges.arbitrary
      await increaseTime(FRAUD_TIMEOUT + 1)
      await discharges(
        "fraud-timeout",
        l.bridge
          .connect(l.alias)
          .notifyFraudChallengeDefeatTimeout(
            l.wallets.F.groupPubKey,
            l.wallets.F.members,
            c.preimageSha256
          )
      )
      expect(
        (await l.bridge.fraudChallenges(challengeKey(l.wallets.F, c.sighash)))
          .resolved
      ).to.equal(true)
      expect((await wallet("F")).state).to.equal(LegacyState.Terminated)
      await expectChanged([
        "challenge:arbitrary",
        "wallet:F",
        "registry:F",
        "eth:bridge",
      ])
    }
  )

  witness(
    "closeable",
    "moves an old Live wallet's funds after the cutover and containment",
    async () => {
      await discharges(
        "closeable",
        l.bridge
          .connect(l.alias)
          .notifyWalletCloseable(l.wallets.L.pkh, l.mains.L)
      )
      expect((await wallet("L")).state).to.equal(LegacyState.MovingFunds)
      await expectChanged(["wallet:L"])
    }
  )

  witness(
    "heartbeat-failed",
    "moves a Live wallet's funds on a real registry heartbeat-failure claim",
    async () => {
      const h = l.wallets.H
      const nonce = await l.registry.inactivityClaimNonce(h.walletID)
      const inactive = [100]
      const message = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ["uint256", "uint256", "bytes", "uint8[]", "bool"],
          [31337, nonce, h.groupPubKey, inactive, true]
        )
      )
      const signing = h.signers.slice(0, 51)
      const signatures = await Promise.all(
        signing.map((s) => s.signMessage(ethers.utils.arrayify(message)))
      )
      await discharges(
        "heartbeat-failed",
        l.registry.connect(signing[0]).notifyOperatorInactivity(
          {
            walletID: h.walletID,
            inactiveMembersIndices: inactive,
            heartbeatFailed: true,
            signatures: ethers.utils.hexConcat(signatures),
            signingMembersIndices: signing.map((_, i) => i + 1),
          },
          nonce,
          h.members
        )
      )
      expect((await wallet("H")).state).to.equal(LegacyState.MovingFunds)
      await expectChanged(["wallet:H", "eth:pool"])
    }
  )

  witness(
    "in-flight-registration",
    "registers only the ECDSA wallet whose DKG was in flight when the drain began",
    async () => {
      // Z's DKG was requested on 40a11d1d, crossed the upgrade, and its real
      // approval registered it while LegacyDraining, before the cutover.
      expect(l.z.registeredIn).to.equal(Mode.LegacyDraining)
      expect((await l.bridge.wallets(l.z.key.pkh)).state).to.equal(
        LegacyState.Live
      )
      expect(await l.registry.isWalletRegistered(l.z.key.walletID)).to.equal(
        true
      )
      // No further ECDSA wallet can be requested after the cutover.
      await expect(
        l.bridge.requestNewWallet(NO_MAIN),
        "no ECDSA request after the cutover"
      ).to.be.revertedWith("Legacy wallet creation closed")
      expect(await l.registry.getWalletCreationState()).to.equal(0)
      await expectChanged([])
    }
  )

  it("interleaves discharges across wallets in an adversarial order, with aliased actors, and never touches FROST or exposure state", async () => {
    // One account (`alias`) is depositor, redeemer, challenger and notifier.
    const frostKeys = Object.keys(start).filter(
      (k) => k.startsWith("frost:") || k.startsWith("exposure")
    )
    await increaseTime(MOVING_FUNDS_TIMEOUT + 1)
    // Fraud: the timeout first, then a defeat of F's other challenge.
    await discharges(
      "fraud-timeout",
      l.bridge
        .connect(l.alias)
        .notifyFraudChallengeDefeatTimeout(
          l.wallets.F.groupPubKey,
          l.wallets.F.members,
          l.challenges.arbitrary.preimageSha256
        )
    )
    await discharges(
      "fraud-defeat-heartbeat",
      l.bridge
        .connect(l.alias)
        .defeatFraudChallengeWithHeartbeat(
          l.wallets.F.groupPubKey,
          l.challenges.heartbeat.message
        )
    )
    // A's movement proof lands after its timeout elapsed but before anyone
    // notified it; the late notification then fails on state.
    const movement = l.movementTx("A", "B")
    await discharges(
      "moving-funds-proof",
      l.bridge
        .connect(l.maintainer)
        .submitMovingFundsProof(
          movement.tx,
          inclusion(movement.hash),
          l.mains.A,
          l.wallets.A.pkh
        )
    )
    await expect(
      l.bridge
        .connect(l.alias)
        .notifyMovingFundsTimeout(l.wallets.A.pkh, l.wallets.A.members),
      "late moving-funds timeout"
    ).to.be.revertedWith("Wallet must be in MovingFunds state")
    // B sweeps one of its two incoming movements; the redemption on T times
    // out; D's deposits are swept; A3 closes.
    const sweep = transaction(
      [[l.a3Movement.hash, 0]],
      [{ value: 99000 - 2 * SWEEP_FEE, script: p2wpkh(l.wallets.B.pkh) }]
    )
    await discharges(
      "moved-funds-sweep-proof",
      l.bridge
        .connect(l.maintainer)
        .submitMovedFundsSweepProof(sweep.tx, inclusion(sweep.hash), NO_MAIN)
    )
    await discharges(
      "redemption-timeout",
      l.bridge
        .connect(l.alias)
        .notifyRedemptionTimeout(
          l.wallets.T.pkh,
          l.wallets.T.members,
          l.scripts.T
        )
    )
    const deposits = transaction(
      [
        [l.deposits.d1.hash, 0],
        [l.deposits.d2.hash, 0],
      ],
      [{ value: 110000 - SWEEP_FEE, script: p2wpkh(l.wallets.D.pkh) }]
    )
    await discharges(
      "deposit-sweep",
      l.bridge
        .connect(l.maintainer)
        .submitDepositSweepProof(
          deposits.tx,
          inclusion(deposits.hash),
          NO_MAIN,
          ethers.constants.AddressZero
        )
    )
    await discharges(
      "closing-elapsed",
      l.bridge
        .connect(l.alias)
        .notifyWalletClosingPeriodElapsed(l.wallets.A3.pkh)
    )
    expect((await wallet("F")).state).to.equal(LegacyState.Terminated)
    expect((await wallet("A")).state).to.equal(LegacyState.Closing)
    expect((await wallet("B")).pendingMovedFundsSweepRequestsCount).to.equal(1)
    expect((await wallet("T")).state).to.equal(LegacyState.MovingFunds)
    expect((await wallet("A3")).state).to.equal(LegacyState.Closed)
    const end = await ledgerFrame(l)
    for (const k of frostKeys)
      expect(end[k], `FROST state untouched: ${k}`).to.equal(start[k])
  })

  it("ledger: every 40a11d1d obligation class has a witness or a recorded deferral", () => {
    const mapped = new Set<string>(Object.keys(NOT_OBLIGATIONS))
    for (const c of CLASSES) {
      c.creators.forEach((e) => mapped.add(e))
      c.routes.forEach((r) => mapped.add(r.entrypoint))
      c.storage.forEach((s) => mapped.add(s))
      c.states.forEach((s) => mapped.add(s))
    }
    for (const e of baselineEntrypoints())
      expect(mapped.has(e), `unmapped baseline entrypoint: ${e}`).to.equal(true)
    for (const m of baselineMappings())
      expect(mapped.has(m), `unmapped baseline storage: ${m}`).to.equal(true)
    for (const s of baselineWalletStates())
      expect(mapped.has(s), `unmapped baseline wallet state: ${s}`).to.equal(
        true
      )
    for (const c of CLASSES)
      for (const r of c.routes)
        expect(
          witnessed.has(r.id) || DEFERRED_ROUTES[r.id] !== undefined,
          `uncovered obligation class: ${c.id} (route ${r.id})`
        ).to.equal(true)
  })
})
