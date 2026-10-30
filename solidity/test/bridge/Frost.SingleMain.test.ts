/* eslint-disable no-await-in-loop, no-restricted-syntax */
// Refs tuxxy/tbtc-v2#24 (D13 refinement, DECISIONS.md, tux 2026-10-30).
//
// Invariant (single main): after every accepted Bridge call, a FROST wallet's
// recognized unspent custody is exactly its main:
//   custody.value == outputs[custody.mainOutpoint].value (or both zero).
// Rule, as in ECDSA: no ordinary deposit sweep while the wallet's main is
// reserved for a redemption (C-04 activeReservation != 0), whether or not it
// claims the main. Deposits wait until the reservation resolves (payment,
// cancellation or sweep resolution). The only sweep admitted during a
// reservation is the C-04 sweep-resolution route (KC-SF-V3 §4.6), which
// spends the reserved main under its resolution authorization. A wallet with
// no main and no reservation still takes a deposit-only first sweep.
//
// Predicates supported (KC-VER rev 02): P-K06-ONE-MAIN-PURPOSE (line 295: one
// main, one purpose; resolution is the only sweep spending a reserved main),
// P-K06-CREDIT-ONCE (every waiting deposit is credited exactly once, after
// the reservation resolves), VD-07 (line 508), and the movement side of
// P-K05-* (lines 230-239): a movement of the main alone drains the wallet.
// KC-SF-V3 C-04 (lines 584-586), C-05 (600-602), C-06 (614-616).
//
// FIXTURES: inclusion proofs are synthetic two-leaf regtest blocks
// (movementWorld): accounting only, not Bitcoin spend validity or chain work.
// Registry readiness is the controlled FrostRegistryFixture. The reservation
// and sweep-resolution certificates are signed by the wallet's operators
// (seats 1 and 2). Every state below is reached through public entrypoints;
// no Bridge storage is written.
import { createHash } from "crypto"
import { ContractTransaction } from "ethers"
import { ethers, network } from "hardhat"
import { expect } from "chai"
import {
  State,
  ZERO,
  movementWorld,
  transaction,
  inclusion,
  outpoint,
  p2tr,
  ascending,
  split,
  World,
  Wallet,
  Tx,
} from "../helpers/frost-movement-world"
import { reservationProposal } from "../helpers/frost-reservation-proposal"

const GENESIS = ethers.utils.id("C06 synthetic regtest domain")
const REDEEMER_SCRIPT = `0x0014${"11".repeat(20)}`
const LOCK_AHEAD = 365 * 86400
const FUNDED = 600000
const FUND_FEE = 1000
// A 30,000 sat request: treasury fee 300, Bitcoin fee 1,000, paid 28,700.
const REDEEMED = 30000
const PAID = 28700
const PAYMENT_FEE = 1000
const SWEEP_FEE = 1000
const MOVE_FEE = 3000
const RESOLUTION_TYPE =
  "tuple(bytes32 reservationId,bytes32 transactionHash,address vault,uint64 validUntilBlock)"
// The refusal must come from the main/reservation guard of the deposit sweep
// ("FROST sweep main required" or "FROST sweep main reserved"), not from a
// malformed transaction, proof or deposit.
const MAIN_GUARD = /FROST sweep main (required|reserved)/
// Intent states (FrostRedemptionLedger.IntentState).
const Intent = {
  Reserved: 1,
  Paid: 2,
  TimeoutPending: 4,
  Quarantined: 5,
  ConflictResolved: 6,
}
const EXPOSURE = [
  "custodyReserved",
  "custodyReleased",
  "custodyAdmitted",
  "issuanceReserved",
  "issued",
  "depositsOutstanding",
  "remainingCustody",
  "remainingIssuance",
]

type Proposal = Awaited<ReturnType<typeof reservationProposal>>
type Reservation = {
  requestId: string
  reservationId: string
  proposal: Proposal
}
type Authorization = {
  reservationId: string
  transactionHash: string
  vault: string
  validUntilBlock: number
}

describe("tbtc-v2#24 single main: no ordinary deposit sweep while the main is reserved (D13 refinement)", () => {
  let w: World
  let x: Wallet
  let targets: Wallet[]
  let root: string
  // Output index of x's current main (a redemption change is output 1).
  let mainIndex = 0

  const custody = async (wallet: Wallet = x) =>
    w.frost.frostWalletCustody(wallet.id)
  const reasonOf = (e: unknown) => {
    const error = e as { reason?: string; message?: string } | undefined
    return String(error?.reason ?? error?.message ?? e)
  }

  /// Named acceptance: a refused step fails here with its label and reason.
  /// `send` is a contract call or a world helper that sends its own calls.
  const accepts = async (label: string, send: () => Promise<unknown>) => {
    try {
      const sent = (await send()) as Partial<ContractTransaction> | undefined
      if (typeof sent?.wait === "function") await sent.wait()
    } catch (e) {
      expect.fail(`${label}: refused (${reasonOf(e)})`)
    }
  }

  /// The single-main invariant, checked after every accepted step.
  const singleMain = async (step: string, wallet: Wallet = x) => {
    const c = await custody(wallet)
    if (c.mainOutpoint === ZERO) {
      expect(
        c.value,
        `single main after ${step}: custody without a main`
      ).to.equal(0)
      return
    }
    const main = await w.frost.frostCustodyOutput(c.mainOutpoint)
    expect(main.spent, `single main after ${step}: main spent`).to.equal(false)
    expect(
      c.value,
      `single main after ${step}: recognized custody ${c.value} is not the main's ${main.value}`
    ).to.equal(main.value)
  }

  /// The whole frame a refused sweep must leave unchanged: custody record,
  /// every named output and deposit record (sweptAt), spent flags, Bank
  /// balances, the reservation and its requests, escrow, exposure counters
  /// and lifecycle state.
  const frame = async (keys: string[], reservation?: Reservation) => {
    const c = await custody()
    const actors = [w.depositor.address, w.treasury.address, w.frost.address]
    return JSON.stringify(
      await Promise.all([
        c,
        w.state(x),
        Promise.all(keys.map((k) => w.frost.frostCustodyOutput(k))),
        Promise.all(keys.map((k) => w.frost.frostDeposit(k))),
        Promise.all(keys.map((k) => w.bridge.spentMainUTXOs(k))),
        Promise.all(actors.map((a) => w.bank.balanceOf(a))),
        w.frost.frostReservation(c.activeReservation),
        reservation
          ? w.frost.frostRedemptionRequest(reservation.requestId)
          : null,
        w.frost.frostRedemptionEscrow(x.id),
        Promise.all(EXPOSURE.map((n) => w.exposure[n]())),
        w.frost.frostWalletLifecycle(x.id),
      ])
    )
  }

  const sweepRequest = (tx: Tx, includeMain: boolean) => ({
    walletId: x.id,
    transaction: tx.tx,
    proof: inclusion(tx.hash),
    includeMain,
    vault: ethers.constants.AddressZero,
  })

  /// An ordinary deposit sweep must be refused by the main guard, with the
  /// whole frame unchanged.
  const refusesSweep = async (
    label: string,
    tx: Tx,
    includeMain: boolean,
    keys: string[],
    reservation?: Reservation
  ) => {
    const before = await frame([...keys, tx.key()], reservation)
    let reason: string | undefined
    try {
      await (
        await w.frost.submitFrostDepositSweepProof(
          sweepRequest(tx, includeMain)
        )
      ).wait()
    } catch (e) {
      reason = reasonOf(e)
    }
    expect(
      reason,
      `${label}: an ordinary deposit sweep (includeMain=${includeMain}) was accepted while the main is reserved`
    ).to.not.equal(undefined)
    expect(
      reason,
      `${label}: refused, but not by the deposit sweep's main/reservation guard`
    ).to.match(MAIN_GUARD)
    expect(
      await frame([...keys, tx.key()], reservation),
      `${label}: the refused sweep changed the frame`
    ).to.equal(before)
  }

  const fund = async (wallet: Wallet, amount = FUNDED) => {
    // Boundary: a wallet with no main and no reservation takes a deposit-only
    // first sweep (movementWorld.fund sends includeMain=false).
    expect((await custody(wallet)).mainOutpoint).to.equal(ZERO)
    await accepts(
      "boundary: a no-main wallet's first deposit-only sweep is accepted",
      () => w.fund(wallet, amount)
    )
    await singleMain("the first deposit-only sweep", wallet)
  }

  const reveal = async (amount: number) => w.reveal(x, amount, LOCK_AHEAD)

  /// The current main as a sweep/movement input.
  const mainInput = (): [string, number] => [(x.main as Tx).hash, mainIndex]

  const signResolution = async (authorization: Authorization) => {
    const { chainId } = await ethers.provider.getNetwork()
    const digest = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", "uint256", "address", RESOLUTION_TYPE],
        [
          ethers.utils.id("tbtc-v2/frost-reservation-sweep-resolution/v1"),
          chainId,
          w.frost.address,
          authorization,
        ]
      )
    )
    // Seats 1 and 2 of movementWorld's descriptor: operator, owner.
    return ethers.utils.hexConcat(
      await Promise.all(
        [w.operator, w.owner].map((s) =>
          s.signMessage(ethers.utils.arrayify(digest))
        )
      )
    )
  }

  const hashOf = (tx: Tx["tx"]) => {
    const bytes = Buffer.concat(
      [tx.version, tx.inputVector, tx.outputVector, tx.locktime].map((v) =>
        Buffer.from(v.slice(2), "hex")
      )
    )
    const once = createHash("sha256").update(bytes).digest()
    return `0x${createHash("sha256").update(once).digest().toString("hex")}`
  }

  const reserveRedemption = async (): Promise<Reservation> => {
    const main = x.main as Tx
    await w.bank.connect(w.depositor).approveBalance(w.frost.address, REDEEMED)
    const caller = w.frost.connect(w.depositor)
    const requestId = await caller.callStatic.requestFrostRedemption(
      x.id,
      REDEEMER_SCRIPT,
      REDEEMED,
      w.depositor.address
    )
    await accepts("setup: redemption request", () =>
      caller.requestFrostRedemption(
        x.id,
        REDEEMER_SCRIPT,
        REDEEMED,
        w.depositor.address
      )
    )
    const c = await custody()
    const proposal = await reservationProposal({
      bridge: w.frost.address,
      chainId: (await ethers.provider.getNetwork()).chainId,
      walletId: x.id,
      descriptorHash: x.descriptorHash,
      genesis: GENESIS,
      outputKey: x.q,
      generation: c.generation.add(1),
      stateVersion: c.stateVersion,
      validUntilBlock: (await ethers.provider.getBlockNumber()) + 100,
      inputs: [
        { txHash: main.hash, txOutputIndex: mainIndex, txOutputValue: x.value },
      ],
      requests: [{ id: requestId, value: PAID, script: REDEEMER_SCRIPT }],
      fee: PAYMENT_FEE,
      operators: [w.operator, w.owner],
    })
    const reservationId = await w.frost.callStatic.reserveFrostRedemption(
      proposal
    )
    await accepts("setup: reservation", () =>
      w.frost.reserveFrostRedemption(proposal)
    )
    expect(
      (await custody()).activeReservation,
      "setup: the main is reserved"
    ).to.equal(reservationId)
    await singleMain("the reservation")
    return { requestId, reservationId, proposal }
  }

  before(async () => {
    w = await movementWorld(4)
    ;[x] = w.wallets
    targets = ascending(w.wallets.slice(1))
    // Redemption dust must exceed movementWorld's moving-funds dust (20,000).
    // dust, treasury divisor, tx max fee, tx max total fee, timeout (3,600 s),
    // slashing, notifier reward multiplier.
    await w.bridge.updateRedemptionParameters(
      25000,
      100,
      2000,
      2000,
      3600,
      0,
      0
    )
    await w.frost.configureFrostRedemptions(
      GENESIS,
      2,
      1000,
      ethers.constants.AddressZero,
      ethers.utils.id("UNQUALIFIED tbtc-v2#24 single-main tests")
    )
    await w.frost.setFrostRedemptionsEnabled(true)
    root = await network.provider.send("evm_snapshot")
  })

  beforeEach(async () => {
    expect(await network.provider.send("evm_revert", [root])).to.equal(true)
    root = await network.provider.send("evm_snapshot")
    // The wallet records are test-side state; evm_revert does not restore them.
    for (const wallet of w.wallets) {
      wallet.main = undefined
      wallet.value = 0
    }
    mainIndex = 0
  })

  it("accepts a deposit-only first sweep for a wallet with no main (boundary)", async () => {
    await fund(x)
    const c = await custody()
    expect(
      c.mainOutpoint,
      "boundary: the first sweep output is the main"
    ).to.eq((x.main as Tx).key())
    expect(c.value).to.equal(FUNDED - FUND_FEE)
    expect(c.activeReservation).to.equal(ZERO)
  })

  /// Puts the reservation into `state` through public entrypoints.
  const reach = async (state: number, r: Reservation) => {
    if (state === Intent.TimeoutPending) {
      const { deadline } = await w.frost.frostRedemptionRequest(r.requestId)
      await network.provider.send("evm_setNextBlockTimestamp", [
        deadline.toNumber() + 1,
      ])
      await accepts("setup: redemption timeout notice", () =>
        w.frost.notifyFrostRedemptionTimeout(r.requestId)
      )
    }
    expect(
      (await w.frost.frostReservation(r.reservationId)).state,
      "setup: reservation state"
    ).to.equal(state)
    expect(
      (await custody()).activeReservation,
      "setup: the main is still reserved"
    ).to.equal(r.reservationId)
    await singleMain(`reaching intent state ${state}`)
  }

  const reservedStates: [string, number][] = [
    ["Reserved", Intent.Reserved],
    ["TimeoutPending", Intent.TimeoutPending],
  ]
  reservedStates.forEach(([name, state]) => {
    it(`refuses every ordinary deposit sweep while the main's reservation is ${name}, frame unchanged`, async () => {
      await fund(x)
      const r = await reserveRedemption()
      const d1 = await reveal(50000)
      const d2 = await reveal(70000)
      await reach(state, r)
      const keys = [d1.key(), d2.key(), (x.main as Tx).key(mainInput()[1])]
      // Deposit-only, one and two deposits (the old C-05 side path).
      await refusesSweep(
        `${name}: deposit-only sweep of one deposit`,
        transaction(
          [[d1.hash, 0]],
          [{ value: 50000 - SWEEP_FEE, script: p2tr(x.q) }]
        ),
        false,
        keys,
        r
      )
      await refusesSweep(
        `${name}: deposit-only sweep of two deposits`,
        transaction(
          [
            [d1.hash, 0],
            [d2.hash, 0],
          ],
          [{ value: 120000 - SWEEP_FEE, script: p2tr(x.q) }]
        ),
        false,
        keys,
        r
      )
      // Ordinary sweep claiming the reserved main.
      await refusesSweep(
        `${name}: ordinary sweep of the deposits and the reserved main`,
        transaction(
          [[d1.hash, 0], mainInput(), [d2.hash, 0]],
          [{ value: x.value + 120000 - SWEEP_FEE, script: p2tr(x.q) }]
        ),
        true,
        keys,
        r
      )
      // The deposits wait: still revealed, unswept.
      for (const d of [d1, d2]) {
        const deposit = await w.deposit(d.key())
        expect(deposit.revealedAt, `${name}: deposit revealed`).to.be.gt(0)
        expect(deposit.sweptAt, `${name}: deposit waits unswept`).to.equal(0)
      }
      await singleMain(`${name}: refused sweeps`)
    })
  })

  it("still spends the reserved main through the C-04 sweep-resolution route (positive control)", async () => {
    await fund(x)
    const r = await reserveRedemption()
    const d = await reveal(50000)
    const before = await custody()
    const t = transaction(
      [[d.hash, 0], mainInput()],
      [{ value: x.value + 50000 - SWEEP_FEE, script: p2tr(x.q) }]
    )
    const authorization = {
      reservationId: r.reservationId,
      transactionHash: t.hash,
      vault: ethers.constants.AddressZero,
      validUntilBlock: (await ethers.provider.getBlockNumber()) + 100,
    }
    const resolution = {
      sweep: sweepRequest(t, true),
      authorization,
      seats: [1, 2],
      signatures: await signResolution(authorization),
    }
    const payer = await w.bank.balanceOf(w.depositor.address)
    await accepts(
      "C-04 sweep resolution: the approved resolution sweep of the reserved main",
      () => w.frost.submitFrostSweepResolutionProof(resolution)
    )
    await singleMain("the sweep resolution")
    const after = await custody()
    expect(after.mainOutpoint, "resolution: new main").to.equal(t.key())
    expect(after.activeReservation, "resolution: reservation cleared").to.equal(
      ZERO
    )
    expect(after.value, "resolution: custody").to.equal(
      before.value.sub(x.value).add(x.value + 50000 - SWEEP_FEE)
    )
    expect(
      (await w.frost.frostReservation(r.reservationId)).state,
      "resolution: intent state"
    ).to.equal(Intent.ConflictResolved)
    const deposit = await w.deposit(d.key())
    expect(deposit.sweptAt, "resolution: deposit swept").to.be.gt(0)
    expect(
      await w.bank.balanceOf(w.depositor.address),
      "resolution: deposit credited once"
    ).to.equal(
      payer.add(deposit.terms.amount.sub(deposit.treasuryFee).sub(SWEEP_FEE))
    )
  })

  it("#24 end to end: deposits wait out the reservation, one sweep with the new main credits each once, and a movement of the main alone closes the wallet", async () => {
    await fund(x)
    await singleMain("funding")
    const r = await reserveRedemption()
    const amounts = [50000, 70000]
    const waiting: Tx[] = []
    for (const amount of amounts) waiting.push(await reveal(amount))
    const waitingKeys = waiting.map((d) => d.key())
    const reservedMain = (x.main as Tx).key(mainInput()[1])

    // While reserved the deposits must wait.
    await refusesSweep(
      "e2e: deposit-only sweep while reserved",
      transaction(
        waiting.map((d) => [d.hash, 0] as [string, number]),
        [{ value: 120000 - SWEEP_FEE, script: p2tr(x.q) }]
      ),
      false,
      [...waitingKeys, reservedMain],
      r
    )
    await refusesSweep(
      "e2e: ordinary main sweep while reserved",
      transaction(
        [...waiting.map((d) => [d.hash, 0] as [string, number]), mainInput()],
        [{ value: x.value + 120000 - SWEEP_FEE, script: p2tr(x.q) }]
      ),
      true,
      [...waitingKeys, reservedMain],
      r
    )

    // Settlement by payment proof: the change (output 1) is the new main.
    await network.provider.send("hardhat_mine", [ethers.utils.hexValue(101)])
    const paymentHash = hashOf(r.proposal.transaction)
    await accepts("e2e: redemption payment proof", () =>
      w.frost.submitFrostRedemptionProof(
        r.reservationId,
        r.proposal.transaction,
        inclusion(paymentHash)
      )
    )
    await singleMain("the payment proof")
    const change = x.value - PAID - PAYMENT_FEE
    let c = await custody()
    expect(c.activeReservation, "e2e: reservation resolved").to.equal(ZERO)
    expect(c.mainOutpoint, "e2e: change is the main").to.equal(
      outpoint(paymentHash, 1)
    )
    expect(c.value, "e2e: custody is the change").to.equal(change)
    /* eslint-disable no-param-reassign */
    x.main = { hash: paymentHash, tx: r.proposal.transaction } as unknown as Tx
    mainIndex = 1
    x.value = change
    /* eslint-enable no-param-reassign */

    // Still no deposit-only sweep beside the (now unreserved) main.
    await refusesSweep(
      "e2e: deposit-only sweep beside the unreserved main",
      transaction(
        waiting.map((d) => [d.hash, 0] as [string, number]),
        [{ value: 120000 - SWEEP_FEE, script: p2tr(x.q) }]
      ),
      false,
      [...waitingKeys, outpoint(paymentHash, 1)]
    )

    // One ordinary sweep of the main and every waiting deposit.
    const payer = await w.bank.balanceOf(w.depositor.address)
    const treasury = await w.bank.balanceOf(w.treasury.address)
    const swept = transaction(
      [mainInput(), ...waiting.map((d) => [d.hash, 0] as [string, number])],
      [{ value: change + 120000 - SWEEP_FEE, script: p2tr(x.q) }]
    )
    await accepts("e2e: the ordinary sweep including the new main", () =>
      w.frost.submitFrostDepositSweepProof(sweepRequest(swept, true))
    )
    await singleMain("the consolidating deposit sweep")
    c = await custody()
    expect(c.mainOutpoint, "e2e: sweep output is the main").to.equal(
      swept.key()
    )
    expect(c.value, "e2e: custody after the sweep").to.equal(
      change + 120000 - SWEEP_FEE
    )
    // Each waiting deposit credited exactly once; the fee is shared.
    const shares = split(SWEEP_FEE, waiting.length)
    let credited = ethers.BigNumber.from(0)
    let treasuryFees = ethers.BigNumber.from(0)
    for (let i = 0; i < waiting.length; i++) {
      const deposit = await w.deposit(waitingKeys[i])
      expect(deposit.sweptAt, `e2e: deposit ${i} swept`).to.be.gt(0)
      credited = credited.add(
        deposit.terms.amount.sub(deposit.treasuryFee).sub(shares[i])
      )
      treasuryFees = treasuryFees.add(deposit.treasuryFee)
    }
    expect(
      await w.bank.balanceOf(w.depositor.address),
      "e2e: depositor credited once per deposit"
    ).to.equal(payer.add(credited))
    expect(
      await w.bank.balanceOf(w.treasury.address),
      "e2e: treasury credited once per deposit"
    ).to.equal(treasury.add(treasuryFees))
    // Replay credits nothing.
    const replayFrame = await frame([...waitingKeys, swept.key()])
    let replayed = true
    try {
      await (
        await w.frost.submitFrostDepositSweepProof(sweepRequest(swept, true))
      ).wait()
    } catch {
      replayed = false
    }
    expect(
      replayed,
      "e2e: the consolidating sweep was accepted twice"
    ).to.equal(false)
    expect(await frame([...waitingKeys, swept.key()])).to.equal(replayFrame)
    x.main = swept
    mainIndex = 0
    x.value = change + 120000 - SWEEP_FEE

    // C-09: an old funded wallet is closeable into MovingFunds.
    await network.provider.send("evm_increaseTime", [
      (await w.bridge.walletParameters()).walletMaxAge,
    ])
    await network.provider.send("evm_mine")
    await accepts("e2e: C-09 closeable notice", () =>
      w.frost.notifyFrostWalletCloseable(x.id)
    )
    expect(await w.state(x), "e2e: MovingFunds").to.equal(State.MovingFunds)
    await singleMain("entering MovingFunds")

    // C-06: commit, then one movement spending the main alone.
    await accepts("e2e: moving-funds commitment", () =>
      w.frost.connect(w.operator).submitFrostMovingFundsCommitment(
        x.id,
        0,
        targets.map((t) => t.label)
      )
    )
    await singleMain("the commitment")
    const values = split(x.value - MOVE_FEE, targets.length)
    const move = transaction(
      [mainInput()],
      targets.map((t, i) => ({ value: values[i], script: p2tr(t.q) }))
    )
    await accepts("e2e: movement of the main alone", () =>
      w.frost.submitFrostMovingFundsProof(x.id, move.tx, inclusion(move.hash))
    )
    await singleMain("the movement")
    expect(
      (await custody()).value,
      "e2e: custody left after movement"
    ).to.equal(0)
    expect(await w.state(x), "e2e: Closing").to.equal(State.Closing)
    let delivered = 0
    for (let i = 0; i < targets.length; i++) {
      const incoming = await w.frost.frostIncoming(move.key(i))
      expect(incoming.target, `e2e: target ${i}`).to.equal(targets[i].id)
      expect(incoming.value, `e2e: value ${i}`).to.equal(values[i])
      delivered += values[i]
    }
    expect(delivered, "e2e: every satoshi less the fee delivered").to.equal(
      FUNDED -
        FUND_FEE -
        PAID -
        PAYMENT_FEE +
        amounts.reduce((a, b) => a + b, 0) -
        SWEEP_FEE -
        MOVE_FEE
    )
  })
})
