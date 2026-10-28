/* eslint-disable no-await-in-loop, no-restricted-syntax, @typescript-eslint/no-loop-func */
// Remediation batch 1: C-06 drain path for non-main recognized custody.
// Refs tuxxy/tbtc-v2#24 (review r4314868891 on tuxxy/tbtc-v2#10).
//
// Invariant (KC-SF-V3 line 831, obligation reachability; SC-05): custody the
// Bridge recognizes for a FROST wallet stays movable. A wallet in MovingFunds
// whose recognized custody spans its main and other recognized outputs has a
// public path, through Bridge entrypoints and wallet-signed Bitcoin
// transactions, to Closing with zero custody and every recognized satoshi
// (less fees) delivered to committed eligible targets. No proof may close the
// wallet while recognized custody remains.
//
// How the state arises, all through public entrypoints: a deposit-only sweep
// lands while the main is reserved for a redemption (C-04/C-05 require it to
// exclude the reserved main), and settlement then replaces the main and keeps
// the swept output. C-09 moves the wallet to MovingFunds.
//
// The spec does not fix the mechanism and the review names two (consolidate,
// or move every recognized output). This test therefore accepts any of these
// paths through the existing entrypoints:
//   A. commit, then one movement spending the main and every other output;
//   B. consolidate with a deposit-sweep proof (main included), then A;
//   C. consolidate with a moved-funds sweep proof, then A.
// A fix through a new entrypoint needs an amendment (DECISIONS.md, pending
// question on tbtc-v2#24).
//
// Inclusion proofs are synthetic regtest blocks (movementWorld); the C-04
// reservation certificate is signed by the wallet's operators.
import { createHash } from "crypto"
import { ethers, network } from "hardhat"
import { expect } from "chai"
import {
  State,
  movementWorld,
  transaction,
  inclusion,
  p2tr,
  ascending,
  split,
  World,
  Wallet,
  Tx,
} from "../helpers/frost-movement-world"
import { reservationProposal } from "../helpers/frost-reservation-proposal"

const sha = (b: Buffer) => createHash("sha256").update(b).digest()
const GENESIS = ethers.utils.id("C06 synthetic regtest domain")
const REDEEMER_SCRIPT = `0x0014${"11".repeat(20)}`
const MOVE_FEE = 3000
// A 30,000 sat request: treasury fee 300, Bitcoin fee 1,000, paid 28,700.
const REDEEMED = 30000
const PAID = 28700
const SWEEP_FEE = 1000

type Recognized = { hash: string; index: number; value: number }

describe("C-06 non-main recognized custody (tuxxy/tbtc-v2#24)", () => {
  let w: World
  let x: Wallet
  let targets: Wallet[]
  let root: string
  let funded: { main: Wallet["main"]; value: number }

  const advance = async (seconds: number) => {
    await network.provider.send("evm_increaseTime", [seconds])
    await network.provider.send("evm_mine")
  }
  const custody = async () => w.frost.frostWalletCustody(x.id)

  /// Settles one reserved redemption of `amount` from the current main and
  /// lands `extras` deposit-only sweeps while the main is reserved. Returns
  /// every recognized output, main first.
  const splitCustody = async (extras: number[]): Promise<Recognized[]> => {
    const main = x.main as Tx
    await w.bank.connect(w.depositor).approveBalance(w.frost.address, REDEEMED)
    const caller = w.frost.connect(w.depositor)
    const id = await caller.callStatic.requestFrostRedemption(
      x.id,
      REDEEMER_SCRIPT,
      REDEEMED,
      w.depositor.address
    )
    await caller.requestFrostRedemption(
      x.id,
      REDEEMER_SCRIPT,
      REDEEMED,
      w.depositor.address
    )
    const before = await custody()
    const proposal = await reservationProposal({
      bridge: w.frost.address,
      chainId: (await ethers.provider.getNetwork()).chainId,
      walletId: x.id,
      descriptorHash: x.descriptorHash,
      genesis: GENESIS,
      outputKey: x.q,
      generation: before.generation.add(1),
      stateVersion: before.stateVersion,
      validUntilBlock: (await ethers.provider.getBlockNumber()) + 100,
      inputs: [{ txHash: main.hash, txOutputIndex: 0, txOutputValue: x.value }],
      requests: [{ id, value: PAID, script: REDEEMER_SCRIPT }],
      fee: 1000,
      operators: [w.operator, w.owner],
    })
    const reservationId = await w.frost.callStatic.reserveFrostRedemption(
      proposal
    )
    await w.frost.reserveFrostRedemption(proposal)

    // Deposit-only sweeps while the main is reserved (they must exclude it).
    const recognized: Recognized[] = []
    for (const amount of extras) {
      const funding = await w.reveal(x, amount, 365 * 86400)
      const sweep = transaction(
        [[funding.hash, 0]],
        [{ value: amount - SWEEP_FEE, script: p2tr(x.q) }]
      )
      await w.frost.submitFrostDepositSweepProof({
        walletId: x.id,
        transaction: sweep.tx,
        proof: inclusion(sweep.hash),
        includeMain: false,
        vault: ethers.constants.AddressZero,
      })
      recognized.push({ hash: sweep.hash, index: 0, value: amount - SWEEP_FEE })
    }

    // Settlement after the certificate expires: the change is the new main.
    await network.provider.send("hardhat_mine", [ethers.utils.hexValue(101)])
    const raw = Buffer.concat(
      [
        proposal.transaction.version,
        proposal.transaction.inputVector,
        proposal.transaction.outputVector,
        proposal.transaction.locktime,
      ].map((v: string) => Buffer.from(v.slice(2), "hex"))
    )
    const paymentHash = `0x${sha(sha(raw)).toString("hex")}`
    await w.frost.submitFrostRedemptionProof(
      reservationId,
      proposal.transaction,
      inclusion(paymentHash)
    )
    const after = await custody()
    const changeValue = x.value - PAID - 1000
    expect(
      (await w.frost.frostCustodyOutput(after.mainOutpoint)).value,
      "setup: the settlement change is the new main"
    ).to.equal(changeValue)
    /* eslint-disable no-param-reassign */
    x.main = { hash: paymentHash, tx: proposal.transaction } as unknown as Tx
    /* eslint-enable no-param-reassign */
    return [{ hash: paymentHash, index: 1, value: changeValue }, ...recognized]
  }

  /// C-09's public route: an old funded wallet is closeable into MovingFunds.
  const enterMovingFunds = async () => {
    await advance((await w.bridge.walletParameters()).walletMaxAge)
    await w.frost.notifyFrostWalletCloseable(x.id)
  }

  /// No accepted proof may leave the wallet Closing or Closed while the
  /// Bridge still recognizes custody for it.
  const assertNoClosureWithCustody = async (step: string) => {
    const state = await w.state(x)
    const { value } = await custody()
    if (state === State.Closing || state === State.Closed)
      expect(
        value,
        `${step}: the wallet closed with recognized custody left`
      ).to.equal(0)
  }

  const tryTx = async (label: string, send: () => Promise<any>) => {
    try {
      await (await send()).wait()
      return undefined
    } catch (e: any) {
      return `${label}: ${e.reason ?? e.message}`
    }
  }

  /// Path A from the current custody: commit, move every recognized output.
  const commitAndMoveAll = async (outputs: Recognized[]) => {
    const total = outputs.reduce((s, o) => s + o.value, 0)
    const committed = await tryTx("commit", () =>
      w.frost.connect(w.operator).submitFrostMovingFundsCommitment(
        x.id,
        0,
        targets.map((t) => t.label)
      )
    )
    if (committed) return { failure: committed }
    const values = split(total - MOVE_FEE, targets.length)
    const move = transaction(
      outputs.map((o) => [o.hash, o.index] as [string, number]),
      targets.map((t, i) => ({ value: values[i], script: p2tr(t.q) }))
    )
    const proved = await tryTx("movement proof", () =>
      w.frost.submitFrostMovingFundsProof(x.id, move.tx, inclusion(move.hash))
    )
    if (proved) return { failure: proved }
    return { move, values }
  }

  /// Consolidation into one output to the wallet's own key, then path A.
  const consolidateThenMove = async (
    label: string,
    outputs: Recognized[],
    submit: (sweep: Tx) => Promise<any>
  ) => {
    const total = outputs.reduce((s, o) => s + o.value, 0)
    const sweep = transaction(
      outputs.map((o) => [o.hash, o.index] as [string, number]),
      [{ value: total - SWEEP_FEE, script: p2tr(x.q) }]
    )
    const swept = await tryTx(label, () => submit(sweep))
    if (swept) return { failure: swept }
    await assertNoClosureWithCustody(label)
    return commitAndMoveAll([
      { hash: sweep.hash, index: 0, value: total - SWEEP_FEE },
    ])
  }

  const drains = async (outputs: Recognized[]) => {
    const failures: string[] = []
    const paths: [string, () => Promise<any>][] = [
      ["A: move every recognized output", () => commitAndMoveAll(outputs)],
      [
        "B: consolidate by deposit sweep",
        () =>
          consolidateThenMove("deposit-sweep consolidation", outputs, (s) =>
            w.frost.submitFrostDepositSweepProof({
              walletId: x.id,
              transaction: s.tx,
              proof: inclusion(s.hash),
              includeMain: true,
              vault: ethers.constants.AddressZero,
            })
          ),
      ],
      [
        "C: consolidate by moved-funds sweep",
        () =>
          consolidateThenMove("moved-funds-sweep consolidation", outputs, (s) =>
            w.frost.submitFrostMovedFundsSweepProof(
              x.id,
              s.tx,
              inclusion(s.hash)
            )
          ),
      ],
    ]
    for (const [name, path] of paths) {
      const snapshot = await network.provider.send("evm_snapshot")
      const result = await path()
      if (!result.failure) return { name, ...result }
      failures.push(`${name} -> ${result.failure}`)
      await assertNoClosureWithCustody(name)
      expect(await network.provider.send("evm_revert", [snapshot])).to.equal(
        true
      )
    }
    return { failures }
  }

  before(async () => {
    w = await movementWorld(4)
    ;[x] = w.wallets
    targets = ascending(w.wallets.slice(1))
    await w.bridge.updateRedemptionParameters(
      // Redemption dust must exceed movementWorld's moving-funds dust (20,000).
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
      ethers.utils.id("UNQUALIFIED remediation batch 1")
    )
    await w.frost.setFrostRedemptionsEnabled(true)
    await w.fund(x, 600000)
    funded = { main: x.main, value: x.value }
    root = await network.provider.send("evm_snapshot")
  })
  beforeEach(async () => {
    expect(await network.provider.send("evm_revert", [root])).to.equal(true)
    root = await network.provider.send("evm_snapshot")
    // The wallet record is test-side state; evm_revert does not restore it.
    x.main = funded.main
    x.value = funded.value
  })

  for (const extras of [[50000], [50000, 70000]]) {
    it(`drains main plus ${extras.length} non-main recognized output(s) to Closing with zero custody`, async () => {
      const outputs = await splitCustody(extras)
      const recognizedTotal = outputs.reduce((s, o) => s + o.value, 0)
      expect(
        (await custody()).value,
        "setup: custody spans the main and the deposit-only sweeps"
      ).to.equal(recognizedTotal)
      await enterMovingFunds()
      expect(await w.state(x), "setup: C-09 MovingFunds").to.equal(
        State.MovingFunds
      )

      const result: any = await drains(outputs)
      expect(
        result.failures,
        `C-06 non-main custody: no public path moves the wallet's recognized custody:\n  ${(
          result.failures ?? []
        ).join("\n  ")}`
      ).to.equal(undefined)

      // Closure with every recognized satoshi delivered to the targets.
      expect((await custody()).value, `${result.name}: custody left`).to.equal(
        0
      )
      expect(await w.state(x), `${result.name}: state`).to.equal(State.Closing)
      const move = result.move as Tx
      for (let i = 0; i < targets.length; i++) {
        const incoming = await w.frost.frostIncoming(move.key(i))
        expect(incoming.target, `${result.name}: target ${i}`).to.equal(
          targets[i].id
        )
        expect(incoming.value, `${result.name}: value ${i}`).to.equal(
          result.values[i]
        )
      }
    })
  }

  it("never closes the wallet on a movement that leaves a recognized output behind", async () => {
    const outputs = await splitCustody([50000])
    await enterMovingFunds()
    // Whatever the drain mechanism: a commitment, if accepted, followed by a
    // movement of the main alone must not reach Closing with custody left.
    await tryTx("commit", () =>
      w.frost.connect(w.operator).submitFrostMovingFundsCommitment(
        x.id,
        0,
        targets.map((t) => t.label)
      )
    )
    const main = outputs[0]
    const values = split(main.value - MOVE_FEE, targets.length)
    const partial = transaction(
      [[main.hash, main.index]],
      targets.map((t, i) => ({ value: values[i], script: p2tr(t.q) }))
    )
    await tryTx("partial movement proof", () =>
      w.frost.submitFrostMovingFundsProof(
        x.id,
        partial.tx,
        inclusion(partial.hash)
      )
    )
    await assertNoClosureWithCustody("partial movement")
  })
})
