/* eslint-disable no-await-in-loop, no-restricted-syntax, no-bitwise */
// Mutation batch M9 (tbtc-v2 lifecycle fraud), 2026-11-10 campaign,
// MUTATION-REPORT sections 3 and 4: the C-08 fraud guards and four C-09
// lifecycle guards had no unit judge that failed when they changed. Every
// case names the guard it holds; each guard has a case that fails at its
// own assertion when the guard is removed or its operator is changed.
//
// Invariants (KC-SF-V3 C-08 and C-09; FrostFraud, FrostLifecycle):
// - A challenge is admitted once per digest, only for a known wallet ID in
//   a challengeable state, with the full bond and a valid BIP340 signature
//   under the wallet key Q.
// - A challenge is defeated or timed out once; the timeout is inclusive at
//   reportedAt + fraudChallengeDefeatTimeout and never earlier.
// - A transaction defense resolves a challenge only for a well-formed
//   version 2 transaction with empty scriptSigs, matching prevouts, a
//   challenged input that is a key path of Q (or this wallet's deposit
//   leaf), prevout values at most 2.1e15 and scripts shorter than 253 bytes,
//   and an authorization that holds: a proven transaction, an admitted
//   intent's transaction, the exact committed movement (one input, the
//   committed main; outputs to the committed targets in an equal split; fee
//   within the committed cap, both inclusive), or a self-transfer (every
//   input Q's key path or this wallet's deposit; one output paying exactly
//   Q; fee within the recorded caps, inclusive).
// - Lifecycle: a wallet is closeable by age exactly at readyAt +
//   walletMaxAge, by balance only strictly below walletClosureMinBtcBalance,
//   and only under its own full ID; inactivity signers are strictly
//   ascending.
//
// Real: the Bridge proxy and its FROST libraries, the FrostVerifier
// (BIP340), the Bank, reveals, deposit sweeps, movement commitments and
// proofs through public entrypoints. Signatures are BIP340 over each
// wallet's Q (the movement world's test secrets 1000 + i).
// INDEPENDENT ORACLE: the BIP341 SIGHASH_DEFAULT digest is computed here in
// TypeScript from the BIP341 text (no Go digest binary, no contract call);
// the honest defenses resolving their challenges cross-checks it against
// the contract's reconstruction.
// FIXTURES: the movement world (FrostRegistryFixture readiness, synthetic
// two-leaf regtest inclusion proofs, the controlled enterMovingFunds
// storage marker of C-06).
import { ethers, network } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { AssertionError, expect } from "chai"
import { BigNumber, BigNumberish } from "ethers"
import { createHash } from "crypto"
import * as secp from "@noble/secp256k1"
import {
  ZERO,
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

const AUTH = { proven: 1, intent: 2, movement: 3, self: 4 }
const MAX_SATOSHI = BigNumber.from("2100000000000000")

/// Awaits a step that must succeed: a refusal fails as a named assertion
/// whose stack starts at the call site, rather than as an uncaught revert.
async function ok<T>(step: Promise<T>, label: string): Promise<T> {
  const site: { stack?: string } = {}
  Error.captureStackTrace(site, ok)
  try {
    const result = await step
    const sent = result as unknown as { wait?: () => Promise<unknown> }
    if (typeof sent?.wait === "function") await sent.wait()
    return result
  } catch (error) {
    const { reason, message } = error as { reason?: string; message?: string }
    const failure: Error = new AssertionError(
      `${label} was refused: ${reason ?? message}`
    )
    failure.stack = `AssertionError: ${failure.message}\n${(site.stack ?? "")
      .split("\n")
      .slice(1)
      .join("\n")}`
    throw failure
  }
}

async function refused(step: Promise<unknown>, label: string) {
  await expect(step, label).to.be.reverted
}

// ---- Independent BIP341 SIGHASH_DEFAULT (hash type 0x00, no annex). ----
const sha = (b: Buffer) => createHash("sha256").update(b).digest()
const tagged = (tag: string, msg: Buffer) =>
  sha(Buffer.concat([sha(Buffer.from(tag)), sha(Buffer.from(tag)), msg]))
const le = (value: BigNumberish, width: number) => {
  let n = BigInt(value.toString())
  const b = Buffer.alloc(width)
  for (let i = 0; i < width; i += 1) {
    b[i] = Number(n & 255n)
    n >>= 8n
  }
  return b
}
type Info = Tx["tx"]
type Prevout = { value: BigNumberish; script: string }
/// Reads the first `inputs[0]` 41-byte inputs (outpoint, empty scriptSig,
/// sequence) and digests input `index`. A nonzero leaf hash is the BIP342
/// script path (key version 0, no code separator).
function bip341(tx: Info, index: number, prevouts: Prevout[], leafHash = ZERO) {
  const inputs = raw(tx.inputVector)
  const n = inputs[0]
  const outpoints: Buffer[] = []
  const sequences: Buffer[] = []
  for (let i = 0; i < n; i++) {
    outpoints.push(inputs.subarray(1 + i * 41, 1 + i * 41 + 36))
    sequences.push(inputs.subarray(1 + i * 41 + 37, 1 + i * 41 + 41))
  }
  const counted = prevouts.slice(0, n)
  const amounts = Buffer.concat(counted.map((p) => le(p.value, 8)))
  const scripts = Buffer.concat(
    counted.map((p) =>
      Buffer.concat([Buffer.from([raw(p.script).length & 255]), raw(p.script)])
    )
  )
  const script = leafHash !== ZERO
  const message = Buffer.concat([
    Buffer.from([0, 0]),
    raw(tx.version),
    raw(tx.locktime),
    sha(Buffer.concat(outpoints)),
    sha(amounts),
    sha(scripts),
    sha(Buffer.concat(sequences)),
    sha(raw(tx.outputVector).subarray(1)),
    Buffer.from([script ? 2 : 0]),
    le(index, 4),
    script
      ? Buffer.concat([raw(leafHash), Buffer.from("00ffffffff", "hex")])
      : Buffer.alloc(0),
  ])
  return `0x${tagged("TapSighash", message).toString("hex")}`
}

const keyPath = (q: string) => `0x5120${q.slice(2)}`
/// One self-transfer output: 0x01 ‖ value ‖ 0x22 ‖ OP_1 PUSH32 Q.
const selfOutput = (value: BigNumberish, q: string, version = "51") =>
  `0x01${le(value, 8).toString("hex")}22${version}20${q.slice(2)}`
/// A version 2 transaction from raw input entries and a raw output vector.
const rawTx = (
  inputs: { hash: string; index: number; scriptSig?: string }[],
  outputVector: string,
  version = "0x02000000",
  trailing = ""
): Info => ({
  version,
  inputVector: `0x${Buffer.concat([
    Buffer.from([inputs.length]),
    ...inputs.map((i) =>
      Buffer.concat([
        raw(i.hash),
        le(i.index, 4),
        Buffer.from((i.scriptSig ?? "00").replace(/^0x/, ""), "hex"),
        le(0xfffffffd, 4),
      ])
    ),
  ]).toString("hex")}${trailing}`,
  outputVector,
  locktime: "0x00000000",
})
const txHashOf = (tx: Info) =>
  `0x${sha(
    sha(
      Buffer.concat(
        [tx.version, tx.inputVector, tx.outputVector, tx.locktime].map(raw)
      )
    )
  ).toString("hex")}`

describe("M9 lifecycle fraud guards (C-08 defenses, C-09 lifecycle)", function fraudGuards() {
  this.timeout(120000)
  let w: World
  let x: Wallet
  let y: Wallet
  let z: Wallet
  let challenger: SignerWithAddress
  let bond: BigNumber
  let defeatTimeout: number
  // x's funding sweep: proven, one deposit input (script path).
  let fundTx: Tx
  let fundDepositKey: string
  // x's second sweep: proven, inputs [deposit, previous main (key path)].
  let sweep2: Info
  let sweep2Prevouts: Prevout[]
  let snapshot: string

  const secretOf = (wallet: Wallet) =>
    ethers.utils
      .hexZeroPad(ethers.utils.hexlify(1000 + w.wallets.indexOf(wallet)), 32)
      .slice(2)
  const sign = async (wallet: Wallet, digest: string, secret?: string) =>
    `0x${Buffer.from(
      await secp.schnorr.sign(
        raw(digest),
        secret ?? secretOf(wallet),
        new Uint8Array(32)
      )
    ).toString("hex")}`
  const submit = async (
    wallet: Wallet,
    digest: string,
    options: { id?: string; value?: BigNumberish; signature?: string } = {}
  ) =>
    w.frost
      .connect(challenger)
      .submitFrostFraudChallenge(
        options.id ?? wallet.id,
        digest,
        options.signature ?? (await sign(wallet, digest)),
        { value: options.value ?? bond }
      )
  const challenge = (wallet: Wallet, digest: string) =>
    w.frost.frostFraudChallenge(wallet.id, digest)
  const open = async (wallet: Wallet) =>
    (await w.frost.frostOpenChallenges(wallet.id)).toNumber()
  const defense = (
    wallet: Wallet,
    tx: Info,
    prevouts: Prevout[],
    authorization: number,
    options: { ref?: string; index?: number; leaf?: string } = {}
  ) => ({
    walletId: wallet.id,
    transaction: tx,
    prevouts,
    inputIndex: options.index ?? 0,
    leafHash: options.leaf ?? ZERO,
    authorization,
    authorizationRef: options.ref ?? ZERO,
  })
  /// A defense whose digest (as the contract would rebuild it from these
  /// bytes) is challenged under Q, then must be refused: the challenge
  /// stays open. `digestIndex`/`digestPrevouts` give the digest a lenient
  /// parser would rebuild when it differs from the defense's own fields.
  const refusesDefense = async (
    label: string,
    wallet: Wallet,
    d: ReturnType<typeof defense>,
    digestPrevouts: Prevout[] = d.prevouts
  ) => {
    const digest = bip341(
      d.transaction,
      d.inputIndex,
      digestPrevouts,
      d.leafHash
    )
    await ok(submit(wallet, digest), `${label}: challenge submission`)
    const before = await open(wallet)
    await refused(
      w.frost.defeatFrostFraudChallenge(d),
      `${label}: the defense was accepted`
    )
    expect(
      (await challenge(wallet, digest)).resolved,
      `${label}: the challenge was resolved`
    ).to.equal(false)
    expect(await open(wallet), `${label}: open challenges changed`).to.equal(
      before
    )
  }
  /// An honest defense must resolve its challenge.
  const defeats = async (
    label: string,
    wallet: Wallet,
    d: ReturnType<typeof defense>
  ) => {
    const digest = bip341(d.transaction, d.inputIndex, d.prevouts, d.leafHash)
    await ok(submit(wallet, digest), `${label}: challenge submission`)
    await ok(w.frost.defeatFrostFraudChallenge(d), label)
    expect(
      (await challenge(wallet, digest)).resolved,
      `${label}: the challenge stayed open`
    ).to.equal(true)
  }
  /// A zero-fee self-transfer of one key-path output of Q (by default the
  /// wallet's main; a named input gives a variant its own digest).
  const selfTransfer = (
    wallet: Wallet,
    value: BigNumberish,
    input?: string
  ) => {
    const tx = rawTx(
      [{ hash: input ?? (wallet.main as Tx).hash, index: 0 }],
      selfOutput(value, wallet.q)
    )
    return { tx, prevouts: [{ value, script: keyPath(wallet.q) }] }
  }
  const variant = (name: string) => ethers.utils.id(`M9 variant ${name}`)
  const advanceTo = async (timestamp: number) => {
    await network.provider.send("evm_setNextBlockTimestamp", [timestamp])
    await network.provider.send("evm_mine")
  }

  before(async () => {
    w = await movementWorld(3)
    ;[x, y, z] = w.wallets
    ;[, , , , , challenger] = w.signers
    const fraud = await w.bridge.fraudParameters()
    bond = fraud.fraudChallengeDepositAmount
    defeatTimeout = fraud.fraudChallengeDefeatTimeout
    fundTx = await w.fund(x, 600000)
    // The fund sweep's input is x's first revealed deposit.
    fundDepositKey = ethers.utils.solidityKeccak256(
      ["bytes32", "uint32"],
      [`0x${raw(fundTx.tx.inputVector).subarray(1, 33).toString("hex")}`, 0]
    )
    // A second proven sweep spending a new deposit and the main.
    const d2 = await w.reveal(x, 50000)
    const main = x.main as Tx
    const sweep = transaction(
      [
        [d2.hash, 0],
        [main.hash, 0],
      ],
      [{ value: x.value + 49000, script: p2tr(x.q) }]
    )
    await w.frost.submitFrostDepositSweepProof({
      walletId: x.id,
      transaction: sweep.tx,
      proof: inclusion(sweep.hash),
      includeMain: true,
      vault: ethers.constants.AddressZero,
    })
    const d2Deposit = await w.deposit(d2.key())
    sweep2 = sweep.tx
    sweep2Prevouts = [
      {
        value: 50000,
        script: `0x5120${d2Deposit.depositOutputKey.slice(2)}`,
      },
      { value: x.value, script: keyPath(x.q) },
    ]
    x.main = sweep
    x.value += 49000
    expect(
      await w.frost.frostProvenTransaction(sweep.hash),
      "setup: the second sweep is proven"
    ).to.equal(x.id)
    snapshot = await network.provider.send("evm_snapshot")
  })
  beforeEach(async () => {
    expect(await network.provider.send("evm_revert", [snapshot])).to.equal(true)
    snapshot = await network.provider.send("evm_snapshot")
  })

  describe("challenge admission (FrostFraud.submit)", () => {
    it("admits a valid challenge once and refuses a duplicate (FrostFraud.sol:131)", async () => {
      const digest = ethers.utils.id("M9 arbitrary digest")
      await ok(submit(x, digest), "the first challenge")
      await refused(submit(x, digest), "a duplicate challenge was admitted")
      expect(await open(x), "one open challenge").to.equal(1)
    })

    it("refuses a short bond (FrostFraud.sol:111)", async () => {
      const digest = ethers.utils.id("M9 short bond")
      await refused(
        submit(x, digest, { value: bond.sub(1) }),
        "a challenge with a short bond was admitted"
      )
      await ok(submit(x, digest), "the same challenge with the full bond")
    })

    it("refuses an invalid signature under Q (FrostFraud.sol:116, :117)", async () => {
      const digest = ethers.utils.id("M9 invalid signature")
      await refused(
        submit(x, digest, {
          signature: await sign(x, ethers.utils.id("M9 other digest")),
        }),
        "a signature over another digest was admitted"
      )
      await refused(
        submit(x, digest, {
          signature: await sign(x, digest, secretOf(y)),
        }),
        "a signature under another wallet's key was admitted"
      )
      expect(await open(x), "no open challenge").to.equal(0)
    })

    it("refuses an alias ID and a Closed wallet (FrostFraud.sol:101, :103)", async () => {
      const digest = ethers.utils.id("M9 wallet state")
      // Same 20-byte label, different full ID.
      const alias = `${x.label}${"00".repeat(12)}`
      expect(alias, "setup: the alias differs from the ID").to.not.equal(x.id)
      await refused(
        submit(x, digest, { id: alias }),
        "a challenge under an alias ID was admitted"
      )
      expect(
        (await w.frost.frostOpenChallenges(alias)).toNumber(),
        "alias open challenges"
      ).to.equal(0)
      // z is empty: close it through the public C-09 route.
      const lifecycle = await w.frost.frostWalletLifecycle(z.id)
      const maxAge = (await w.bridge.walletParameters()).walletMaxAge
      await advanceTo(lifecycle.readyAt.toNumber() + maxAge)
      await ok(w.frost.notifyFrostWalletCloseable(z.id), "close z by age")
      const closing = (await w.bridge.walletParameters()).walletClosingPeriod
      await advanceTo(
        (await w.frost.frostWalletLifecycle(z.id)).closingStartedAt.toNumber() +
          closing +
          1
      )
      await ok(w.frost.finalizeFrostWalletClosing(z.id), "finalize z")
      expect(await w.state(z), "setup: z is Closed").to.equal(State.Closed)
      await refused(
        submit(z, digest),
        "a challenge against a Closed wallet was admitted"
      )
    })
  })

  describe("timeout and heartbeat resolution", () => {
    it("never times out early, and never a resolved challenge (FrostFraud.sol:169, :173)", async () => {
      // A resolved (heartbeat-defeated) challenge first, then an open one.
      const nonce = 3
      const heartbeat = await w.frost.frostHeartbeatDigest(x.id, nonce)
      await ok(submit(x, heartbeat), "heartbeat challenge")
      await ok(
        w.frost.defeatFrostFraudChallengeWithHeartbeat(x.id, nonce),
        "heartbeat defeat"
      )
      const a = ethers.utils.id("M9 timeout A")
      await ok(submit(x, a), "challenge A")
      const reportedAt = (await challenge(x, a)).reportedAt.toNumber()
      await network.provider.send("evm_setNextBlockTimestamp", [
        reportedAt + defeatTimeout - 1,
      ])
      await refused(
        w.frost.notifyFrostFraudChallengeDefeatTimeout(x.id, a),
        "a timeout one second early was accepted"
      )
      expect(await w.state(x), "x before the timeout").to.equal(State.Live)
      // After every deadline, the resolved challenge still cannot time out
      // while A keeps the open-challenge counter nonzero.
      await network.provider.send("evm_setNextBlockTimestamp", [
        reportedAt + defeatTimeout + 5,
      ])
      await refused(
        w.frost.notifyFrostFraudChallengeDefeatTimeout(x.id, heartbeat),
        "a resolved challenge was timed out"
      )
      expect(await w.state(x), "x after the refused notice").to.equal(
        State.Live
      )
      expect(await open(x), "A stays open").to.equal(1)
    })

    it("accepts a timeout exactly at reportedAt + timeout (FrostFraud.sol:175)", async () => {
      const a = ethers.utils.id("M9 timeout boundary")
      await ok(submit(x, a), "challenge")
      const reportedAt = (await challenge(x, a)).reportedAt.toNumber()
      await network.provider.send("evm_setNextBlockTimestamp", [
        reportedAt + defeatTimeout,
      ])
      await ok(
        w.frost.notifyFrostFraudChallengeDefeatTimeout(x.id, a),
        "a timeout exactly at reportedAt + timeout"
      )
      expect(await w.state(x), "x is Terminated").to.equal(State.Terminated)
    })

    it("defeats a heartbeat challenge once, leaving other challenges open (FrostFraud.sol:232)", async () => {
      const nonce = 9
      const heartbeat = await w.frost.frostHeartbeatDigest(x.id, nonce)
      await ok(submit(x, heartbeat), "heartbeat challenge")
      await ok(submit(x, ethers.utils.id("M9 other open")), "other challenge")
      await ok(
        w.frost.defeatFrostFraudChallengeWithHeartbeat(x.id, nonce),
        "heartbeat defeat"
      )
      await refused(
        w.frost.defeatFrostFraudChallengeWithHeartbeat(x.id, nonce),
        "a second heartbeat defeat was accepted"
      )
      expect(await open(x), "the other challenge stays open").to.equal(1)
    })
  })

  describe("transaction defenses: self-transfer and parsing", () => {
    it("defeats an honest zero-fee self-transfer (key path)", async () => {
      const s = selfTransfer(x, x.value)
      await defeats(
        "the honest self-transfer",
        x,
        defense(x, s.tx, s.prevouts, AUTH.self)
      )
    })

    it("defeats a self-transfer of 128 key-path inputs, the maximum (FrostFraud.sol:256)", async () => {
      const inputs = Array.from({ length: 128 }, (_, i) => ({
        hash: ethers.utils.id(`M9 self input ${i}`),
        index: i,
      }))
      const prevouts = inputs.map(() => ({ value: 1000, script: keyPath(x.q) }))
      const tx = rawTx(inputs, selfOutput(128000, x.q))
      await defeats(
        "a 128-input self-transfer",
        x,
        defense(x, tx, prevouts, AUTH.self, { index: 127 })
      )
    })

    it("defeats a self-transfer whose prevout is exactly 2.1e15 (FrostFraud.sol:328)", async () => {
      const tx = rawTx(
        [{ hash: (x.main as Tx).hash, index: 0 }],
        selfOutput(MAX_SATOSHI, x.q)
      )
      await defeats(
        "a 2.1e15 self-transfer",
        x,
        defense(
          x,
          tx,
          [{ value: MAX_SATOSHI, script: keyPath(x.q) }],
          AUTH.self
        )
      )
    })

    it("refuses malformed defenses whose digest is challenged (FrostFraud.sol:251-267, :327, :328)", async () => {
      const s = selfTransfer(x, x.value, variant("version"))
      await refusesDefense(
        "version 1",
        x,
        defense(x, { ...s.tx, version: "0x01000000" }, s.prevouts, AUTH.self)
      )
      const e = selfTransfer(x, x.value, variant("extra prevout"))
      await refusesDefense(
        "an extra prevout",
        x,
        defense(
          x,
          e.tx,
          [...e.prevouts, { value: 1, script: keyPath(x.q) }],
          AUTH.self
        )
      )
      await refusesDefense(
        "trailing input bytes",
        x,
        defense(
          x,
          rawTx(
            [{ hash: variant("trailing"), index: 0 }],
            selfOutput(x.value, x.q),
            "0x02000000",
            "00"
          ),
          s.prevouts,
          AUTH.self
        )
      )
      await refusesDefense(
        "a nonempty scriptSig in the fixed layout",
        x,
        defense(
          x,
          rawTx(
            [{ hash: variant("scriptSig"), index: 0, scriptSig: "01" }],
            selfOutput(x.value, x.q)
          ),
          s.prevouts,
          AUTH.self
        )
      )
      const over = MAX_SATOSHI.add(1)
      await refusesDefense(
        "a prevout above 2.1e15",
        x,
        defense(
          x,
          rawTx(
            [{ hash: (x.main as Tx).hash, index: 0 }],
            selfOutput(over, x.q)
          ),
          [{ value: over, script: keyPath(x.q) }],
          AUTH.self
        )
      )
    })

    it("refuses self-transfers outside the self policy (FrostFraud.sol:552-579)", async () => {
      const main = { hash: (x.main as Tx).hash, index: 0 }
      await refusesDefense(
        "a fee above the zero cap",
        x,
        defense(
          x,
          rawTx([main], selfOutput(x.value - 1, x.q)),
          [{ value: x.value, script: keyPath(x.q) }],
          AUTH.self
        )
      )
      await refusesDefense(
        "an output to another key",
        x,
        defense(
          x,
          rawTx([main], selfOutput(x.value, y.q)),
          [{ value: x.value, script: keyPath(x.q) }],
          AUTH.self
        )
      )
      await refusesDefense(
        "a witness v2 output to Q",
        x,
        defense(
          x,
          rawTx([main], selfOutput(x.value, x.q, "52")),
          [{ value: x.value, script: keyPath(x.q) }],
          AUTH.self
        )
      )
      // A second input that is neither Q's key path nor a deposit.
      const foreign = { hash: ethers.utils.id("M9 foreign input"), index: 0 }
      await refusesDefense(
        "a foreign second input",
        x,
        defense(
          x,
          rawTx([main, foreign], selfOutput(x.value + 5000, x.q)),
          [
            { value: x.value, script: keyPath(x.q) },
            { value: 5000, script: `0x0014${"33".repeat(20)}` },
          ],
          AUTH.self
        )
      )
      // x's revealed (swept) deposit outpoint with a wrong prevout script.
      const depositInput = {
        hash: `0x${raw(fundTx.tx.inputVector).subarray(1, 33).toString("hex")}`,
        index: 0,
      }
      expect(
        (await w.deposit(fundDepositKey)).revealedAt,
        "setup: x's deposit is revealed"
      ).to.be.gt(0)
      await refusesDefense(
        "x's deposit with a foreign script",
        x,
        defense(
          x,
          rawTx([main, depositInput], selfOutput(x.value + 5000, x.q)),
          [
            { value: x.value, script: keyPath(x.q) },
            { value: 5000, script: keyPath(y.q) },
          ],
          AUTH.self
        )
      )
    })
  })

  describe("transaction defenses: spend type and authorization", () => {
    it("refuses a key-path defense whose challenged prevout is not Q (FrostFraud.sol:371)", async () => {
      // The second sweep is proven; its challenged input 1 claims a P2WPKH.
      await refusesDefense(
        "a non-Q key-path prevout",
        x,
        defense(
          x,
          sweep2,
          [
            sweep2Prevouts[0],
            { ...sweep2Prevouts[1], script: `0x0014${"44".repeat(20)}` },
          ],
          AUTH.proven,
          { index: 1 }
        )
      )
    })

    it("defeats a proven key-path input and refuses one with a 253-byte prevout script (FrostFraud.sol:329)", async () => {
      await defeats(
        "the proven second sweep, key-path input",
        x,
        defense(x, sweep2, sweep2Prevouts, AUTH.proven, { index: 1 })
      )
      await refusesDefense(
        "a 253-byte prevout script",
        x,
        defense(
          x,
          sweep2,
          [
            { value: 50000, script: `0x${"ab".repeat(253)}` },
            sweep2Prevouts[1],
          ],
          AUTH.proven,
          { index: 1 }
        )
      )
    })

    it("refuses a script-path defense on a wrong leaf (FrostFraud.sol:380, :382)", async () => {
      // The proven fund sweep's input 0 is x's revealed deposit.
      const deposit = await w.deposit(fundDepositKey)
      const prevouts = [
        {
          value: 600000,
          script: `0x5120${deposit.depositOutputKey.slice(2)}`,
        },
      ]
      await refusesDefense(
        "x's deposit input on a wrong leaf",
        x,
        defense(x, fundTx.tx, prevouts, AUTH.proven, {
          leaf: ethers.utils.id("M9 wrong leaf"),
        })
      )
      // The main input of the second sweep is not a deposit at all.
      await refusesDefense(
        "a key-path input claimed as a leaf",
        x,
        defense(x, sweep2, sweep2Prevouts, AUTH.proven, {
          index: 1,
          leaf: ethers.utils.id("M9 not a deposit leaf"),
        })
      )
    })

    it("refuses an unproven transaction under the proven or intent authorization (FrostFraud.sol:402, :413)", async () => {
      // Not a self-transfer (fee 7 > cap 0), and never proven or reserved.
      const unproven = rawTx(
        [{ hash: (x.main as Tx).hash, index: 0 }],
        selfOutput(x.value - 7, x.q)
      )
      expect(
        await w.frost.frostProvenTransaction(txHashOf(unproven)),
        "setup: not proven"
      ).to.equal(ZERO)
      await refusesDefense(
        "an unproven transaction claimed as proven",
        x,
        defense(
          x,
          unproven,
          [{ value: x.value, script: keyPath(x.q) }],
          AUTH.proven
        )
      )
      await refusesDefense(
        "an unreserved transaction claimed as an intent",
        x,
        defense(
          x,
          rawTx(
            [{ hash: variant("intent"), index: 0 }],
            selfOutput(x.value - 7, x.q)
          ),
          [{ value: x.value, script: keyPath(x.q) }],
          AUTH.intent,
          { ref: ethers.utils.id("M9 no such intent") }
        )
      )
    })
  })

  describe("transaction defenses: movement", () => {
    let targets: Wallet[]
    let movement: Info
    let values: number[]
    const prevouts = () => [{ value: x.value, script: keyPath(x.q) }]
    const commit = async () => {
      await w.enterMovingFunds(x)
      targets = ascending([y, z])
      await ok(
        w.frost.connect(w.operator).submitFrostMovingFundsCommitment(
          x.id,
          0,
          targets.map((t) => t.label)
        ),
        "setup: movement commitment"
      )
    }
    /// Raw movement outputs: count ‖ (value 8 LE ‖ 0x22 ‖ 51 20 key) each.
    const outputs = (vals: BigNumberish[], keys: string[], lengthByte = "22") =>
      `0x${Buffer.from([vals.length]).toString("hex")}${vals
        .map(
          (v, i) =>
            `${le(v, 8).toString("hex")}${lengthByte}5120${keys[i].slice(2)}`
        )
        .join("")}`
    const build = (
      vals: BigNumberish[],
      options: { lengthByte?: string; keys?: string[]; extra?: boolean } = {}
    ) =>
      rawTx(
        [
          { hash: (x.main as Tx).hash, index: 0 },
          ...(options.extra
            ? [{ hash: ethers.utils.id("M9 extra movement input"), index: 0 }]
            : []),
        ],
        outputs(
          vals,
          options.keys ?? targets.map((t) => t.q),
          options.lengthByte
        )
      )

    beforeEach(async () => {
      await commit()
      values = split(x.value - 3000, 2)
      movement = build(values)
    })

    it("defeats the exact committed movement, including a zero fee and the full cap (FrostFraud.sol:443-498)", async () => {
      await defeats(
        "the committed movement",
        x,
        defense(x, movement, prevouts(), AUTH.movement)
      )
      const cap = (await w.commitment(x, 0)).maxFee.toNumber()
      await defeats(
        "the movement with zero fee",
        x,
        defense(x, build(split(x.value, 2)), prevouts(), AUTH.movement)
      )
      await defeats(
        "the movement with a fee equal to the committed cap",
        x,
        defense(x, build(split(x.value - cap, 2)), prevouts(), AUTH.movement)
      )
    })

    it("refuses movements outside the commitment (FrostFraud.sol:442-497)", async () => {
      const cap = (await w.commitment(x, 0)).maxFee.toNumber()
      await refusesDefense(
        "a period above uint32",
        x,
        defense(x, movement, prevouts(), AUTH.movement, {
          ref: ethers.utils.hexZeroPad(
            BigNumber.from(2).pow(32).toHexString(),
            32
          ),
        })
      )
      await refusesDefense(
        "an extra input",
        x,
        defense(
          x,
          build(values, { extra: true }),
          [...prevouts(), { value: 5000, script: keyPath(x.q) }],
          AUTH.movement
        )
      )
      await refusesDefense(
        "an output paying another key",
        x,
        defense(
          x,
          build(values, { keys: [targets[0].q, x.q] }),
          prevouts(),
          AUTH.movement
        )
      )
      await refusesDefense(
        "an output with a wrong script length byte",
        x,
        defense(
          x,
          build(values, { lengthByte: "23" }),
          prevouts(),
          AUTH.movement
        )
      )
      await refusesDefense(
        "a fee above the committed cap",
        x,
        defense(
          x,
          build(split(x.value - cap - 1, 2)),
          prevouts(),
          AUTH.movement
        )
      )
    })

    it("refuses a self-transfer funded by another wallet's incoming fee cap (FrostFraud.sol:542)", async () => {
      // Prove x's movement: y and z each record one incoming output.
      const proof = transaction(
        [[(x.main as Tx).hash, 0]],
        targets.map((t, i) => ({ value: values[i], script: p2tr(t.q) }))
      )
      await ok(
        w.frost.submitFrostMovingFundsProof(
          x.id,
          proof.tx,
          inclusion(proof.hash)
        ),
        "setup: movement proof"
      )
      const zIndex = targets.indexOf(z)
      const zIncoming = await w.frost.frostIncoming(proof.key(zIndex))
      expect(zIncoming.sweepFeeCap, "setup: z's incoming cap").to.be.gt(1000)
      // y claims z's incoming outpoint as its own key-path input.
      const value = values[zIndex]
      await refusesDefense(
        "y's self-transfer of z's incoming output with a 1,000 fee",
        y,
        defense(
          y,
          rawTx(
            [{ hash: proof.hash, index: zIndex }],
            selfOutput(value - 1000, y.q)
          ),
          [{ value, script: keyPath(y.q) }],
          AUTH.self
        )
      )
    })
  })

  describe("transaction defenses: movement under a raised fee cap", () => {
    it("refuses a committed movement that pays a target nothing (FrostFraud.sol:489)", async () => {
      // Governance may raise movingFundsTxMaxTotalFee without bound; the
      // commitment captures it. A zero output then fits the fee cap.
      const params = Array.from(await w.bridge.movingFundsParameters())
      params[0] = 1000000
      await w.bridge.updateMovingFundsParameters(...params)
      await w.enterMovingFunds(x)
      const targets = ascending([y, z])
      await ok(
        w.frost.connect(w.operator).submitFrostMovingFundsCommitment(
          x.id,
          0,
          targets.map((t) => t.label)
        ),
        "setup: movement commitment"
      )
      expect(
        (await w.commitment(x, 0)).maxFee,
        "setup: the captured cap"
      ).to.equal(1000000)
      const prevouts = [{ value: x.value, script: keyPath(x.q) }]
      const move = (values: number[]) =>
        rawTx(
          [{ hash: (x.main as Tx).hash, index: 0 }],
          `0x02${values
            .map(
              (v, i) =>
                `${le(v, 8).toString("hex")}225120${targets[i].q.slice(2)}`
            )
            .join("")}`
        )
      await defeats(
        "a committed movement of one satoshi per target",
        x,
        defense(x, move([1, 1]), prevouts, AUTH.movement)
      )
      await refusesDefense(
        "a committed movement paying the first target nothing",
        x,
        defense(x, move([0, 1]), prevouts, AUTH.movement)
      )
    })
  })

  describe("C-09 lifecycle guards", () => {
    it("closes a wallet by age exactly at readyAt + walletMaxAge (FrostLifecycle.sol:150)", async () => {
      const { readyAt } = await w.frost.frostWalletLifecycle(y.id)
      const maxAge = (await w.bridge.walletParameters()).walletMaxAge
      await network.provider.send("evm_setNextBlockTimestamp", [
        readyAt.toNumber() + maxAge - 1,
      ])
      await refused(
        w.frost.notifyFrostWalletCloseable(y.id),
        "a wallet one second younger than walletMaxAge was closeable"
      )
      await network.provider.send("evm_setNextBlockTimestamp", [
        readyAt.toNumber() + maxAge,
      ])
      await ok(
        w.frost.notifyFrostWalletCloseable(y.id),
        "closing a wallet exactly walletMaxAge old"
      )
    })

    it("treats custody equal to walletClosureMinBtcBalance as not small (FrostLifecycle.sol:152)", async () => {
      const p = await w.bridge.walletParameters()
      // y funded to exactly the closure minimum (deposit minus the 1,000 fee).
      await w.bridge.updateWalletParameters(
        p.walletCreationPeriod,
        p.walletCreationMinBtcBalance,
        p.walletCreationMaxBtcBalance,
        50000,
        p.walletMaxAge,
        p.walletMaxBtcTransfer,
        p.walletClosingPeriod
      )
      await w.fund(y, 51000)
      expect(y.value, "setup: y custody").to.equal(50000)
      await refused(
        w.frost.notifyFrostWalletCloseable(y.id),
        "custody equal to the closure minimum was treated as small"
      )
      expect(await w.state(y), "y stays Live").to.equal(State.Live)
    })

    it("refuses lifecycle notices under an alias ID (FrostLifecycle.sol:421)", async () => {
      const alias = `${y.label}${"00".repeat(12)}`
      await refused(
        w.frost.notifyFrostWalletCloseable(alias),
        "a closeable notice under an alias ID was accepted"
      )
      expect(await w.state(y), "y is untouched").to.equal(State.ReadyUnfunded)
      const xAlias = `${x.label}${"00".repeat(12)}`
      await refused(
        w.frost.notifyFrostWalletCloseable(xAlias),
        "a closeable notice under a funded wallet's alias ID was accepted"
      )
      expect(await w.state(x), "x is untouched").to.equal(State.Live)
    })

    it("refuses an inactivity claim with a repeated signing seat (FrostLifecycle.sol:292)", async () => {
      const digest = ethers.utils.arrayify(
        await w.frost.frostInactivityClaimDigest(x.id, 0, [3], false)
      )
      const signature = await w.operator.signMessage(digest)
      await refused(
        w.frost.notifyFrostOperatorInactivity(
          x.id,
          0,
          [3],
          false,
          [1, 1],
          ethers.utils.hexConcat([signature, signature])
        ),
        "an inactivity claim signed twice by seat 1 was accepted"
      )
      expect(
        await w.frost.frostInactivityNonce(x.id),
        "the nonce is unchanged"
      ).to.equal(0)
    })
  })
})
