/* eslint-disable no-await-in-loop */
import { ethers } from "hardhat"
import { expect } from "chai"
import {
  publicFundedFixture,
  bitcoinProof,
  outpointKey,
} from "../helpers/frost-public-funding"

describe("FROST public SPV maintainer authorization", () => {
  it("gates funding, payment and cancellation through the actual funded Bridge", async () => {
    const f = await publicFundedFixture()
    const id = ethers.constants.HashZero
    const key = outpointKey(f.custodyUTXO.txHash, f.custodyUTXO.txOutputIndex)
    const frame = async () =>
      JSON.stringify(
        await Promise.all([
          f.bank.balanceOf(f.depositor.address),
          f.bank.balanceOf(f.treasury.address),
          f.bank.balanceOf(f.frost.address),
          f.bank.allowance(f.depositor.address, f.frost.address),
          f.frost.frostWalletCustody(f.walletId),
          f.frost.frostRedemptionEscrow(f.walletId),
          f.frost.frostReservation(id),
          f.frost.frostCustodyOutput(key),
          f.bridge.spentMainUTXOs(key),
        ])
      )
    const stranger = f.frost.connect(f.depositor)
    const before = await frame()
    await expect(stranger.submitFrostDepositSweepProof(f.sweep)).revertedWith(
      "Caller is not SPV maintainer"
    )
    expect(await frame()).eq(before)
    await expect(
      stranger.submitFrostRedemptionProof(
        id,
        f.sweep.transaction,
        bitcoinProof(f.coreWitness.sweep.proof)
      )
    ).revertedWith("Caller is not SPV maintainer")
    expect(await frame()).eq(before)
    await expect(
      stranger.submitFrostCancellationProof(
        id,
        f.sweep.transaction,
        bitcoinProof(f.coreWitness.sweep.proof)
      )
    ).revertedWith("Caller is not SPV maintainer")
    expect(await frame()).eq(before)
    await f.bridge.setSpvMaintainerStatus(f.depositor.address, true)
    await expect(stranger.submitFrostDepositSweepProof(f.sweep)).revertedWith(
      "FROST sweep main required"
    )
    expect(await frame()).eq(before)
    await f.bridge.setSpvMaintainerStatus(f.depositor.address, false)
    await expect(stranger.submitFrostDepositSweepProof(f.sweep)).revertedWith(
      "Caller is not SPV maintainer"
    )
    expect(await frame()).eq(before)
  })
})
