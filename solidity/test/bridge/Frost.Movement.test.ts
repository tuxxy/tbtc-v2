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
  outpoint,
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
    // A deposit revealed while Live, still unswept, blocks dust closure
    // until it expires. Reveals stop once the wallet leaves Live.
    const pending = await w.reveal(small, 50000, 3600)
    await w.enterMovingFunds(small)
    await expect(w.reveal(small, 50000, 3600)).to.be.revertedWith(
      "FROST deposit wallet"
    )
    await expect(
      w.frost.notifyFrostMovingFundsBelowDust(small.id)
    ).to.be.revertedWith("FROST movement obligations")
    await expect(
      w.frost.notifyFrostMovingFundsBelowDust(source.id)
    ).to.be.revertedWith("FROST movement dust state")
    await advance(3601)
    await w.frost.notifyFrostDepositExpired(outpoint(pending.hash, 0))
    await expect(w.frost.notifyFrostMovingFundsBelowDust(small.id))
      .to.emit(w.frost, "FrostMovingFundsBelowDust")
      .withArgs(small.id, 14000)
    expect(await w.state(small)).to.equal(State.Closing)
    const lifecycle = await w.frost.frostWalletLifecycle(small.id)
    expect(lifecycle.dust).to.equal(true)
    expect(lifecycle.closingStartedAt).to.not.equal(0)
    // The dust main stays recorded custody; nothing is deleted.
    expect((await w.frost.frostWalletCustody(small.id)).value).to.equal(14000)
  })

  it("expires a revealed deposit past its refund locktime once and unblocks the source", async () => {
    // Revealed while Live; the wallet then entered MovingFunds.
    await w.setState(source, State.Live)
    const funding = await w.reveal(source, 50000, 3600)
    await w.setState(source, State.MovingFunds)
    const key = outpoint(funding.hash, 0)
    await expect(commit(targets)).to.be.revertedWith(
      "FROST movement obligations"
    )
    await expect(w.frost.notifyFrostDepositExpired(key)).to.be.revertedWith(
      "FROST deposit not expired"
    )
    await advance(3601)
    await expect(w.frost.notifyFrostDepositExpired(key))
      .to.emit(w.frost, "FrostDepositExpired")
      .withArgs(key)
    await expect(w.frost.notifyFrostDepositExpired(key)).to.be.revertedWith(
      "FROST deposit expiry state"
    )
    expect((await w.deposit(key)).expiredAt).to.be.gt(0)
    await commit(targets)
  })

  it("does not decrement pending reveals twice when an expired deposit is still swept", async () => {
    const t = targets[0]
    const first = await w.reveal(t, 50000, 3600)
    const second = await w.reveal(t, 50000, 86400)
    await advance(3601)
    await w.frost.notifyFrostDepositExpired(outpoint(first.hash, 0))
    const sweep = transaction(
      [
        [first.hash, 0],
        [second.hash, 0],
      ],
      [{ value: 99000, script: p2tr(t.q) }]
    )
    // pendingReveals is 1 here; consuming both deposits must leave it at 0.
    await w.frost.submitFrostDepositSweepProof({
      walletId: t.id,
      transaction: sweep.tx,
      proof: inclusion(sweep.hash),
      includeMain: false,
      vault: ethers.constants.AddressZero,
    })
    const pending = w.entry(
      w.child(w.child(w.self, "frostFunding"), "pendingReveals"),
      t.id
    )
    expect(await w.readField(pending)).to.equal(0)
  })
})
