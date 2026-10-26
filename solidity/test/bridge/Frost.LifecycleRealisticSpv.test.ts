/* eslint-disable no-await-in-loop */
// Actual retained mainnet Taproot transaction and retarget-crossing PoW,
// assembled by keep-core's real FROST maintainer and Bitcoin proof assembler.
// Custody origin/lifecycle and relay epoch publication are controlled adapters:
// this qualifies proof composition, not a mainnet wallet or canonical relay.
import { ethers } from "hardhat"
import { expect } from "chai"
import { readFileSync } from "fs"
import { createHash } from "crypto"
import {
  movementWorld,
  deploy,
  outpoint,
  State,
  World,
  Wallet,
  ZERO,
} from "../helpers/frost-movement-world"

describe("K-09 actual FROST producer to full Bridge proof consumer", () => {
  let w: World
  let source: Wallet
  let target: Wallet
  let produced: any
  let main: string
  let txHash: string
  let relay: any
  const digest = (value: Buffer) => createHash("sha256").update(value).digest()
  const proven = async () =>
    ethers.provider.getStorageAt(
      w.proxy.address,
      ethers.utils.hexZeroPad(
        w
          .entry(
            w.child(w.child(w.self, "frostFraud"), "provenTransactions"),
            txHash
          )
          .slot.toHexString(),
        32
      )
    )
  const frame = async () => ({
    source: await w.frost.frostWalletCustody(source.id),
    target: await w.frost.frostWalletCustody(target.id),
    sourceState: await w.state(source),
    targetState: await w.state(target),
    commitment: await w.commitment(source),
    counters: await w.frost.frostMovementCounters(target.id),
    bank: await w.bank.balanceOf(w.depositor.address),
    incoming: await w.readField(
      w.child(
        w.entry(w.child(w.movementNode(), "incoming"), outpoint(txHash)),
        "state"
      )
    ),
    spent: await w.readField(w.entry(w.child(w.self, "spentMainUTXOs"), main)),
    proven: await proven(),
  })
  const prove = (proof = produced.proof) =>
    w.frost.submitFrostMovingFundsProof(source.id, produced.transaction, proof)

  beforeEach(async () => {
    const path = process.env.FROST_K09_REALISTIC_PROOF_PRIVATE
    if (!path) throw Error("required fresh Go FROST producer proof is missing")
    produced = JSON.parse(readFileSync(path, "utf8"))
    const vector = readFileSync("test/data/k09-taproot-retarget.json")
    expect(digest(vector).toString("hex")).to.equal(produced.vectorSha256)
    expect(produced.factor).to.equal(6)
    expect(produced.headerCount).to.equal(6)
    expect(produced.proof.bitcoinHeaders.length).to.equal(2 + 6 * 160)
    relay = await deploy("SystemTestRelay")
    await relay.setCurrentEpochDifficulty(produced.currentDifficulty)
    await relay.setPrevEpochDifficulty(produced.previousDifficulty)
    w = await movementWorld(2, {
      keys: [produced.sourceKey, produced.targetKey],
      relay: relay.address,
      factor: produced.factor,
    })
    ;[source, target] = w.wallets
    main = outpoint(produced.inputTransactionHash, produced.inputIndex)
    const custody = w.child(w.self, "frostCustody")
    const wallet = w.entry(w.child(custody, "wallets"), source.id)
    const output = w.entry(w.child(custody, "outputs"), main)
    // Explicit controlled pre-state for the publicly retained parent output.
    await w.writeField(w.child(wallet, "mainOutpoint"), main)
    await w.writeField(w.child(wallet, "value"), produced.inputValue)
    await w.writeField(w.child(wallet, "stateVersion"), 1)
    await w.writeField(w.child(output, "walletId"), source.id)
    await w.writeField(w.child(output, "value"), produced.inputValue)
    await w.setState(source, State.Live)
    await w.enterMovingFunds(source)
    // Local test cap covers the actual 9,702-satoshi fee; production fee
    // policy remains an owner decision.
    await w.bridge.updateMovingFundsParameters(
      20000,
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
    await w.frost
      .connect(w.operator)
      .submitFrostMovingFundsCommitment(source.id, 0, [target.label])
    const tx = produced.transaction
    txHash = `0x${digest(
      digest(
        Buffer.from(
          [tx.version, tx.inputVector, tx.outputVector, tx.locktime]
            .map((x: string) => x.slice(2))
            .join(""),
          "hex"
        )
      )
    ).toString("hex")}`
  })

  it("rejects five real headers without changing Bridge state", async () => {
    const before = await frame()
    await expect(
      prove({
        ...produced.proof,
        bitcoinHeaders: produced.proof.bitcoinHeaders.slice(0, 2 + 5 * 160),
      })
    ).to.be.revertedWith("Insufficient accumulated difficulty in header chain")
    expect(await frame()).to.deep.equal(before)
  })

  it("rejects invalid transaction inclusion without changing Bridge state", async () => {
    const before = await frame()
    const bytes = ethers.utils.arrayify(produced.proof.merkleProof)
    bytes[0] = (bytes[0] + 1) % 256
    await expect(
      prove({ ...produced.proof, merkleProof: ethers.utils.hexlify(bytes) })
    ).to.be.revertedWith(
      "Tx merkle proof is not valid for provided header and tx hash"
    )
    expect(await frame()).to.deep.equal(before)
  })

  it("rejects headers outside the observed relay epochs without changing Bridge state", async () => {
    await relay.setCurrentEpochDifficulty(2)
    await relay.setPrevEpochDifficulty(3)
    const before = await frame()
    await expect(prove()).to.be.revertedWith(
      "Not at current or previous difficulty"
    )
    expect(await frame()).to.deep.equal(before)
  })

  it("rejects valid inclusion against inconsistent custody without changing Bridge state", async () => {
    const wallet = w.entry(
      w.child(w.child(w.self, "frostCustody"), "wallets"),
      source.id
    )
    await w.writeField(
      w.child(wallet, "mainOutpoint"),
      ethers.utils.id("controlled custody mismatch")
    )
    const before = await frame()
    await expect(prove()).to.be.revertedWith("FROST movement input")
    expect(await frame()).to.deep.equal(before)
  })

  it("accepts the exact Go producer proof across the retarget and refuses replay", async () => {
    await prove()
    expect(await w.state(source)).to.equal(State.Closing)
    const custody = await w.frost.frostWalletCustody(source.id)
    expect(custody.mainOutpoint).to.equal(ZERO)
    expect(custody.value).to.equal(0)
    const incoming = w.entry(
      w.child(w.movementNode(), "incoming"),
      outpoint(txHash)
    )
    expect(await w.readField(w.child(incoming, "value"))).to.equal(
      produced.outputValue
    )
    expect(await w.readField(w.child(incoming, "state"))).to.equal(1)
    expect(
      (await w.frost.frostMovementCounters(target.id)).pendingIncoming
    ).to.equal(1)
    expect(
      await w.readField(w.entry(w.child(w.self, "spentMainUTXOs"), main))
    ).to.equal(1)
    expect(await proven()).to.equal(source.id)
    const before = await frame()
    await expect(prove()).to.be.revertedWith("FROST movement commitment")
    expect(await frame()).to.deep.equal(before)
  })
})
