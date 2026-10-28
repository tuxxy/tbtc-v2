/* eslint-disable no-await-in-loop */
// Remediation batch 1b: C-09 dust-sized custody a terminated wallet regains.
// Refs tuxxy/tbtc-v2#25 (fix review W-h on tuxxy/tbtc-v2#45).
//
// Invariant (KC-SF-V3 line 831, obligation reachability; C-09): custody a
// terminated wallet regains after its movement was proven never strands the
// wallet. When the regained value is below the moving-funds dust threshold it
// cannot be moved, so it must be recordable as dust (the period that held the
// proven movement is over) and the wallet must then close from its original
// termination. It stays Terminated until closure, with its original
// terminatedAt.
//
// Everything runs through public entrypoints, as in
// Frost.Lifecycle.TerminatedRegain.test.ts. Inclusion proofs are synthetic
// regtest blocks (movementWorld).
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

describe("C-09 terminated wallet regains dust-sized custody (tuxxy/tbtc-v2#25)", () => {
  let w: World
  let closingPeriod: number
  let dustThreshold: number

  const advance = async (seconds: number) => {
    await network.provider.send("evm_increaseTime", [seconds])
    await network.provider.send("evm_mine")
  }
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
  const outcome = async (tx: Promise<any>) => {
    try {
      await (await tx).wait()
      return undefined
    } catch (e: any) {
      return (e.reason ?? e.message) as string
    }
  }

  before(async () => {
    w = await movementWorld(4)
    closingPeriod = (await w.bridge.walletParameters()).walletClosingPeriod
    dustThreshold = (await w.bridge.movingFundsParameters())
      .movingFundsDustThreshold
    await w.fund(w.wallets[0], 600000)
  })

  it("records a dust-sized regain after a proven movement as dust and closes the terminated wallet", async () => {
    const [x, ...rest] = w.wallets
    const targets = ascending(rest)
    // Revealed while Live, swept only after the movement was proven.
    const regained = 14000
    expect(regained, "setup: the regain is below the dust threshold").to.be.lt(
      dustThreshold
    )
    const late = await w.reveal(x, regained + 1000, 365 * 86400)

    // Terminated publicly: a fraud challenge it cannot defeat in time.
    const digest = ethers.utils.id("tbtc-v2#25 dust regain undefendable digest")
    await w.frost.submitFrostFraudChallenge(
      x.id,
      digest,
      await sign(x, digest),
      { value: BOND }
    )
    await advance(7 * 86400)
    await w.frost.notifyFrostFraudChallengeDefeatTimeout(x.id, digest)
    expect(await w.state(x), "setup: terminated").to.equal(State.Terminated)
    const { terminatedAt } = await w.frost.frostWalletLifecycle(x.id)
    const sanctionKept = async (step: string) => {
      expect(
        await w.state(x),
        `terminated wallet: left Terminated ${step}`
      ).to.equal(State.Terminated)
      expect(
        (await w.frost.frostWalletLifecycle(x.id)).terminatedAt,
        `terminated wallet: the original terminatedAt changed ${step}`
      ).to.equal(terminatedAt)
    }

    // The movement is proven; nothing is left.
    await w.frost.connect(w.operator).submitFrostMovingFundsCommitment(
      x.id,
      0,
      targets.map((t) => t.label)
    )
    const values = split(x.value - 3000, targets.length)
    const movement = transaction(
      [[(x.main as Tx).hash, 0]],
      targets.map((t, i) => ({ value: values[i], script: p2tr(t.q) }))
    )
    await w.frost.submitFrostMovingFundsProof(
      x.id,
      movement.tx,
      inclusion(movement.hash)
    )
    expect((await w.frost.frostWalletCustody(x.id)).value).to.equal(0)
    await sanctionKept("after the movement proof")

    // The late sweep credits dust-sized custody.
    const sweep = transaction(
      [[late.hash, 0]],
      [{ value: regained, script: p2tr(x.q) }]
    )
    await w.frost.submitFrostDepositSweepProof({
      walletId: x.id,
      transaction: sweep.tx,
      proof: inclusion(sweep.hash),
      includeMain: false,
      vault: ethers.constants.AddressZero,
    })
    // Recording dust retains it: no Bitcoin spend was proven, so the
    // regained value, its outpoint and that output's record must survive the
    // dust notification and closure unchanged.
    const retained = async (step: string) => {
      const custody = await w.frost.frostWalletCustody(x.id)
      expect(
        custody.value,
        `terminated wallet: the retained dust custody value changed ${step}`
      ).to.equal(regained)
      expect(
        custody.mainOutpoint,
        `terminated wallet: the retained dust outpoint changed ${step}`
      ).to.equal(sweep.key(0))
      const output = await w.frost.frostCustodyOutput(sweep.key(0))
      expect(
        [output.walletId, output.value.toNumber(), output.spent],
        `terminated wallet: the retained dust output record changed ${step}`
      ).to.deep.equal([x.id, regained, false])
    }
    await retained("after the late sweep")
    await sanctionKept("after the late sweep")

    // Below dust it cannot be moved, so it must be recordable as dust.
    expect(
      await outcome(w.frost.notifyFrostMovingFundsBelowDust(x.id)),
      "terminated wallet: the dust-sized custody regained after its proven movement cannot be recorded as dust"
    ).to.equal(undefined)
    expect(
      (await w.frost.frostWalletLifecycle(x.id)).dust,
      "terminated wallet: the regained custody was not recorded as dust"
    ).to.equal(true)
    await retained("after the dust notification")
    await sanctionKept("after the dust notification")

    // Closure runs from the original termination.
    const deadline = terminatedAt.toNumber() + closingPeriod
    if ((await w.now()) < deadline) {
      await network.provider.send("evm_setNextBlockTimestamp", [deadline])
      await expect(
        w.frost.finalizeFrostWalletClosing(x.id),
        "terminated wallet: closed before its original termination deadline"
      ).to.be.revertedWith("FROST closing period")
    }
    expect(
      await outcome(w.frost.finalizeFrostWalletClosing(x.id)),
      "terminated wallet: the wallet holding recorded dust cannot close at its original termination deadline"
    ).to.equal(undefined)
    expect(await w.state(x)).to.equal(State.Closed)
    expect(
      (await w.frost.frostWalletLifecycle(x.id)).terminatedAt,
      "terminated wallet: the original terminatedAt changed through final closure"
    ).to.equal(terminatedAt)
    await retained("through final closure")
  })
})
