/* eslint-disable no-await-in-loop, no-restricted-syntax, @typescript-eslint/no-loop-func */
// Remediation batch 1: C-09 movement period when terminated wallets regain
// funds. Refs tuxxy/tbtc-v2#25 (review r4314869533 on tuxxy/tbtc-v2#12).
//
// Invariant (KC-SF-V3 line 831, obligation reachability; C-09): custody a
// terminated wallet regains after its movement completed is movable. The
// wallet starts a fresh movement period, can commit and prove a movement of
// the regained custody, and can then close. It stays Terminated throughout
// (its sanction state survives, including the original terminatedAt, which
// also anchors its closure deadline). Both sides of closure are covered: custody
// regained before final closure (the reported case) and after it.
//
// Everything runs through public entrypoints: termination by a defeated
// fraud challenge, movement, a late sweep of a deposit revealed while the
// wallet was Live. Inclusion proofs are synthetic regtest blocks
// (movementWorld).
import { ethers, network } from "hardhat"
import { expect } from "chai"
import * as secp from "@noble/secp256k1"
import {
  State,
  movementWorld,
  transaction,
  inclusion,
  p2tr,
  raw,
  ascending,
  split,
  World,
  Wallet,
  Tx,
} from "../helpers/frost-movement-world"

const BOND = ethers.utils.parseEther("5")
const reason = (text: string) => ethers.utils.id(text)

describe("C-09 terminated wallet regains custody (tuxxy/tbtc-v2#25)", () => {
  let w: World
  let closingPeriod: number
  let root: string
  let funded: { main: Wallet["main"]; value: number }

  const advance = async (seconds: number) => {
    await network.provider.send("evm_increaseTime", [seconds])
    await network.provider.send("evm_mine")
  }
  const open = async (x: Wallet) =>
    (await w.frost.frostClosureObligations(x.id)).toNumber()
  const sign = async (x: Wallet, digest: string) =>
    `0x${Buffer.from(
      await secp.schnorr.sign(
        raw(digest),
        ethers.utils
          .hexZeroPad(ethers.utils.hexlify(1000 + w.wallets.indexOf(x)), 32)
          .slice(2),
        new Uint8Array(32)
      )
    ).toString("hex")}`
  /// Terminates x publicly: a fraud challenge it cannot defeat in time.
  const terminate = async (x: Wallet) => {
    const digest = reason("tbtc-v2#25 undefendable digest")
    await w.frost.submitFrostFraudChallenge(
      x.id,
      digest,
      await sign(x, digest),
      { value: BOND }
    )
    await advance(7 * 86400)
    await w.frost.notifyFrostFraudChallengeDefeatTimeout(x.id, digest)
    expect(await w.state(x), "setup: terminated").to.equal(State.Terminated)
  }
  const commit = (x: Wallet, targets: Wallet[]) =>
    w.frost.connect(w.operator).submitFrostMovingFundsCommitment(
      x.id,
      0,
      targets.map((t) => t.label)
    )
  const move = async (
    x: Wallet,
    input: [string, number],
    value: number,
    targets: Wallet[]
  ) => {
    const values = split(value - 3000, targets.length)
    const tx = transaction(
      [input],
      targets.map((t, i) => ({ value: values[i], script: p2tr(t.q) }))
    )
    return w.frost.submitFrostMovingFundsProof(x.id, tx.tx, inclusion(tx.hash))
  }
  const lateSweep = (x: Wallet, funding: Tx) => {
    const sweep = transaction(
      [[funding.hash, 0]],
      [{ value: 49000, script: p2tr(x.q) }]
    )
    return {
      sweep,
      send: () =>
        w.frost.submitFrostDepositSweepProof({
          walletId: x.id,
          transaction: sweep.tx,
          proof: inclusion(sweep.hash),
          includeMain: false,
          vault: ethers.constants.AddressZero,
        }),
    }
  }

  before(async () => {
    w = await movementWorld(4)
    closingPeriod = (await w.bridge.walletParameters()).walletClosingPeriod
    await w.fund(w.wallets[0], 600000)
    funded = { main: w.wallets[0].main, value: w.wallets[0].value }
    root = await network.provider.send("evm_snapshot")
  })
  beforeEach(async () => {
    expect(await network.provider.send("evm_revert", [root])).to.equal(true)
    root = await network.provider.send("evm_snapshot")
    // The wallet record is test-side state; evm_revert does not restore it.
    w.wallets[0].main = funded.main
    w.wallets[0].value = funded.value
  })

  for (const regained of ["before final closure", "after final closure"]) {
    it(`moves custody a terminated wallet regains ${regained}, keeps it Terminated, and closes`, async () => {
      const [x, ...rest] = w.wallets
      const targets = ascending(rest)
      // Revealed while Live, swept only after the movement completed.
      const late = await w.reveal(x, 50000, 365 * 86400)
      await terminate(x)
      const { terminatedAt } = await w.frost.frostWalletLifecycle(x.id)
      // The sanction (state and its original timestamp) survives every step.
      const sanctionKept = async (step: string) =>
        expect(
          (await w.frost.frostWalletLifecycle(x.id)).terminatedAt,
          `terminated wallet: the original terminatedAt changed ${step}`
        ).to.equal(terminatedAt)

      // The first movement completes; the wallet stays Terminated.
      await commit(x, targets)
      await move(x, [(x.main as Tx).hash, 0], x.value, targets)
      expect(await w.state(x), "setup: terminated after movement").to.equal(
        State.Terminated
      )
      expect((await w.frost.frostWalletCustody(x.id)).value).to.equal(0)
      // Negative: with nothing to move, no second commitment is accepted.
      await expect(commit(x, targets.slice(0, 1))).to.be.reverted
      if (regained === "after final closure") {
        await advance(closingPeriod + 1)
        await w.frost.finalizeFrostWalletClosing(x.id)
        expect(await w.state(x), "setup: closed").to.equal(State.Closed)
      }
      const { period } = await w.frost.frostWalletLifecycle(x.id)

      // The late sweep credits custody to the terminated wallet.
      const { sweep, send } = lateSweep(x, late)
      await send()
      expect((await w.frost.frostWalletCustody(x.id)).value).to.equal(49000)
      expect(
        await w.state(x),
        "terminated wallet: regaining custody cleared its terminated status"
      ).to.equal(State.Terminated)
      await sanctionKept("after the late sweep")

      // The regained custody is committable in a fresh period and movable.
      const [target] = targets
      let committed: string | undefined
      try {
        await (await commit(x, [target])).wait()
      } catch (e: any) {
        committed = e.reason ?? e.message
      }
      expect(
        committed,
        "terminated wallet: the custody regained after its completed movement cannot be committed"
      ).to.equal(undefined)
      const lifecycle = await w.frost.frostWalletLifecycle(x.id)
      expect(
        lifecycle.period,
        "terminated wallet: no fresh movement period for the regained custody"
      ).to.equal(period + 1)
      const commitment = await w.commitment(x, lifecycle.period)
      expect(commitment.mainOutpoint).to.equal(sweep.key(0))
      expect(commitment.targets).to.deep.equal([target.label])
      await sanctionKept("after the fresh commitment")

      await move(x, [sweep.hash, 0], 49000, [target])
      expect((await w.frost.frostWalletCustody(x.id)).value).to.equal(0)
      expect(await w.state(x)).to.equal(State.Terminated)
      expect(await open(x)).to.equal(0)
      await sanctionKept("after the movement proof")

      // Closure runs from the original termination: a terminated wallet's
      // closing period starts at terminatedAt, and nothing else is open.
      const deadline = terminatedAt.toNumber() + closingPeriod
      if ((await w.now()) < deadline) {
        await network.provider.send("evm_setNextBlockTimestamp", [deadline])
        await expect(
          w.frost.finalizeFrostWalletClosing(x.id),
          "terminated wallet: closed before its original termination deadline"
        ).to.be.revertedWith("FROST closing period")
      }
      let closed: string | undefined
      try {
        await (await w.frost.finalizeFrostWalletClosing(x.id)).wait()
      } catch (e: any) {
        closed = e.reason ?? e.message
      }
      expect(
        closed,
        "terminated wallet: closure is not available at its original termination deadline"
      ).to.equal(undefined)
      expect(await w.state(x)).to.equal(State.Closed)
      await sanctionKept("through final closure")
    })
  }
})
