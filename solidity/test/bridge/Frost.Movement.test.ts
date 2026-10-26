/* eslint-disable no-await-in-loop, no-restricted-syntax */
// C-06 FROST movement and receiving sweeps through the public Bridge.
// Synthetic regtest inclusion proofs test accounting, not Bitcoin spend
// validity; the keep-core K-07 tests mine the same shapes on Bitcoin Core.
import { ethers, network } from "hardhat"
import { expect } from "chai"
import {
  ZERO,
  State,
  Incoming,
  movementWorld,
  transaction,
  inclusion,
  p2tr,
  p2wpkh,
  outpoint,
  deploy,
  ascending,
  split,
  World,
  Wallet,
  Tx,
} from "../helpers/frost-movement-world"

const MOVE_FEE = 3000
const SWEEP_FEE = 500

describe("C-06 FROST movement and receiving sweeps", () => {
  let w: World
  let source: Wallet
  let targets: Wallet[]
  let snapshot: string

  const advance = async (seconds: number) => {
    await network.provider.send("evm_increaseTime", [seconds])
    await network.provider.send("evm_mine")
  }
  const commit = (ts: Wallet[], from = w.operator, seat = 0) =>
    w.frost.connect(from).submitFrostMovingFundsCommitment(
      source.id,
      seat,
      ts.map((t) => t.label)
    )
  const movement = (
    ts: Wallet[],
    values = split(source.value - MOVE_FEE, ts.length),
    inputs: [string, number][] = [[(source.main as Tx).hash, 0]]
  ) =>
    transaction(
      inputs,
      ts.map((t, i) => ({ value: values[i], script: p2tr(t.q) }))
    )
  const prove = (tx: Tx) =>
    w.frost.submitFrostMovingFundsProof(source.id, tx.tx, inclusion(tx.hash))
  const sweepIncoming = (
    target: Wallet,
    inputs: [string, number][],
    value: number
  ) => {
    const tx = transaction(inputs, [{ value, script: p2tr(target.q) }])
    return {
      tx,
      send: () =>
        w.frost.submitFrostMovedFundsSweepProof(
          target.id,
          tx.tx,
          inclusion(tx.hash)
        ),
    }
  }
  const counters = async (x: Wallet) => {
    const c = await w.frost.frostMovementCounters(x.id)
    return {
      pending: c.pendingIncoming.toNumber(),
      inbound: c.inboundCommitments.toNumber(),
      eligible: c.eligibleTargets.toNumber(),
    }
  }
  const spent = async (key: string) =>
    (await ethers.provider.getStorageAt(
      w.proxy.address,
      ethers.utils.hexZeroPad(
        w.entry(w.child(w.self, "spentMainUTXOs"), key).slot.toHexString(),
        32
      )
    )) !== ZERO
  const depositSweep = (
    x: Wallet,
    inputs: [string, number][],
    value: number,
    includeMain: boolean
  ) => {
    const tx = transaction(inputs, [{ value, script: p2tr(x.q) }])
    return {
      tx,
      send: () =>
        w.frost.submitFrostDepositSweepProof({
          walletId: x.id,
          transaction: tx.tx,
          proof: inclusion(tx.hash),
          includeMain,
          vault: ethers.constants.AddressZero,
        }),
    }
  }
  /// The world's moving funds parameters with another movingFundsTxMaxTotalFee.
  const setMoveFee = (fee: number) =>
    w.bridge.updateMovingFundsParameters(
      fee,
      20000,
      3600,
      7 * 86400,
      0,
      0,
      0,
      5000,
      10 * 86400,
      0,
      0
    )
  /// A reveal whose funding transaction is never swept, with the largest
  /// refund locktime (2106).
  const fabricatedReveal = async (x: Wallet) =>
    w.reveal(x, 50000, 0xffffffff - (await w.now()))
  const pendingReveals = (x: Wallet) =>
    w.readField(
      w.entry(w.child(w.child(w.self, "frostFunding"), "pendingReveals"), x.id)
    )

  before(async () => {
    w = await movementWorld(4)
    ;[source] = w.wallets
    await w.fund(source, 600000)
    // 599,000 sats at a 250,000 transfer cap needs three targets.
    targets = ascending(w.wallets.slice(1))
    await w.enterMovingFunds(source)
    expect(await counters(source)).to.deep.equal({
      pending: 0,
      inbound: 0,
      eligible: 3,
    })
    snapshot = await network.provider.send("evm_snapshot")
  })
  beforeEach(async () => {
    expect(await network.provider.send("evm_revert", [snapshot])).to.equal(true)
    snapshot = await network.provider.send("evm_snapshot")
  })

  it("moves the main to the committed targets and each target sweeps its output once", async () => {
    await expect(commit(targets)).to.emit(w.frost, "FrostMovingFundsCommitted")
    const c = await w.commitment(source)
    expect(c.mainOutpoint).to.equal((source.main as Tx).key())
    expect(c.targets).to.deep.equal(targets.map((t) => t.label))
    expect(c.descriptorHashes).to.deep.equal(
      targets.map((t) => t.descriptorHash)
    )
    for (const t of targets) expect((await counters(t)).inbound).to.equal(1)

    const values = split(source.value - MOVE_FEE, 3)
    const tx = movement(targets, values)
    await expect(prove(tx)).to.emit(w.frost, "FrostMovingFundsCompleted")
    expect(await w.state(source)).to.equal(State.Closing)
    const custody = await w.frost.frostWalletCustody(source.id)
    expect(custody.value).to.equal(0)
    expect(custody.mainOutpoint).to.equal(ZERO)
    expect(await spent((source.main as Tx).key())).to.equal(true)
    expect((await w.commitment(source)).provenAt).to.not.equal(0)

    for (let i = 0; i < 3; i++) {
      const t = targets[i]
      const incoming = await w.frost.frostIncoming(tx.key(i))
      expect(incoming.target).to.equal(t.id)
      expect(incoming.source).to.equal(source.id)
      expect(incoming.value).to.equal(values[i])
      expect(incoming.state).to.equal(Incoming.Pending)
      // K-08: the sweep fee cap in force at the proof, kept for defenses.
      expect(incoming.sweepFeeCap).to.equal(
        (await w.bridge.movingFundsParameters()).movedFundsSweepTxMaxTotalFee
      )
      expect(await counters(t)).to.deep.include({ pending: 1, inbound: 0 })

      const s = sweepIncoming(t, [[tx.hash, i]], values[i] - SWEEP_FEE)
      await expect(s.send()).to.emit(w.frost, "FrostMovedFundsSwept")
      expect((await w.frost.frostIncoming(tx.key(i))).state).to.equal(
        Incoming.Swept
      )
      expect(await spent(tx.key(i))).to.equal(true)
      expect((await counters(t)).pending).to.equal(0)
      expect(await w.state(t)).to.equal(State.Live)
      const tc = await w.frost.frostWalletCustody(t.id)
      expect(tc.value).to.equal(values[i] - SWEEP_FEE)
      expect(tc.mainOutpoint).to.equal(s.tx.key())

      // Replays: the same input cannot be consumed twice.
      const replay = sweepIncoming(
        t,
        [
          [s.tx.hash, 0],
          [tx.hash, i],
        ],
        values[i] * 2 - 2 * SWEEP_FEE
      )
      await expect(replay.send()).to.be.revertedWith(
        "FROST incoming input consumed"
      )
    }
    await expect(prove(tx)).to.be.revertedWith("FROST movement commitment")
    // Source value conservation: outputs plus the fee equal the old main.
    expect(values.reduce((a, b) => a + b, 0) + MOVE_FEE).to.equal(source.value)
  })

  it("accepts a commitment only from a seat operator, once, with eligible ascending targets of the expected count", async () => {
    await expect(commit(targets, w.treasury)).to.be.revertedWith(
      "FROST movement operator"
    )
    await expect(commit(targets, w.operator, 1)).to.be.revertedWith(
      "FROST movement operator"
    )
    await expect(commit(targets.slice(0, 2))).to.be.revertedWith(
      "FROST movement target count"
    )
    await expect(
      commit([targets[1], targets[0], targets[2]])
    ).to.be.revertedWith("FROST movement target order")
    await expect(
      commit([targets[0], targets[0], targets[2]])
    ).to.be.revertedWith("FROST movement target order")
    // A target that left eligibility shrinks the expected count and cannot
    // be named.
    await w.setState(targets[2], State.MovingFunds)
    expect((await counters(source)).eligible).to.equal(2)
    await expect(commit([targets[0], targets[2]])).to.be.revertedWith(
      "FROST movement target"
    )
    await commit(targets.slice(0, 2))
    await expect(commit(targets.slice(0, 2))).to.be.revertedWith(
      "FROST movement committed"
    )
  })

  it("pays and keeps obligating a committed target that later leaves eligibility", async () => {
    await commit(targets)
    // After commitment the first target starts closing and the second moves
    // its own funds: neither may redirect the outputs.
    await w.setState(targets[0], State.Closing)
    await w.setState(targets[1], State.MovingFunds)
    const values = split(source.value - MOVE_FEE, 3)
    const tx = movement(targets, values)
    await prove(tx)
    expect((await w.frost.frostIncoming(tx.key(0))).target).to.equal(
      targets[0].id
    )
    // A Closing target still sweeps; its new main reopens it to MovingFunds
    // in a fresh commitment period, so the funds must move again.
    await expect(
      sweepIncoming(targets[0], [[tx.hash, 0]], values[0] - SWEEP_FEE).send()
    )
      .to.emit(w.frost, "FrostWalletReopened")
      .withArgs(targets[0].id)
    expect(await w.state(targets[0])).to.equal(State.MovingFunds)
    const lifecycle = await w.frost.frostWalletLifecycle(targets[0].id)
    expect(lifecycle.period).to.equal(1)
    expect(lifecycle.closingStartedAt).to.equal(0)
    // A MovingFunds target sweeps too.
    await sweepIncoming(
      targets[1],
      [[tx.hash, 1]],
      values[1] - SWEEP_FEE
    ).send()
    expect(await w.state(targets[1])).to.equal(State.MovingFunds)
    expect((await counters(targets[1])).pending).to.equal(0)
  })

  it("refuses wrong order, amounts, keys, fees, inputs and partial outputs without state change", async () => {
    await commit(targets)
    const values = split(source.value - MOVE_FEE, 3)
    const before = await w.frost.frostWalletCustody(source.id)
    const swapped = movement([targets[1], targets[0], targets[2]], values)
    await expect(prove(swapped)).to.be.revertedWith("FROST movement output key")
    const uneven = movement(targets, [values[0] + 2, values[1] - 2, values[2]])
    await expect(prove(uneven)).to.be.revertedWith("FROST movement split")
    const stranger = movement([targets[0], targets[1], source], values)
    await expect(prove(stranger)).to.be.revertedWith(
      "FROST movement output key"
    )
    const greedy = movement(targets, split(source.value - 6000, 3))
    await expect(prove(greedy)).to.be.revertedWith("FROST movement fee")
    const inflated = movement(targets, split(source.value + 3, 3))
    await expect(prove(inflated)).to.be.revertedWith("FROST movement fee")
    const extra = movement(targets, values, [
      [(source.main as Tx).hash, 0],
      [ethers.utils.id("C06 stranger input"), 0],
    ])
    await expect(prove(extra)).to.be.revertedWith("FROST movement input")
    const partial = movement(
      targets.slice(0, 2),
      split(source.value - MOVE_FEE, 2)
    )
    await expect(prove(partial)).to.be.revertedWith(
      "FROST movement output count"
    )
    expect(await w.frost.frostWalletCustody(source.id)).to.deep.equal(before)
    expect(await w.state(source)).to.equal(State.MovingFunds)
    for (const t of targets)
      expect(await counters(t)).to.deep.include({ pending: 0, inbound: 1 })
  })

  it("refuses an incoming sweep that skips the main, pays elsewhere or takes another target's output", async () => {
    // targets[2] already holds a main; its incoming sweep must spend it too.
    const funded = targets[2]
    const fundedMain = await w.fund(funded, 30000)
    await commit(targets)
    const values = split(source.value - MOVE_FEE, 3)
    const tx = movement(targets, values)
    await prove(tx)
    const [a, b] = targets
    await sweepIncoming(a, [[tx.hash, 0]], values[0] - SWEEP_FEE).send()
    const main = (await w.frost.frostWalletCustody(a.id)).mainOutpoint
    expect(main).to.not.equal(ZERO)
    // b's output belongs to b; a cannot take it.
    await expect(
      sweepIncoming(a, [[tx.hash, 1]], values[1] - SWEEP_FEE).send()
    ).to.be.revertedWith("FROST incoming input")
    await expect(sweepIncoming(b, [[tx.hash, 1]], values[1] - SWEEP_FEE).send())
      .to.not.be.reverted
    const wrongKey = transaction(
      [[tx.hash, 2]],
      [{ value: values[2] - SWEEP_FEE, script: p2tr(a.q) }]
    )
    await expect(
      w.frost.submitFrostMovedFundsSweepProof(
        targets[2].id,
        wrongKey.tx,
        inclusion(wrongKey.hash)
      )
    ).to.be.revertedWith("FROST incoming output key")
    await expect(
      sweepIncoming(funded, [[tx.hash, 2]], values[2] - SWEEP_FEE).send()
    ).to.be.revertedWith("FROST incoming input set")
    await expect(
      sweepIncoming(
        funded,
        [
          [tx.hash, 2],
          [fundedMain.hash, 0],
        ],
        values[2] + 29000 - 6000
      ).send()
    ).to.be.revertedWith("FROST incoming fee")
    const merged = sweepIncoming(
      funded,
      [
        [tx.hash, 2],
        [fundedMain.hash, 0],
      ],
      values[2] + 29000 - SWEEP_FEE
    )
    await merged.send()
    const custody = await w.frost.frostWalletCustody(funded.id)
    expect(custody.value).to.equal(values[2] + 29000 - SWEEP_FEE)
    expect(custody.mainOutpoint).to.equal(merged.tx.key())
    expect(await spent(fundedMain.key())).to.equal(true)
  })

  it("escalates an unswept incoming output but keeps it sweepable and counted", async () => {
    await commit(targets)
    const values = split(source.value - MOVE_FEE, 3)
    const tx = movement(targets, values)
    await prove(tx)
    await expect(
      w.frost.notifyFrostMovedFundsSweepTimeout(tx.key(0))
    ).to.be.revertedWith("FROST incoming timeout")
    await advance(10 * 86400 + 1)
    await expect(w.frost.notifyFrostMovedFundsSweepTimeout(tx.key(0)))
      .to.emit(w.frost, "FrostIncomingEscalated")
      .withArgs(tx.key(0))
    await expect(
      w.frost.notifyFrostMovedFundsSweepTimeout(tx.key(0))
    ).to.be.revertedWith("FROST incoming timeout state")
    expect((await w.frost.frostIncoming(tx.key(0))).state).to.equal(
      Incoming.Escalated
    )
    expect((await counters(targets[0])).pending).to.equal(1)
    await sweepIncoming(
      targets[0],
      [[tx.hash, 0]],
      values[0] - SWEEP_FEE
    ).send()
    expect((await w.frost.frostIncoming(tx.key(0))).state).to.equal(
      Incoming.Swept
    )
    expect((await counters(targets[0])).pending).to.equal(0)
  })

  it("escalates an unproven commitment and still accepts its proof", async () => {
    await commit(targets)
    await expect(
      w.frost.notifyFrostMovingFundsTimeout(source.id)
    ).to.be.revertedWith("FROST movement timeout")
    await advance(7 * 86400 + 1)
    await expect(w.frost.notifyFrostMovingFundsTimeout(source.id))
      .to.emit(w.frost, "FrostMovingFundsEscalated")
      .withArgs(source.id)
    expect((await w.commitment(source)).escalated).to.equal(true)
    await prove(movement(targets))
    expect(await w.state(source)).to.equal(State.Closing)
  })

  it("with no eligible target refuses a commitment and resets the clock", async () => {
    for (const t of targets) await w.setState(t, State.MovingFunds)
    expect((await counters(source)).eligible).to.equal(0)
    await expect(commit([])).to.be.revertedWith("FROST movement no target")
    await expect(
      w.frost.resetFrostMovingFundsTimeout(source.id)
    ).to.be.revertedWith("FROST movement reset delay")
    await advance(3601)
    await expect(w.frost.resetFrostMovingFundsTimeout(source.id))
      .to.emit(w.frost, "FrostMovingFundsTimeoutReset")
      .withArgs(source.id)
    // Once a target is eligible again the reset is refused.
    await w.setState(targets[0], State.Live)
    await advance(3601)
    await expect(
      w.frost.resetFrostMovingFundsTimeout(source.id)
    ).to.be.revertedWith("FROST movement reset state")
  })

  it("records a below-dust main only when every other obligation is clear", async () => {
    const small = targets[2]
    await w.fund(small, 15000)
    // The source holds a deposit revealed while Live, then commits to all
    // three targets: small owes an inbound commitment.
    await w.setState(source, State.Live)
    const funding = await w.reveal(source, 50000)
    await w.setState(source, State.MovingFunds)
    await commit(targets)
    await w.enterMovingFunds(small)
    // Reveals stop once the wallet leaves Live.
    await expect(w.reveal(small, 50000, 3600)).to.be.revertedWith(
      "FROST deposit wallet"
    )
    await expect(
      w.frost.notifyFrostMovingFundsBelowDust(small.id)
    ).to.be.revertedWith("FROST movement obligations")
    await expect(
      w.frost.notifyFrostMovingFundsBelowDust(source.id)
    ).to.be.revertedWith("FROST movement dust state")
    // The source's proven deposit sweep spends its committed main, which
    // retires the commitment and releases small's inbound obligation.
    const sweep = depositSweep(
      source,
      [
        [(source.main as Tx).hash, 0],
        [funding.hash, 0],
      ],
      source.value + 49000,
      true
    )
    await sweep.send()
    expect((await counters(small)).inbound).to.equal(0)
    await expect(w.frost.notifyFrostMovingFundsBelowDust(small.id))
      .to.emit(w.frost, "FrostMovingFundsBelowDust")
      .withArgs(small.id, 14000)
    expect(await w.state(small)).to.equal(State.Closing)
    const lifecycle = await w.frost.frostWalletLifecycle(small.id)
    expect(lifecycle.dust).to.equal(true)
    expect(lifecycle.closingStartedAt).to.not.equal(0)
    // The dust main stays recorded custody; nothing is deleted.
    expect((await w.frost.frostWalletCustody(small.id)).value).to.equal(14000)
    await expect(
      w.frost.notifyFrostMovingFundsBelowDust(small.id)
    ).to.be.revertedWith("FROST movement dust state")
  })

  it("does not let a fabricated reveal that is never swept block the source's commitment", async () => {
    // Reviewer: an unproven reveal with refundLocktime 0xffffffff, made while
    // the source was Live, blocked its movement until 2106.
    await w.setState(source, State.Live)
    const fake = await fabricatedReveal(source)
    await w.setState(source, State.MovingFunds)
    expect(
      (await w.deposit(outpoint(fake.hash, 0))).terms.refundLocktime
    ).to.equal(0xffffffff)
    expect(await pendingReveals(source)).to.equal(1)
    await expect(commit(targets)).to.emit(w.frost, "FrostMovingFundsCommitted")
    await expect(prove(movement(targets))).to.emit(
      w.frost,
      "FrostMovingFundsCompleted"
    )
    expect(await w.state(source)).to.equal(State.Closing)
    // The reveal stays recorded; it simply does not hold the wallet.
    expect(await pendingReveals(source)).to.equal(1)
  })

  it("does not let a fabricated reveal that is never swept block a dust closure", async () => {
    const small = targets[2]
    await w.fund(small, 15000)
    const fake = await fabricatedReveal(small)
    await w.enterMovingFunds(small)
    expect(
      (await w.deposit(outpoint(fake.hash, 0))).terms.refundLocktime
    ).to.equal(0xffffffff)
    expect(await pendingReveals(small)).to.equal(1)
    await expect(w.frost.notifyFrostMovingFundsBelowDust(small.id))
      .to.emit(w.frost, "FrostMovingFundsBelowDust")
      .withArgs(small.id, 14000)
    expect(await w.state(small)).to.equal(State.Closing)
    expect((await w.frost.frostWalletLifecycle(small.id)).dust).to.equal(true)
  })

  it("retires an unproven commitment whose main a proven deposit sweep spent and accepts a new one", async () => {
    // A deposit revealed while Live; the source then entered MovingFunds.
    await w.setState(source, State.Live)
    const funding = await w.reveal(source, 50000)
    await w.setState(source, State.MovingFunds)
    const oldMain = source.main as Tx
    await commit(targets)
    const old = movement(targets)
    for (const t of targets) expect((await counters(t)).inbound).to.equal(1)

    // The deposit sweep spends the committed main together with the deposit.
    const value = source.value + 49000
    const sweep = depositSweep(
      source,
      [
        [oldMain.hash, 0],
        [funding.hash, 0],
      ],
      value,
      true
    )
    await expect(sweep.send())
      .to.emit(w.frost, "FrostMovingFundsCommitmentRetired")
      .withArgs(source.id, 0)
    const retired = await w.commitment(source, 0)
    expect(retired.retired).to.equal(true)
    expect(retired.provenAt).to.equal(0)
    expect(retired.mainOutpoint).to.equal(oldMain.key())
    expect(retired.targets).to.deep.equal(targets.map((t) => t.label))
    const lifecycle = await w.frost.frostWalletLifecycle(source.id)
    expect(lifecycle.period).to.equal(1)
    expect(await w.state(source)).to.equal(State.MovingFunds)
    for (const t of targets) expect((await counters(t)).inbound).to.equal(0)
    const custody = await w.frost.frostWalletCustody(source.id)
    expect(custody.value).to.equal(value)
    expect(custody.mainOutpoint).to.equal(sweep.tx.key())
    expect(await spent(oldMain.key())).to.equal(true)
    // The old movement can never be proven.
    await expect(prove(old)).to.be.revertedWith("FROST movement commitment")

    // A new commitment of the new main in the new period.
    await expect(commit(targets)).to.emit(w.frost, "FrostMovingFundsCommitted")
    const fresh = await w.commitment(source)
    expect(fresh.mainOutpoint).to.equal(sweep.tx.key())
    expect(fresh.retired).to.equal(false)
    for (const t of targets) expect((await counters(t)).inbound).to.equal(1)
    await expect(prove(old)).to.be.revertedWith("FROST movement input")
    const values = split(value - MOVE_FEE, 3)
    const next = movement(targets, values, [[sweep.tx.hash, 0]])
    await expect(prove(next)).to.emit(w.frost, "FrostMovingFundsCompleted")
    expect(await w.state(source)).to.equal(State.Closing)
    expect((await w.commitment(source, 1)).provenAt).to.not.equal(0)
    expect((await w.commitment(source, 0)).retired).to.equal(true)
    for (let i = 0; i < 3; i++) {
      const incoming = await w.frost.frostIncoming(next.key(i))
      expect(incoming.target).to.equal(targets[i].id)
      expect(incoming.value).to.equal(values[i])
      expect(await counters(targets[i])).to.deep.include({
        pending: 1,
        inbound: 0,
      })
    }
  })

  it("reopens a dust-closed wallet that proves a late deposit sweep", async () => {
    // Reviewer: a 14,000-sat dust wallet sweeping an expired 50,000-sat
    // deposit stayed Closing with dust recorded.
    const small = targets[2]
    const smallMain = await w.fund(small, 15000)
    const funding = await w.reveal(small, 50000, 3600)
    await w.enterMovingFunds(small)
    await w.frost.notifyFrostMovingFundsBelowDust(small.id)
    expect(await w.state(small)).to.equal(State.Closing)
    // Past the deposit's refund locktime the depositor could have refunded;
    // the wallet swept it first.
    await advance(3601)
    const sweep = depositSweep(
      small,
      [
        [smallMain.hash, 0],
        [funding.hash, 0],
      ],
      14000 + 49000,
      true
    )
    await expect(sweep.send())
      .to.emit(w.frost, "FrostWalletReopened")
      .withArgs(small.id)
    expect(await w.state(small)).to.equal(State.MovingFunds)
    const lifecycle = await w.frost.frostWalletLifecycle(small.id)
    expect(lifecycle.period).to.equal(1)
    expect(lifecycle.dust).to.equal(false)
    expect(lifecycle.closingStartedAt).to.equal(0)
    expect(lifecycle.movingFundsRequestedAt).to.equal(await w.now())
    const custody = await w.frost.frostWalletCustody(small.id)
    expect(custody.value).to.equal(63000)
    expect(custody.mainOutpoint).to.equal(sweep.tx.key())
    // The credited value must move again: a commitment is accepted.
    const [first] = targets
    await w.frost
      .connect(w.operator)
      .submitFrostMovingFundsCommitment(small.id, 0, [first.label])
    const c = await w.commitment(small)
    expect(c.mainOutpoint).to.equal(sweep.tx.key())
    expect(c.targets).to.deep.equal([first.label])
  })

  it("clears recorded dust when a terminated wallet later gains custody", async () => {
    // A terminated wallet records dust and stays Terminated; a late deposit
    // sweep must clear the dust so the credited value can be committed.
    const small = targets[2]
    const smallMain = await w.fund(small, 15000)
    const funding = await w.reveal(small, 50000, 3600)
    await w.setState(small, State.Terminated)
    await w.frost.notifyFrostMovingFundsBelowDust(small.id)
    expect(await w.state(small)).to.equal(State.Terminated)
    expect((await w.frost.frostWalletLifecycle(small.id)).dust).to.equal(true)
    await depositSweep(
      small,
      [
        [smallMain.hash, 0],
        [funding.hash, 0],
      ],
      14000 + 49000,
      true
    ).send()
    const lifecycle = await w.frost.frostWalletLifecycle(small.id)
    expect(lifecycle.dust).to.equal(false)
    expect(lifecycle.period).to.equal(1)
    expect(await w.state(small)).to.equal(State.Terminated)
    const [first] = targets
    await w.frost
      .connect(w.operator)
      .submitFrostMovingFundsCommitment(small.id, 0, [first.label])
    expect((await w.commitment(small)).targets).to.deep.equal([first.label])
  })

  it("checks a movement fee against the cap in force at commitment", async () => {
    await commit(targets)
    expect((await w.commitment(source)).maxFee).to.equal(5000)
    const over = movement(targets, split(source.value - 6000, 3))
    // Governance lowers the cap after commitment.
    await setMoveFee(1000)
    await expect(prove(over)).to.be.revertedWith("FROST movement fee")
    // Raising it does not widen the committed cap either.
    await setMoveFee(8000)
    await expect(prove(over)).to.be.revertedWith("FROST movement fee")
    await setMoveFee(1000)
    // MOVE_FEE (3,000) fits the committed 5,000 cap though the current is 1,000.
    await expect(prove(movement(targets))).to.emit(
      w.frost,
      "FrostMovingFundsCompleted"
    )
    expect(await w.state(source)).to.equal(State.Closing)
  })
})

describe("C-06 legacy routes: ECDSA to FROST drain and the stranded case", () => {
  let w: World
  let snapshot: string
  const LegacyState = { Live: 1, MovingFunds: 2, Closing: 3, Terminated: 5 }

  const advance = async (seconds: number) => {
    await network.provider.send("evm_increaseTime", [seconds])
    await network.provider.send("evm_mine")
  }
  let created = 0
  /// Registers a legacy wallet through the real registry callback.
  const legacyWallet = async () => {
    created += 1
    const pub = ethers.utils.computePublicKey(
      ethers.utils.hexZeroPad(ethers.utils.hexlify(5000 + created), 32)
    )
    const x = `0x${pub.slice(4, 68)}`
    const y = `0x${pub.slice(68)}`
    const compressed = ethers.utils.computePublicKey(pub, true)
    const pkh = ethers.utils.ripemd160(ethers.utils.sha256(compressed))
    await w.legacyRegistry.publish(
      ethers.utils.id(`legacy wallet ${created}`),
      x,
      y
    )
    return pkh
  }
  const legacyNode = (pkh: string) =>
    w.entry(w.child(w.self, "registeredWallets"), pkh, "bytes20")
  /// Controlled legacy markers: a main UTXO and MovingFunds (or another state).
  const legacyMain = async (pkh: string, value: number) => {
    const utxo = {
      txHash: ethers.utils.id(`legacy main ${pkh}`),
      txOutputIndex: 0,
      txOutputValue: value,
    }
    await w.writeField(
      w.child(legacyNode(pkh), "mainUtxoHash"),
      ethers.utils.solidityKeccak256(
        ["bytes32", "uint32", "uint64"],
        [utxo.txHash, utxo.txOutputIndex, utxo.txOutputValue]
      )
    )
    return utxo
  }
  const legacyState = async (pkh: string, state: number) => {
    const live = w.child(w.self, "liveWalletsCount")
    const before = await w.readField(w.child(legacyNode(pkh), "state"))
    if (before === LegacyState.Live && state !== LegacyState.Live)
      await w.writeField(live, (await w.readField(live)) - 1)
    await w.writeField(w.child(legacyNode(pkh), "state"), state)
    if (state === LegacyState.MovingFunds)
      await w.writeField(
        w.child(legacyNode(pkh), "movingFundsRequestedAt"),
        await w.now()
      )
  }
  const members = [1, 2, 3]
  /// A gated drain of a 400,000-sat legacy main into two FROST targets, and
  /// its unproven drain transaction.
  const drain = async () => {
    const pkh = await legacyWallet()
    const main = await legacyMain(pkh, 400000)
    await legacyState(pkh, LegacyState.MovingFunds)
    await w.frost.setFrostDrainEnabled(true)
    const targets = ascending(w.wallets).slice(0, 2)
    const labels = targets.map((t) => t.label)
    await w.bridge
      .connect(w.operator)
      .submitMovingFundsCommitment(pkh, main, members, 0, labels)
    const values = split(400000 - 3000, 2)
    const tx = transaction(
      [[main.txHash, 0]],
      targets.map((t, i) => ({ value: values[i], script: p2tr(t.q) }))
    )
    return { pkh, main, targets, labels, values, tx }
  }

  before(async () => {
    w = await movementWorld(3)
    await w.legacyRegistry.setMember(w.operator.address)
    snapshot = await network.provider.send("evm_snapshot")
  })
  beforeEach(async () => {
    expect(await network.provider.send("evm_revert", [snapshot])).to.equal(true)
    snapshot = await network.provider.send("evm_snapshot")
  })

  for (const blocked of ["contained", "disabled", "empty"] as const) {
    for (const live of [false, true]) {
      it(`keeps an uncommitted post-cutover legacy obligation resettable: ${blocked}, live=${live}`, async () => {
        const pkh = await legacyWallet()
        const main = await legacyMain(pkh, 400000)
        await legacyState(pkh, LegacyState.MovingFunds)
        const other = live ? await legacyWallet() : undefined
        await w.frost.setFrostDrainEnabled(true)
        await w.frost.beginLegacyDkgDrain()
        await w.frost.completeFrostCutover(
          ethers.utils.id("K09 uncommitted moving obligation")
        )
        if (blocked === "contained")
          await w.exposure.contain(ethers.utils.id("K09 emergency"))
        if (blocked === "disabled") await w.frost.setFrostDrainEnabled(false)
        if (blocked === "empty")
          for (const wallet of w.wallets)
            await w.setState(wallet, State.MovingFunds)
        const labels = ascending(w.wallets)
          .slice(0, 2)
          .map((x) => x.label)
        const frame = async () => ({
          // Only the explicit timeout timestamp may advance on reset.
          wallet: (await w.bridge.wallets(pkh))
            .slice()
            .filter((_: unknown, i: number) => i !== 4)
            .map(String),
          other: other
            ? (await w.bridge.wallets(other)).slice().map(String)
            : [],
          live: String(await w.bridge.liveWalletsCount()),
          exposure: [
            String(await w.exposure.custodyReserved()),
            String(await w.exposure.issuanceReserved()),
          ],
          counters: await Promise.all(
            w.wallets.map(async (x) =>
              (await w.frost.frostMovementCounters(x.id)).slice().map(String)
            )
          ),
        })
        const before = await frame()
        await expect(
          w.bridge
            .connect(w.operator)
            .submitMovingFundsCommitment(pkh, main, members, 0, labels)
        ).to.be.reverted
        if (other)
          await expect(
            w.bridge
              .connect(w.operator)
              .submitMovingFundsCommitment(pkh, main, members, 0, [other])
          ).to.be.revertedWith("Legacy targets disabled after cutover")
        try {
          await expect(
            w.bridge.resetMovingFundsTimeout(pkh)
          ).to.be.revertedWith("Moving funds timeout cannot be reset yet")
        } catch (_) {
          throw Error(
            "control LegacyTimeoutRecovery assertion: incorrect reset eligibility"
          )
        }
        for (let i = 0; i < 2; i++) {
          await advance(6 * 86400)
          const old = (await w.bridge.wallets(pkh)).movingFundsRequestedAt
          try {
            await expect(w.bridge.resetMovingFundsTimeout(pkh))
              .to.emit(w.bridge, "MovingFundsTimeoutReset")
              .withArgs(pkh)
          } catch (_) {
            throw Error(
              "control LegacyTimeoutRecovery assertion: admissible timeout reset refused"
            )
          }
          expect((await w.bridge.wallets(pkh)).movingFundsRequestedAt).to.be.gt(
            old
          )
          await expect(w.bridge.notifyMovingFundsTimeout(pkh, members)).to.be
            .reverted
          expect(await frame()).to.deep.equal(before)
        }
        if (blocked === "contained")
          await w.exposure.lift(ethers.utils.id("K09 reopen"))
        if (blocked === "disabled") await w.frost.setFrostDrainEnabled(true)
        if (blocked === "empty")
          for (const wallet of w.wallets)
            await w.setState(wallet, State.ReadyUnfunded)
        if (other)
          await expect(
            w.bridge.resetMovingFundsTimeout(pkh)
          ).to.be.revertedWith("Live wallets count must be zero")
        await w.bridge
          .connect(w.operator)
          .submitMovingFundsCommitment(pkh, main, members, 0, labels)
        expect(await w.frost.frostDrainTargets(pkh)).to.deep.equal(labels)
        // A committed route never regains the reset permission.
        await w.exposure.contain(
          ethers.utils.id("K09 contained after commitment")
        )
        await advance(3601)
        await expect(w.bridge.resetMovingFundsTimeout(pkh)).to.be.revertedWith(
          "Target wallets commitment already submitted"
        )
        const targets = ascending(w.wallets).slice(0, 2)
        const tx = transaction(
          [[main.txHash, 0]],
          targets.map((x, i) => ({
            value: split(397000, 2)[i],
            script: p2tr(x.q),
          }))
        )
        await w.bridge.submitMovingFundsProof(
          tx.tx,
          inclusion(tx.hash),
          main,
          pkh
        )
        expect((await w.bridge.wallets(pkh)).mainUtxoHash).to.equal(ZERO)
        expect((await w.bridge.wallets(pkh)).state).to.equal(
          LegacyState.Closing
        )
      })
    }
  }

  it("drains a legacy wallet into FROST targets only behind the drain gate", async () => {
    const pkh = await legacyWallet()
    const main = await legacyMain(pkh, 400000)
    await legacyState(pkh, LegacyState.MovingFunds)
    const targets = ascending(w.wallets).slice(0, 2)
    const labels = targets.map((t) => t.label)
    await expect(
      w.bridge
        .connect(w.operator)
        .submitMovingFundsCommitment(pkh, main, members, 0, labels)
    ).to.be.revertedWith("FROST drain disabled")
    await w.frost.setFrostDrainEnabled(true)
    await w.bridge
      .connect(w.operator)
      .submitMovingFundsCommitment(pkh, main, members, 0, labels)
    expect(await w.frost.frostDrainTargets(pkh)).to.deep.equal(labels)
    for (const t of targets)
      expect(
        (await w.frost.frostMovementCounters(t.id)).inboundCommitments
      ).to.equal(1)

    const values = split(400000 - 3000, 2)
    const mixed = transaction(
      [[main.txHash, 0]],
      [
        { value: values[0], script: p2tr(targets[0].q) },
        {
          value: values[1],
          script: Buffer.concat([
            Buffer.from("160014", "hex"),
            Buffer.from(pkh.slice(2), "hex"),
          ]),
        },
      ]
    )
    await expect(
      w.bridge.submitMovingFundsProof(
        mixed.tx,
        inclusion(mixed.hash),
        main,
        pkh
      )
    ).to.be.revertedWith("FROST drain mixes schemes")

    const tx = transaction(
      [[main.txHash, 0]],
      targets.map((t, i) => ({ value: values[i], script: p2tr(t.q) }))
    )
    await w.bridge.submitMovingFundsProof(tx.tx, inclusion(tx.hash), main, pkh)
    expect(await w.readField(w.child(legacyNode(pkh), "state"))).to.equal(
      LegacyState.Closing
    )
    expect(await w.frost.frostDrainTargets(pkh)).to.deep.equal([])
    for (let i = 0; i < 2; i++) {
      const incoming = await w.frost.frostIncoming(tx.key(i))
      expect(incoming.target).to.equal(targets[i].id)
      // A legacy source is its 20-byte label, left-aligned.
      expect(incoming.source).to.equal(`${pkh}${"0".repeat(24)}`)
      expect(incoming.state).to.equal(Incoming.Pending)
      expect(incoming.sweepFeeCap).to.equal(
        (await w.bridge.movingFundsParameters()).movedFundsSweepTxMaxTotalFee
      )
      // No legacy request exists for a FROST output.
      expect(
        (await w.bridge.movedFundsSweepRequests(tx.key(i))).state
      ).to.equal(0)
      const sweep = transaction(
        [[tx.hash, i]],
        [{ value: values[i] - 500, script: p2tr(targets[i].q) }]
      )
      await w.frost.submitFrostMovedFundsSweepProof(
        targets[i].id,
        sweep.tx,
        inclusion(sweep.hash)
      )
      expect(await w.state(targets[i])).to.equal(State.Live)
      expect(
        (await w.frost.frostMovementCounters(targets[i].id)).pendingIncoming
      ).to.equal(0)
    }
  })

  it("keeps the legacy commitment hash for a drain, so the legacy proposal validator accepts it", async () => {
    const { pkh, main, labels } = await drain()
    // Reviewer: the validator reverted on the old drain hash.
    expect(
      (await w.bridge.wallets(pkh)).movingFundsTargetWalletsCommitmentHash
    ).to.equal(ethers.utils.solidityKeccak256(["bytes20[]"], [labels]))
    const validator = await deploy("WalletProposalValidator", [w.proxy.address])
    expect(
      await validator.validateMovingFundsProposal(
        {
          walletPubKeyHash: pkh,
          movingFundsTxFee: 3000,
          targetWallets: labels,
        },
        main
      )
    ).to.equal(true)
    await expect(
      validator.validateMovingFundsProposal(
        {
          walletPubKeyHash: pkh,
          movingFundsTxFee: 3000,
          targetWallets: labels.slice(0, 1),
        },
        main
      )
    ).to.be.revertedWith(
      "Target wallets do not match target wallets commitment hash"
    )
  })

  it("proves a drain late after its legacy source timed out and records the FROST incoming outputs", async () => {
    // Reviewer: the old release deleted the obligations without Bitcoin
    // evidence, though the drain could still confirm.
    const { pkh, main, targets, values, tx } = await drain()
    await advance(7 * 86400 + 1)
    await w.bridge.notifyMovingFundsTimeout(pkh, members)
    expect(await w.readField(w.child(legacyNode(pkh), "state"))).to.equal(
      LegacyState.Terminated
    )
    await expect(
      w.bridge.submitMovingFundsProof(tx.tx, inclusion(tx.hash), main, pkh)
    ).to.emit(w.bridge, "MovingFundsCompleted")
    expect(await w.readField(w.child(legacyNode(pkh), "state"))).to.equal(
      LegacyState.Terminated
    )
    expect((await w.bridge.wallets(pkh)).mainUtxoHash).to.equal(ZERO)
    expect(await w.frost.frostDrainTargets(pkh)).to.deep.equal([])
    for (let i = 0; i < 2; i++) {
      const incoming = await w.frost.frostIncoming(tx.key(i))
      expect(incoming.target).to.equal(targets[i].id)
      expect(incoming.value).to.equal(values[i])
      expect(incoming.state).to.equal(Incoming.Pending)
      const c = await w.frost.frostMovementCounters(targets[i].id)
      expect(c.inboundCommitments).to.equal(0)
      expect(c.pendingIncoming).to.equal(1)
    }
    await expect(
      w.bridge.submitMovingFundsProof(tx.tx, inclusion(tx.hash), main, pkh)
    ).to.be.revertedWith("No main UTXO for given wallet")
  })

  it("releases a drain's inbound obligations on a proven conflicting spend of the legacy main", async () => {
    const { pkh, main, targets, tx } = await drain()
    const [, , other] = ascending(w.wallets)
    // The legacy main went elsewhere: a P2WPKH and a non-target P2TR output.
    const conflict = transaction(
      [[main.txHash, 0]],
      [
        { value: 200000, script: p2wpkh(pkh) },
        { value: 197000, script: p2tr(other.q) },
      ]
    )
    await expect(
      w.frost.releaseFrostDrainOnConflict(
        pkh,
        { ...main, txOutputValue: 1 },
        conflict.tx,
        inclusion(conflict.hash)
      )
    ).to.be.revertedWith("FROST drain release state")
    await expect(
      w.frost.releaseFrostDrainOnConflict(
        pkh,
        main,
        conflict.tx,
        inclusion(conflict.hash)
      )
    )
      .to.emit(w.frost, "FrostDrainReleased")
      .withArgs(pkh)
    for (const t of targets)
      expect(
        (await w.frost.frostMovementCounters(t.id)).inboundCommitments
      ).to.equal(0)
    expect(await w.frost.frostDrainTargets(pkh)).to.deep.equal([])
    await expect(
      w.frost.releaseFrostDrainOnConflict(
        pkh,
        main,
        conflict.tx,
        inclusion(conflict.hash)
      )
    ).to.be.revertedWith("FROST drain release state")
    // The released drain cannot be recorded afterwards.
    await expect(
      w.bridge.submitMovingFundsProof(tx.tx, inclusion(tx.hash), main, pkh)
    ).to.be.revertedWith("FROST drain descriptor")
  })

  it("refuses a drain release whose transaction pays a committed target or does not spend the main", async () => {
    const { pkh, main, targets, tx } = await drain()
    // Any output to a committed target's key is not a conflict.
    const paysTarget = transaction(
      [[main.txHash, 0]],
      [
        { value: 300000, script: p2wpkh(pkh) },
        { value: 97000, script: p2tr(targets[1].q) },
      ]
    )
    await expect(
      w.frost.releaseFrostDrainOnConflict(
        pkh,
        main,
        paysTarget.tx,
        inclusion(paysTarget.hash)
      )
    ).to.be.revertedWith("FROST drain conflict pays a target")
    // The drain itself pays the targets.
    await expect(
      w.frost.releaseFrostDrainOnConflict(pkh, main, tx.tx, inclusion(tx.hash))
    ).to.be.revertedWith("FROST drain conflict pays a target")
    const elsewhere = transaction(
      [
        [ethers.utils.id("C06 unrelated input"), 0],
        [main.txHash, 1],
      ],
      [{ value: 397000, script: p2wpkh(pkh) }]
    )
    await expect(
      w.frost.releaseFrostDrainOnConflict(
        pkh,
        main,
        elsewhere.tx,
        inclusion(elsewhere.hash)
      )
    ).to.be.revertedWith("FROST drain conflict input")
    for (const t of targets)
      expect(
        (await w.frost.frostMovementCounters(t.id)).inboundCommitments
      ).to.equal(1)
    // The drain stays provable.
    await w.bridge.submitMovingFundsProof(tx.tx, inclusion(tx.hash), main, pkh)
    expect(await w.readField(w.child(legacyNode(pkh), "state"))).to.equal(
      LegacyState.Closing
    )
  })

  it("regression: a legacy target closed with a pending moved funds sweep is stranded", async () => {
    // The legacy rule this package replaces for FROST targets. A Closing
    // target can neither sweep its incoming output nor have it timed out.
    const source = await legacyWallet()
    const target = await legacyWallet()
    const main = await legacyMain(source, 100000)
    await legacyState(source, LegacyState.MovingFunds)
    await w.bridge
      .connect(w.operator)
      .submitMovingFundsCommitment(source, main, members, 0, [target])
    // The target, with no main of its own, starts closing (as
    // notifyWalletCloseable would do through moveFunds).
    await legacyState(target, LegacyState.Closing)
    const tx = transaction(
      [[main.txHash, 0]],
      [
        {
          value: 97000,
          script: Buffer.concat([
            Buffer.from("160014", "hex"),
            Buffer.from(target.slice(2), "hex"),
          ]),
        },
      ]
    )
    await w.bridge.submitMovingFundsProof(
      tx.tx,
      inclusion(tx.hash),
      main,
      source
    )
    const request = await w.bridge.movedFundsSweepRequests(tx.key(0))
    expect(request.state).to.equal(1) // Pending, though the target is Closing
    const sweep = transaction(
      [[tx.hash, 0]],
      [
        {
          value: 96500,
          script: Buffer.concat([
            Buffer.from("160014", "hex"),
            Buffer.from(target.slice(2), "hex"),
          ]),
        },
      ]
    )
    await expect(
      w.bridge.submitMovedFundsSweepProof(sweep.tx, inclusion(sweep.hash), {
        txHash: ZERO,
        txOutputIndex: 0,
        txOutputValue: 0,
      })
    ).to.be.revertedWith("Wallet must be in Live or MovingFunds state")
    await advance(10 * 86400 + 1)
    await expect(
      w.bridge.notifyMovedFundsSweepTimeout(tx.hash, 0, members)
    ).to.be.revertedWith(
      "Wallet must be in Live or MovingFunds or Terminated state"
    )
  })
})
