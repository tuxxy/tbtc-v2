/* eslint-disable no-await-in-loop, no-restricted-syntax */
// C-08 FROST fraud admission and exact defenses through the public Bridge.
// Signatures are real BIP340 signatures under each wallet's Q; every
// transaction digest is computed independently by btcd (frost-tapscript-
// digest.go) and must equal the contract's reconstruction for a defense to
// resolve the challenge. Inclusion proofs are synthetic regtest blocks.
import { ethers, network } from "hardhat"
import { expect } from "chai"
import { execFileSync } from "child_process"
import { createHash } from "crypto"
import * as secp from "@noble/secp256k1"
import digestBinaryForRun from "../helpers/frost-digest-builder"
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

const BOND = ethers.utils.parseEther("5")
const AUTH = { proven: 1, intent: 2, movement: 3 }
const sha = (b: Buffer) => createHash("sha256").update(b).digest()
const tagged = (tag: string, msg: Buffer) =>
  sha(Buffer.concat([sha(Buffer.from(tag)), sha(Buffer.from(tag)), msg]))
const secretOf = (i: number) =>
  ethers.utils.hexZeroPad(ethers.utils.hexlify(1000 + i), 32).slice(2)

describe("C-08 FROST fraud admission and exact defenses", () => {
  let w: World
  let binary: string
  let source: Wallet
  let targets: Wallet[]
  let challenger: any
  let snapshot: string

  const advance = async (seconds: number) => {
    await network.provider.send("evm_increaseTime", [seconds])
    await network.provider.send("evm_mine")
  }
  const sign = async (wallet: Wallet, digest: string) =>
    `0x${Buffer.from(
      await secp.schnorr.sign(
        raw(digest),
        secretOf(w.wallets.indexOf(wallet)),
        new Uint8Array(32)
      )
    ).toString("hex")}`
  const challenge = async (wallet: Wallet, digest: string) =>
    w.frost
      .connect(challenger)
      .submitFrostFraudChallenge(
        wallet.id,
        digest,
        await sign(wallet, digest),
        {
          value: BOND,
        }
      )
  type Prevout = { value: number; script: string }
  /// btcd's BIP341 SIGHASH_DEFAULT digest for one input.
  const btcd = (tx: Tx, index: number, prevouts: Prevout[], leaf = "") => {
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
          inputIndex: index,
          prevouts: prevouts.map((p) => ({
            value: p.value,
            script: p.script.slice(2),
          })),
          leaf: leaf.replace(/^0x/, ""),
        }),
      }).toString()
    )
    return `0x${result.digest}`
  }
  const defense = (
    wallet: Wallet,
    tx: Tx,
    prevouts: Prevout[],
    authorization: number,
    authorizationRef = ZERO,
    inputIndex = 0,
    leafHash = ZERO
  ) => ({
    walletId: wallet.id,
    transaction: tx.tx,
    prevouts,
    inputIndex,
    leafHash,
    authorization,
    authorizationRef,
  })
  const keyPath = (wallet: Wallet) => `0x5120${wallet.q.slice(2)}`
  const commitAndBuild = async (values?: number[]) => {
    await w.frost.connect(w.operator).submitFrostMovingFundsCommitment(
      source.id,
      0,
      targets.map((t) => t.label)
    )
    const v = values ?? split(source.value - 3000, targets.length)
    return transaction(
      [[(source.main as Tx).hash, 0]],
      targets.map((t, i) => ({ value: v[i], script: p2tr(t.q) }))
    )
  }
  const challengeState = async (wallet: Wallet, digest: string) =>
    w.frost.frostFraudChallenge(wallet.id, digest)

  before(async () => {
    binary = digestBinaryForRun(process.env.FROST_C05_DIGEST_BINARY)
    w = await movementWorld(4)
    ;[, , , , , challenger] = w.signers
    ;[source] = w.wallets
    await w.fund(source, 600000)
    targets = ascending(w.wallets.slice(1))
    await w.enterMovingFunds(source)
    snapshot = await network.provider.send("evm_snapshot")
  })
  beforeEach(async () => {
    expect(await network.provider.send("evm_revert", [snapshot])).to.equal(true)
    snapshot = await network.provider.send("evm_snapshot")
  })

  it("admits a valid signature under Q over an arbitrary digest exactly once", async () => {
    const digest = ethers.utils.id("C08 arbitrary digest outside any profile")
    await expect(challenge(source, digest))
      .to.emit(w.frost, "FrostFraudChallengeSubmitted")
      .withArgs(source.id, digest, await sign(source, digest))
    const c = await challengeState(source, digest)
    expect(c.challenger).to.equal(challenger.address)
    expect(c.depositAmount).to.equal(BOND)
    expect(c.resolved).to.equal(false)
    expect(await w.frost.frostOpenChallenges(source.id)).to.equal(1)
    await expect(challenge(source, digest)).to.be.revertedWith(
      "FROST fraud challenge exists"
    )
  })

  it("refuses invalid, foreign, wrong-message and wrong-key signatures and short bonds", async () => {
    const digest = ethers.utils.id("C08 refused digest")
    const other = ethers.utils.id("C08 other digest")
    const submit = (id: string, sig: string, value = BOND) =>
      w.frost
        .connect(challenger)
        .submitFrostFraudChallenge(id, digest, sig, { value })
    await expect(
      submit(source.id, await sign(source, other))
    ).to.be.revertedWith("FROST fraud signature")
    await expect(
      submit(source.id, await sign(targets[0], digest))
    ).to.be.revertedWith("FROST fraud signature")
    const wrongKey = `0x${Buffer.from(
      await secp.schnorr.sign(
        raw(digest),
        ethers.utils.hexZeroPad("0x07", 32).slice(2),
        new Uint8Array(32)
      )
    ).toString("hex")}`
    await expect(submit(source.id, wrongKey)).to.be.revertedWith(
      "FROST fraud signature"
    )
    const valid = await sign(source, digest)
    await expect(submit(source.id, `${valid}01`)).to.be.revertedWith(
      "FROST fraud signature"
    )
    await expect(submit(source.id, valid, BOND.sub(1))).to.be.revertedWith(
      "FROST fraud deposit"
    )
    await expect(submit(ethers.utils.id("unknown"), valid)).to.be.revertedWith(
      "FROST fraud wallet"
    )
    expect(await w.frost.frostOpenChallenges(source.id)).to.equal(0)
  })

  it("defeats a proven key-path movement signature and pays the bond to the treasury", async () => {
    const tx = await commitAndBuild()
    await w.frost.submitFrostMovingFundsProof(
      source.id,
      tx.tx,
      inclusion(tx.hash)
    )
    expect(await w.frost.frostProvenTransaction(tx.hash)).to.equal(source.id)
    const prevouts = [{ value: source.value, script: keyPath(source) }]
    const digest = btcd(tx, 0, prevouts)
    await challenge(source, digest)
    const before = await ethers.provider.getBalance(w.treasury.address)
    await expect(
      w.frost.defeatFrostFraudChallenge(
        defense(source, tx, prevouts, AUTH.proven)
      )
    )
      .to.emit(w.frost, "FrostFraudChallengeDefeated")
      .withArgs(source.id, digest)
    expect(await ethers.provider.getBalance(w.treasury.address)).to.equal(
      before.add(BOND)
    )
    expect((await challengeState(source, digest)).resolved).to.equal(true)
    expect(await w.frost.frostOpenChallenges(source.id)).to.equal(0)
    await expect(
      w.frost.defeatFrostFraudChallenge(
        defense(source, tx, prevouts, AUTH.proven)
      )
    ).to.be.revertedWith("FROST fraud challenge state")
  })

  it("defeats an unmined movement matching its commitment exactly and refuses a variant", async () => {
    const tx = await commitAndBuild()
    const prevouts = [{ value: source.value, script: keyPath(source) }]
    const values = split(source.value - 3000, 3)
    const variant = transaction(
      [[(source.main as Tx).hash, 0]],
      [targets[1], targets[0], targets[2]].map((t, i) => ({
        value: values[i],
        script: p2tr(t.q),
      }))
    )
    const variantDigest = btcd(variant, 0, prevouts)
    await challenge(source, variantDigest)
    await expect(
      w.frost.defeatFrostFraudChallenge(
        defense(source, variant, prevouts, AUTH.movement)
      )
    ).to.be.revertedWith("FROST defense movement output")
    const greedy = transaction(
      [[(source.main as Tx).hash, 0]],
      targets.map((t, i) => ({
        value: split(source.value - 9000, 3)[i],
        script: p2tr(t.q),
      }))
    )
    await challenge(source, btcd(greedy, 0, prevouts))
    await expect(
      w.frost.defeatFrostFraudChallenge(
        defense(source, greedy, prevouts, AUTH.movement)
      )
    ).to.be.revertedWith("FROST defense movement fee")

    const digest = btcd(tx, 0, prevouts)
    await challenge(source, digest)
    await w.frost.defeatFrostFraudChallenge(
      defense(source, tx, prevouts, AUTH.movement)
    )
    expect((await challengeState(source, digest)).resolved).to.equal(true)
    // The variant stays actionable.
    expect((await challengeState(source, variantDigest)).resolved).to.equal(
      false
    )
  })

  it("defends an unmined movement under its committed fee cap after governance lowers the cap", async () => {
    // 3,000-sat fee under the 5,000-sat cap in force at commitment.
    const tx = await commitAndBuild()
    expect((await w.commitment(source, 0)).maxFee).to.equal(5000)
    const prevouts = [{ value: source.value, script: keyPath(source) }]
    const digest = btcd(tx, 0, prevouts)
    await challenge(source, digest)
    const params = await w.bridge.movingFundsParameters()
    expect(params.movingFundsTxMaxTotalFee).to.equal(5000)
    await w.bridge.updateMovingFundsParameters(2000, ...params.slice(1))
    const lowered = await w.bridge.movingFundsParameters()
    expect(lowered.movingFundsTxMaxTotalFee).to.equal(2000)
    for (let i = 1; i < params.length; i++)
      expect(lowered[i]).to.equal(params[i])
    // The stored commitment keeps the cap that authorized the signature.
    expect((await w.commitment(source, 0)).maxFee).to.equal(5000)
    await expect(
      w.frost.defeatFrostFraudChallenge(
        defense(source, tx, prevouts, AUTH.movement)
      )
    )
      .to.emit(w.frost, "FrostFraudChallengeDefeated")
      .withArgs(source.id, digest)
    expect((await challengeState(source, digest)).resolved).to.equal(true)
    expect(await w.frost.frostOpenChallenges(source.id)).to.equal(0)
  })

  it("defeats a script-path deposit sweep signature on the wallet leaf only", async () => {
    const t = targets[0]
    const funding = await w.reveal(t, 80000)
    const sweep = transaction(
      [[funding.hash, 0]],
      [{ value: 79000, script: p2tr(t.q) }]
    )
    await w.frost.submitFrostDepositSweepProof({
      walletId: t.id,
      transaction: sweep.tx,
      proof: inclusion(sweep.hash),
      includeMain: false,
      vault: ethers.constants.AddressZero,
    })
    const deposit = await w.deposit(funding.key())
    const leaf = Buffer.concat([
      Buffer.from("20", "hex"),
      raw(deposit.receipt),
      Buffer.from("7520", "hex"),
      raw(t.q),
      Buffer.from("ac", "hex"),
    ])
    const leafHash = `0x${tagged(
      "TapLeaf",
      Buffer.concat([Buffer.from([0xc0, leaf.length]), leaf])
    ).toString("hex")}`
    const prevouts = [
      { value: 80000, script: `0x5120${deposit.depositOutputKey.slice(2)}` },
    ]
    const digest = btcd(sweep, 0, prevouts, `0x${leaf.toString("hex")}`)
    await challenge(t, digest)
    await expect(
      w.frost.defeatFrostFraudChallenge(
        defense(t, sweep, prevouts, AUTH.proven, ZERO, 0, ethers.utils.id("x"))
      )
    ).to.be.revertedWith("FROST defense deposit leaf")
    // The key-path digest of the same input is a different message.
    await expect(
      w.frost.defeatFrostFraudChallenge(
        defense(t, sweep, prevouts, AUTH.proven)
      )
    ).to.be.revertedWith("FROST defense key path")
    await w.frost.defeatFrostFraudChallenge(
      defense(t, sweep, prevouts, AUTH.proven, ZERO, 0, leafHash)
    )
    expect((await challengeState(t, digest)).resolved).to.equal(true)
  })

  it("defeats a payment named by an admitted intent even if it never mined", async () => {
    // Controlled C-04 marker: an admitted intent naming this transaction. The
    // reservation path that writes it is covered by the C-04 suites.
    const reservation = ethers.utils.id("C08 controlled reservation")
    const intent = w.entry(
      w.child(
        w.child(w.child(w.self, "frostRedemptions"), "ledger"),
        "intents"
      ),
      reservation
    )
    const payment = transaction(
      [[(source.main as Tx).hash, 0]],
      [
        { value: 100000, script: p2tr(targets[0].q) },
        { value: source.value - 102000, script: p2tr(source.q) },
      ]
    )
    await w.writeField(
      w.child(w.child(intent, "certificate"), "walletId"),
      source.id
    )
    await w.writeField(w.child(intent, "transactionHash"), payment.hash)
    const prevouts = [{ value: source.value, script: keyPath(source) }]
    const digest = btcd(payment, 0, prevouts)
    await challenge(source, digest)
    await expect(
      w.frost.defeatFrostFraudChallenge(
        defense(
          source,
          payment,
          prevouts,
          AUTH.intent,
          ethers.utils.id("another reservation")
        )
      )
    ).to.be.revertedWith("FROST defense intent")
    await w.frost.defeatFrostFraudChallenge(
      defense(source, payment, prevouts, AUTH.intent, reservation)
    )
    expect((await challengeState(source, digest)).resolved).to.equal(true)
  })

  it("leaves unauthorized spends actionable; the timeout terminates the wallet and refunds the challenger", async () => {
    const victim = targets[0]
    await w.fund(victim, 200000)
    const theft = transaction(
      [[(victim.main as Tx).hash, 0]],
      [{ value: 198000, script: p2tr(source.q) }]
    )
    const prevouts = [{ value: 199000, script: keyPath(victim) }]
    const digest = btcd(theft, 0, prevouts)
    await challenge(victim, digest)
    await expect(
      w.frost.defeatFrostFraudChallenge(
        defense(victim, theft, prevouts, AUTH.proven)
      )
    ).to.be.revertedWith("FROST defense proven transaction")
    await expect(
      w.frost.defeatFrostFraudChallenge(
        defense(victim, theft, prevouts, AUTH.movement)
      )
    ).to.be.revertedWith("FROST defense movement shape")
    await expect(
      w.frost.defeatFrostFraudChallenge(
        defense(victim, theft, prevouts, AUTH.intent)
      )
    ).to.be.revertedWith("FROST defense intent")
    // A proven transaction of another wallet does not authorize this one's
    // digest either: the challenged prevout must be this wallet's key path.
    await expect(
      w.frost.defeatFrostFraudChallenge(
        defense(source, theft, prevouts, AUTH.proven)
      )
    ).to.be.revertedWith("FROST defense key path")

    await expect(
      w.frost.notifyFrostFraudChallengeDefeatTimeout(victim.id, digest)
    ).to.be.revertedWith("FROST fraud defeat timeout")
    await advance(7 * 86400)
    const eligible = (await w.frost.frostMovementCounters(victim.id))
      .eligibleTargets
    const before = await ethers.provider.getBalance(challenger.address)
    await expect(
      w.frost.notifyFrostFraudChallengeDefeatTimeout(victim.id, digest)
    )
      .to.emit(w.frost, "FrostFraudChallengeDefeatTimedOut")
      .withArgs(victim.id, digest)
    expect(await ethers.provider.getBalance(challenger.address)).to.equal(
      before.add(BOND)
    )
    expect(await w.state(victim)).to.equal(State.Terminated)
    expect(
      (await w.frost.frostMovementCounters(victim.id)).eligibleTargets
    ).to.equal(eligible.sub(1))
    expect(await w.frost.frostOpenChallenges(victim.id)).to.equal(0)
    // Custody stays recorded; termination is not key or custody deletion.
    expect((await w.frost.frostWalletCustody(victim.id)).value).to.equal(199000)
    await expect(
      w.frost.notifyFrostFraudChallengeDefeatTimeout(victim.id, digest)
    ).to.be.revertedWith("FROST fraud challenge state")
  })

  it("defeats an authorized heartbeat in its own domain and refuses another nonce", async () => {
    const nonce = 0x0102030405060708n
    const digest = await w.frost.frostHeartbeatDigest(source.id, nonce)
    const nonceBytes = Buffer.alloc(8)
    nonceBytes.writeBigUInt64BE(nonce)
    expect(digest).to.equal(
      `0x${tagged(
        "tbtc-v2/frost-heartbeat/v1",
        Buffer.concat([raw(source.id), nonceBytes])
      ).toString("hex")}`
    )
    await challenge(source, digest)
    await expect(
      w.frost.defeatFrostFraudChallengeWithHeartbeat(source.id, nonce + 1n)
    ).to.be.revertedWith("FROST fraud challenge state")
    await w.frost.defeatFrostFraudChallengeWithHeartbeat(source.id, nonce)
    expect((await challengeState(source, digest)).resolved).to.equal(true)
  })

  it("accepts call value only with the fraud bond", async () => {
    const data = w.frost.interface.encodeFunctionData(
      "notifyFrostMovedFundsSweepTimeout",
      [ZERO]
    )
    await expect(
      w.owner.sendTransaction({ to: w.proxy.address, data, value: 1 })
    ).to.be.revertedWith("FROST call value")
  })
})
