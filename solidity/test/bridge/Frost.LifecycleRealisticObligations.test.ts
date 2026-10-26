/* eslint-disable no-await-in-loop */
import { ethers } from "hardhat"
import { expect } from "chai"
import { readFileSync } from "fs"
import { createHash } from "crypto"
import {
  movementWorld,
  deploy,
  outpoint,
  State,
} from "../helpers/frost-movement-world"
import { reservationProposal } from "../helpers/frost-reservation-proposal"

// Proof-boundary witnesses: historical transactions/parents and mainnet work
// are real. Prior funding/admission, descriptor ownership and relay publication
// are explicit controlled state, not a historical FROST deposit or DKG claim.
describe("K-09 realistic FROST sweep and redemption proof boundaries", () => {
  const read = (name: string, vector: string) => {
    const path = process.env[name]
    if (!path) throw Error(`Required Go proof handoff missing: ${name}`)
    const p = JSON.parse(readFileSync(path, "utf8"))
    expect(createHash("sha256").update(readFileSync(vector)).digest("hex")).eq(
      p.vectorSha256
    )
    expect(p.factor).eq(6)
    expect(p.headerCount).eq(6)
    return p
  }
  const world = async (p: any, q: string) => {
    const relay = await deploy("SystemTestRelay")
    await relay.setCurrentEpochDifficulty(p.currentDifficulty)
    await relay.setPrevEpochDifficulty(p.previousDifficulty)
    return movementWorld(1, { keys: [q], relay: relay.address, factor: 6 })
  }
  const short = (p: any) => ({
    ...p.proof,
    bitcoinHeaders: p.proof.bitcoinHeaders.slice(0, 2 + 5 * 160),
  })

  it("feeds the actual sweep producer into full Bridge credit, refuses short work and replay", async () => {
    const p = read(
      "FROST_K09_REALISTIC_SWEEP_PRIVATE",
      "test/data/k09-taproot-retarget.json"
    )
    const w = await world(p, `0x${p.outputs[0].script.slice(6)}`)
    const wallet = w.wallets[0]
    expect(wallet.id).eq(p.walletId)
    const funding = w.child(w.self, "frostFunding")
    const key = outpoint(p.inputTransactionHash, p.inputIndex)
    const record = w.entry(w.child(funding, "deposits"), key)
    const terms = w.child(record, "terms")
    for (const [field, value] of Object.entries({
      fullWalletId: wallet.id,
      depositor: w.depositor.address,
      amount: p.inputValue,
    }))
      await w.writeField(w.child(terms, field), value as any)
    for (const [field, value] of Object.entries({
      fundingTransactionHash: p.inputTransactionHash,
      fundingOutputIndex: p.inputIndex,
      depositOutputKey: `0x${p.inputScript.slice(6)}`,
      walletKey: wallet.q,
      maximumSweepFee: p.inputValue - p.outputs[0].value,
      revealedAt: 1,
    }))
      await w.writeField(w.child(record, field), value as any)
    await w.writeField(
      w.entry(w.child(funding, "pendingReveals"), wallet.id),
      1
    )
    const request = {
      walletId: wallet.id,
      transaction: p.transaction,
      proof: p.proof,
      includeMain: false,
      vault: ethers.constants.AddressZero,
    }
    const frame = async () =>
      JSON.stringify([
        await w.frost.frostWalletCustody(wallet.id),
        await w.frost.frostDeposit(key),
        await w.bank.balanceOf(w.depositor.address),
        await w.bank.balanceOf(w.treasury.address),
      ])
    const before = await frame()
    await expect(
      w.frost.submitFrostDepositSweepProof({ ...request, proof: short(p) })
    ).revertedWith("Insufficient accumulated difficulty in header chain")
    expect(await frame()).eq(before)
    await w.frost.submitFrostDepositSweepProof(request)
    expect(await w.bank.balanceOf(w.depositor.address)).eq(p.outputs[0].value)
    expect((await w.frost.frostWalletCustody(wallet.id)).value).eq(
      p.outputs[0].value
    )
    const after = await frame()
    await expect(w.frost.submitFrostDepositSweepProof(request)).revertedWith(
      "FROST sweep main required"
    )
    expect(await frame()).eq(after)
  })

  it("feeds the actual redemption producer into full Bridge settlement, refuses short work and replay", async () => {
    const p = read(
      "FROST_K09_REALISTIC_REDEMPTION_PRIVATE",
      "test/data/k09-redemption-retarget.json"
    )
    const w = await world(p, `0x${p.inputScript.slice(6)}`)
    const wallet = w.wallets[0]
    expect(wallet.id).eq(p.walletId)
    const custody = w.child(w.self, "frostCustody")
    const main = outpoint(p.inputTransactionHash, p.inputIndex)
    const balance = w.entry(w.child(custody, "wallets"), wallet.id)
    const output = w.entry(w.child(custody, "outputs"), main)
    await w.writeField(w.child(balance, "mainOutpoint"), main)
    await w.writeField(w.child(balance, "value"), p.inputValue)
    await w.writeField(w.child(balance, "stateVersion"), 1)
    await w.writeField(w.child(output, "walletId"), wallet.id)
    await w.writeField(w.child(output, "value"), p.inputValue)
    await w.setState(wallet, State.Live)
    // Controlled prior Bank funding; admission and settlement use public calls.
    await w.bank.updateBridge(w.owner.address)
    await w.bank.increaseBalance(w.depositor.address, p.inputValue)
    await w.bank.updateBridge(w.proxy.address)
    await w.bridge.updateRedemptionParameters(30000, 0, 20000, 20000, 3600, 0, 0)
    const genesis = ethers.utils.id("C06 synthetic regtest domain")
    await w.frost.configureFrostRedemptions(
      genesis,
      2,
      1000,
      ethers.constants.AddressZero,
      ethers.utils.id("K09 proof-boundary admission")
    )
    await w.frost.setFrostRedemptionsEnabled(true)
    const fee =
      p.inputValue - p.outputs.reduce((sum: number, o: any) => sum + o.value, 0)
    const gross = p.outputs[0].value + fee
    await w.bank.connect(w.depositor).approveBalance(w.proxy.address, gross)
    const caller = w.frost.connect(w.depositor)
    const id = await caller.callStatic.requestFrostRedemption(
      wallet.id,
      p.outputs[0].script,
      gross,
      w.depositor.address
    )
    await caller.requestFrostRedemption(
      wallet.id,
      p.outputs[0].script,
      gross,
      w.depositor.address
    )
    const proposal = await reservationProposal({
      bridge: w.proxy.address,
      chainId: (await ethers.provider.getNetwork()).chainId,
      walletId: wallet.id,
      descriptorHash: wallet.descriptorHash,
      genesis,
      outputKey: wallet.q,
      generation: 1,
      stateVersion: 1,
      validUntilBlock: (await ethers.provider.getBlockNumber()) + 100,
      inputs: [
        {
          txHash: p.inputTransactionHash,
          txOutputIndex: p.inputIndex,
          txOutputValue: p.inputValue,
        },
      ],
      requests: [
        { id, value: p.outputs[0].value, script: p.outputs[0].script },
      ],
      fee,
      minimumFee: 1,
      maximumFee: 20000,
      maximumSatPerVByte: 1000,
      operators: [w.operator, w.owner],
    })
    expect(proposal.transaction).deep.eq(p.transaction)
    const reservation = await w.frost.callStatic.reserveFrostRedemption(
      proposal
    )
    await w.frost.reserveFrostRedemption(proposal)
    const frame = async () =>
      JSON.stringify([
        await w.frost.frostWalletCustody(wallet.id),
        await w.frost.frostReservation(reservation),
        await w.bank.balanceOf(w.proxy.address),
        await w.bank.balanceOf(w.depositor.address),
        await w.bank.balanceOf(w.treasury.address),
      ])
    const before = await frame()
    await expect(
      w.frost.submitFrostRedemptionProof(reservation, p.transaction, short(p))
    ).revertedWith("Insufficient accumulated difficulty in header chain")
    expect(await frame()).eq(before)
    await w.frost.submitFrostRedemptionProof(
      reservation,
      p.transaction,
      p.proof
    )
    expect((await w.frost.frostWalletCustody(wallet.id)).value).eq(
      p.outputs[1].value
    )
    expect(await w.bank.balanceOf(w.proxy.address)).eq(0)
    const after = await frame()
    await expect(
      w.frost.submitFrostRedemptionProof(reservation, p.transaction, p.proof)
    ).revertedWith("FROST payment intent state")
    expect(await frame()).eq(after)
  })
})
