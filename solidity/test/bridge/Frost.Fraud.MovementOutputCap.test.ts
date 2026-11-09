/* eslint-disable no-await-in-loop, no-restricted-syntax */
// Refs tuxxy/tbtc-v2#26 (review r4314869216).
// Refs tuxxy/keep-core#92 (128-output defense gas; DEFERRALS.md, batch 5).
//
// Invariant (KC-SF-V3 SC-07, C-08): every FROST movement the Bridge accepts
// has a usable fraud defense. If a commitment with N targets and its movement
// proof are accepted, a challenge on the movement's real BIP341 digest is
// defeated both before the proof (AUTH_MOVEMENT, unmined) and after it
// (AUTH_PROVEN), each within the 2^24 transaction gas cap. A wallet that must
// move cannot be stranded by the fix: some commitment through the existing
// entrypoint is accepted and proven (KC-SF-V3 line 446).
//
// The mechanism is not fixed by the issue: a fix may raise the defense bound
// or bound movement admission. The test therefore commits the largest target
// count the Bridge accepts, from the count it requires now (ceil(custody /
// walletMaxBtcTransfer)) downwards, and checks the defense of whatever it
// accepted. A variant of the accepted movement (two outputs swapped) must
// stay refused and actionable.
//
// keep-core#92 (KC-SF-V3 line 466, "acceptable worst-case gas"; C08-BOUNDARIES
// "a 128-output shape is not measured"): at the output cap a fix chooses, the
// worst-case defense must fit the 16,777,216 transaction gas cap. There are
// two worst cases, each found by search and each defense measured with the
// block gas limit:
//   - AUTH_MOVEMENT: the commitment with the most targets the Bridge admits.
//     Its movement is signed and needs a defense whether or not its proof
//     would fit the gas cap, so no proof is required first.
//   - AUTH_PROVEN: the movement with the most outputs the Bridge both
//     commits and proves (proven transactions with more outputs cannot
//     exist).
// A fix may bound admission instead of raising the defense bound; the test
// sets no minimum admission bound (a bound of one target passes).
//
// Real: the Bridge, its FROST libraries, BIP340 signatures under each
// wallet's Q, and btcd's BIP341 digest (frost-tapscript-digest.go).
// FIXTURE: movementWorld (FrostRegistryFixture wallets, the controlled C-09
// MovingFunds stand-in) and synthetic regtest inclusion proofs, as in
// Frost.Fraud.test.ts.
import { ethers, network } from "hardhat"
import { expect } from "chai"
import { execFileSync } from "child_process"
import * as secp from "@noble/secp256k1"
import digestBinaryForRun from "../helpers/frost-digest-builder"
import {
  ZERO,
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
const AUTH = { proven: 1, movement: 3 }
const GAS_CAP = 16777216 // 2^24, the per-transaction cap the suite measures against
const FEE = 3000
const secretOf = (i: number) =>
  ethers.utils.hexZeroPad(ethers.utils.hexlify(1000 + i), 32).slice(2)
const reason = (error: any) =>
  String(error?.reason ?? error?.error?.message ?? error?.message ?? error)

describe("C-08 fraud defense covers every accepted movement (tbtc-v2#26)", () => {
  // 128: the defense bound (guard, passes now). 129: the first count it
  // refuses. 131: the largest count whose commitment and movement proof both
  // succeed with a 2^24 gas limit at the integration head 2377d060 (the
  // proof fails from 132 targets; commitments succeed up to 218, which the
  // admitted-maximum case covers).
  const COUNTS = [128, 129, 131]
  // The worst-case search covers every count a one-byte output count encodes.
  const TARGETS = 252
  const BLOCK_GAS = 30000000
  let w: World
  let binary: string
  let source: Wallet
  let pool: Wallet[]
  let challenger: any
  let snapshot: string

  const sign = async (wallet: Wallet, digest: string) =>
    `0x${Buffer.from(
      await secp.schnorr.sign(
        raw(digest),
        secretOf(w.wallets.indexOf(wallet)),
        new Uint8Array(32)
      )
    ).toString("hex")}`
  const btcd = (tx: Tx, prevouts: { value: number; script: string }[]) => {
    const rawTx = [
      tx.tx.version,
      tx.tx.inputVector,
      tx.tx.outputVector,
      tx.tx.locktime,
    ]
      .map((x) => x.slice(2))
      .join("")
    const result = JSON.parse(
      execFileSync(binary, [], {
        input: JSON.stringify({
          rawTransaction: rawTx,
          inputIndex: 0,
          prevouts: prevouts.map((p) => ({
            value: p.value,
            script: p.script.slice(2),
          })),
          leaf: "",
        }),
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
      }).toString()
    )
    return `0x${result.digest}`
  }
  const challenge = async (digest: string) =>
    w.frost
      .connect(challenger)
      .submitFrostFraudChallenge(
        source.id,
        digest,
        await sign(source, digest),
        {
          value: BOND,
        }
      )
  const defense = (tx: Tx, authorization: number, period: number) => ({
    walletId: source.id,
    transaction: tx.tx,
    prevouts: [{ value: source.value, script: `0x5120${source.q.slice(2)}` }],
    inputIndex: 0,
    leafHash: ZERO,
    authorization,
    authorizationRef:
      authorization === AUTH.movement
        ? ethers.utils.hexZeroPad(ethers.utils.hexlify(period), 32)
        : ZERO,
  })
  const resolved = async (digest: string) =>
    (await w.frost.frostFraudChallenge(source.id, digest)).resolved

  /// Governance sets walletMaxBtcTransfer so that the source needs exactly
  /// `n` targets under the rule in force now: ceil(custody / max) == n.
  const requireTargets = async (n: number) => {
    const max = Math.ceil(source.value / n)
    expect(Math.ceil(source.value / max)).to.equal(n)
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

  /// The largest accepted commitment, from `n` targets downwards; every
  /// attempt is a real public call under the gas cap.
  const commitLargestAccepted = async (n: number) => {
    const refusals: string[] = []
    for (let k = n; k >= 1; k--) {
      const targets = ascending(pool).slice(0, k)
      try {
        await (
          await w.frost.connect(w.operator).submitFrostMovingFundsCommitment(
            source.id,
            0,
            targets.map((t) => t.label),
            { gasLimit: GAS_CAP }
          )
        ).wait()
        return targets
      } catch (error) {
        if (refusals.length < 3) refusals.push(`${k}: ${reason(error)}`)
      }
    }
    expect.fail(
      `C-08 output cap: a wallet that needs ${n} targets has no accepted movement commitment (${refusals.join(
        "; "
      )})`
    )
    return []
  }

  /// Defend `digest` and require the challenge to be resolved.
  const defend = async (
    tx: Tx & { outputs: number },
    digest: string,
    authorization: number,
    period: number,
    label: string
  ) => {
    let gasUsed = 0
    try {
      const receipt = await (
        await w.frost.defeatFrostFraudChallenge(
          defense(tx, authorization, period),
          { gasLimit: GAS_CAP }
        )
      ).wait()
      gasUsed = receipt.gasUsed.toNumber()
    } catch (error) {
      expect.fail(
        `C-08 output cap: the accepted ${
          tx.outputs
        }-target movement has no usable ${label} defense: ${reason(error)}`
      )
    }
    expect(
      await resolved(digest),
      `C-08 output cap: the ${label} defense left the challenge unresolved`
    ).to.equal(true)
    return gasUsed
  }

  before(async function setup() {
    this.timeout(900000)
    binary = digestBinaryForRun(process.env.FROST_C05_DIGEST_BINARY)
    w = await movementWorld(TARGETS + 1)
    ;[, , , , , challenger] = w.signers
    ;[source] = w.wallets
    pool = w.wallets.slice(1)
    await w.fund(source, 600000)
    await w.enterMovingFunds(source)
    snapshot = await network.provider.send("evm_snapshot")
  })
  beforeEach(async () => {
    expect(await network.provider.send("evm_revert", [snapshot])).to.equal(true)
    snapshot = await network.provider.send("evm_snapshot")
  })

  /// Commit the largest accepted movement for a wallet that needs `n`
  /// targets, check the variant stays actionable, and defend the movement
  /// unmined and proven under the gas cap. With `measure`, each defense is
  /// first run in a snapshot with the block gas limit and its gas reported.
  const movementCase = async (n: number, measure = false) => {
    await requireTargets(n)
    const targets = await commitLargestAccepted(n)
    const k = targets.length
    const { period } = await w.frost.frostWalletLifecycle(source.id)
    const values = split(source.value - FEE, k)
    const tx = Object.assign(
      transaction(
        [[(source.main as Tx).hash, 0]],
        targets.map((t, i) => ({ value: values[i], script: p2tr(t.q) }))
      ),
      { outputs: k }
    )
    const prevouts = [
      { value: source.value, script: `0x5120${source.q.slice(2)}` },
    ]
    const digest = btcd(tx, prevouts)

    // Negative: a variant with two outputs swapped is not the committed
    // movement; its challenge must stay actionable.
    if (k > 1) {
      const swapped = [targets[1], targets[0], ...targets.slice(2)]
      const variant = transaction(
        [[(source.main as Tx).hash, 0]],
        swapped.map((t, i) => ({ value: values[i], script: p2tr(t.q) }))
      )
      const variantDigest = btcd(variant, prevouts)
      await challenge(variantDigest)
      let defended = true
      try {
        await (
          await w.frost.defeatFrostFraudChallenge(
            {
              ...defense(tx, AUTH.movement, period),
              transaction: variant.tx,
            },
            { gasLimit: GAS_CAP }
          )
        ).wait()
      } catch (error) {
        defended = false
      }
      expect(
        defended,
        "C-08 output cap: a variant of the committed movement was defended"
      ).to.equal(false)
      expect(
        await resolved(variantDigest),
        "C-08 output cap: a variant of the committed movement was defended"
      ).to.equal(false)
    }

    // Unmined: the committed movement's own signature.
    const unmined = await network.provider.send("evm_snapshot")
    await challenge(digest)
    const unminedMeasured = measure
      ? await measureDefense(tx, AUTH.movement, period, "unmined")
      : 0
    const movementGas = await defend(
      tx,
      digest,
      AUTH.movement,
      period,
      "unmined (AUTH_MOVEMENT)"
    )
    expect(await network.provider.send("evm_revert", [unmined])).to.equal(true)

    // Proven: the Bridge accepts the movement proof, then the same digest.
    try {
      await (
        await w.frost.submitFrostMovingFundsProof(
          source.id,
          tx.tx,
          inclusion(tx.hash),
          { gasLimit: GAS_CAP }
        )
      ).wait()
    } catch (error) {
      expect.fail(
        `C-08 output cap: the accepted ${k}-target commitment cannot be proven: ${reason(
          error
        )}`
      )
    }
    expect(await w.frost.frostProvenTransaction(tx.hash)).to.equal(source.id)
    await challenge(digest)
    const provenMeasured = measure
      ? await measureDefense(tx, AUTH.proven, period, "proven")
      : 0
    const provenGas = await defend(
      tx,
      digest,
      AUTH.proven,
      period,
      "proven (AUTH_PROVEN)"
    )
    return { k, movementGas, provenGas, unminedMeasured, provenMeasured }
  }

  /// keep-core#92: the defense's gas with the block gas limit, rolled back.
  const measureDefense = async (
    tx: Tx & { outputs: number },
    authorization: number,
    period: number,
    label: string
  ) => {
    const s = await network.provider.send("evm_snapshot")
    let gas = 0
    try {
      gas = (
        await (
          await w.frost.defeatFrostFraudChallenge(
            defense(tx, authorization, period),
            { gasLimit: BLOCK_GAS }
          )
        ).wait()
      ).gasUsed.toNumber()
    } catch (error) {
      expect.fail(
        `keep-core#92: the worst-case ${label} defense at the ${
          tx.outputs
        }-output cap could not be measured: ${reason(error)}`
      )
    }
    expect(await network.provider.send("evm_revert", [s])).to.equal(true)
    expect(
      gas,
      `keep-core#92: the worst-case ${label} defense at the ${tx.outputs}-output cap uses ${gas} gas, not below the 16,777,216 transaction cap`
    ).to.be.lessThan(GAS_CAP)
    return gas
  }

  /// A wallet that needs exactly `k` targets commits them under the gas cap,
  /// and, with `prove`, the Bridge accepts the movement proof under the cap.
  /// Rolled back.
  const accepts = async (k: number, prove: boolean) => {
    const s = await network.provider.send("evm_snapshot")
    let ok = false
    try {
      await requireTargets(k)
      const targets = ascending(pool).slice(0, k)
      await (
        await w.frost.connect(w.operator).submitFrostMovingFundsCommitment(
          source.id,
          0,
          targets.map((t) => t.label),
          { gasLimit: GAS_CAP }
        )
      ).wait()
      if (prove) {
        const values = split(source.value - FEE, k)
        const tx = transaction(
          [[(source.main as Tx).hash, 0]],
          targets.map((t, i) => ({ value: values[i], script: p2tr(t.q) }))
        )
        await (
          await w.frost.submitFrostMovingFundsProof(
            source.id,
            tx.tx,
            inclusion(tx.hash),
            { gasLimit: GAS_CAP }
          )
        ).wait()
      }
      ok = true
    } catch (error) {
      ok = false
    }
    expect(await network.provider.send("evm_revert", [s])).to.equal(true)
    return ok
  }

  /// Largest k in [1, TARGETS] that `accepts` (monotone: more targets cost
  /// more gas and need more wallets).
  const largest = async (prove: boolean) => {
    expect(
      await accepts(1, prove),
      "fixture: a one-target movement is not accepted"
    ).to.equal(true)
    let lo = 1
    let hi = TARGETS + 1
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      if (await accepts(mid, prove)) lo = mid
      else hi = mid
    }
    return lo
  }

  COUNTS.forEach((n) => {
    it(`defends an accepted movement that needs ${n} targets, unmined and proven, under 2^24 gas`, async function run() {
      this.timeout(600000)
      const r = await movementCase(n)
      // eslint-disable-next-line no-console
      console.log(
        `      needs ${n}, committed ${r.k} targets; defense gas: unmined ${r.movementGas}, proven ${r.provenGas}`
      )
    })
  })

  it("defends the largest admitted commitment unmined, below 2^24 gas, without its proof (keep-core#92)", async function admitted() {
    this.timeout(900000)
    const k = await largest(false)
    await requireTargets(k)
    const targets = await commitLargestAccepted(k)
    expect(
      targets.length,
      "the admission search and the commitment disagree"
    ).to.equal(k)
    const { period } = await w.frost.frostWalletLifecycle(source.id)
    const values = split(source.value - FEE, k)
    const tx = Object.assign(
      transaction(
        [[(source.main as Tx).hash, 0]],
        targets.map((t, i) => ({ value: values[i], script: p2tr(t.q) }))
      ),
      { outputs: k }
    )
    const digest = btcd(tx, [
      { value: source.value, script: `0x5120${source.q.slice(2)}` },
    ])
    await challenge(digest)
    const measured = await measureDefense(tx, AUTH.movement, period, "unmined")
    const gas = await defend(
      tx,
      digest,
      AUTH.movement,
      period,
      "unmined (AUTH_MOVEMENT)"
    )
    // eslint-disable-next-line no-console
    console.log(
      `      largest admitted commitment: ${k} targets; unmined defense gas ${measured} (under the cap: ${gas})`
    )
  })

  it("keeps the worst-case defense gas at the largest provable movement below 2^24 (keep-core#92)", async function worst() {
    this.timeout(900000)
    const lo = await largest(true)
    const r = await movementCase(lo, true)
    expect(r.k, "the worst-case search and the case disagree").to.equal(lo)
    // eslint-disable-next-line no-console
    console.log(
      `      largest accepted and provable movement: ${lo} targets; worst-case defense gas: unmined ${r.unminedMeasured}, proven ${r.provenMeasured}`
    )
  })
})
