/* eslint-disable no-await-in-loop, no-restricted-syntax */
import { ethers } from "hardhat"
import { expect } from "chai"
import fs from "fs"
import {
  publicFundedFixture,
  bitcoinProof,
} from "../helpers/frost-public-funding"
import { reservationProposal } from "../helpers/frost-reservation-proposal"
import { runCoreSettlement } from "../helpers/frost-core-settlement"

describe("FROST maximum public proof-funded redemption batch", () => {
  it("admits and settles 64 real escrowed requests and rejects 65 distinct requests atomically", async () => {
    const evidence =
      process.env.FROST_C04_MAXIMUM_EVIDENCE ||
      // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
      require("../helpers/frost-test-isolation").evidenceDirectory(
        "maximum-public-batch"
      )
    const f = await publicFundedFixture({
      evidenceDirectory: `${evidence}/origin`,
      depositAmount: 1200000,
    })
    const movement = Array.from(await f.bridge.movingFundsParameters())
    movement[1] = 500
    await f.bridge.updateMovingFundsParameters(...movement)
    await f.bridge.updateRedemptionParameters(
      3000,
      100,
      2000,
      20000,
      3600,
      0,
      0
    )
    await f.frost.configureFrostRedemptions(
      f.genesis,
      2,
      1000,
      ethers.constants.AddressZero,
      ethers.utils.id("UNQUALIFIED local D08 reference")
    )
    await f.frost.setFrostRedemptionsEnabled(true)
    expect(await f.bank.balanceOf(f.depositor.address)).eq(1187000)
    await f.bank.connect(f.depositor).approveBalance(f.frost.address, 195000)
    const caller = f.frost.connect(f.depositor)
    const script = `0x0020${"11".repeat(32)}`
    const requests: { id: string; value: number; script: string }[] = []
    for (let i = 0; i < 65; i++) {
      const id = await caller.callStatic.requestFrostRedemption(
        f.walletId,
        script,
        3000,
        f.depositor.address
      )
      await caller.requestFrostRedemption(
        f.walletId,
        script,
        3000,
        f.depositor.address
      )
      // 63*234 + 258 = 15,000 sat; the 65th request is genuinely funded.
      requests.push({ id, value: i === 63 ? 2712 : 2736, script })
    }
    const custody = await f.frost.frostWalletCustody(f.walletId)
    const proposal = await reservationProposal({
      bridge: f.frost.address,
      chainId: (await ethers.provider.getNetwork()).chainId,
      walletId: f.walletId,
      descriptorHash: f.descriptorHash,
      genesis: f.genesis,
      outputKey: f.descriptor.outputKey,
      generation: custody.generation.add(1),
      stateVersion: custody.stateVersion,
      validUntilBlock: (await ethers.provider.getBlockNumber()) + 100,
      inputs: [f.custodyUTXO],
      requests: requests.slice(0, 64),
      fee: 15000,
      maximumFee: 20000,
      operators: f.operators,
    })
    const before = JSON.stringify(
      await Promise.all([
        f.frost.frostWalletCustody(f.walletId),
        f.frost.frostRedemptionEscrow(f.walletId),
        f.frost.frostRedemptionRequest(requests[0].id),
        f.frost.frostRedemptionRequest(requests[64].id),
        f.bank.balanceOf(f.depositor.address),
        f.bank.balanceOf(f.frost.address),
        f.bank.allowance(f.depositor.address, f.frost.address),
      ])
    )
    await expect(
      f.frost.reserveFrostRedemption(
        {
          ...proposal,
          requests,
        },
        { gasLimit: 16777216 }
      )
    ).revertedWith("FROST payee count")
    const after = JSON.stringify(
      await Promise.all([
        f.frost.frostWalletCustody(f.walletId),
        f.frost.frostRedemptionEscrow(f.walletId),
        f.frost.frostRedemptionRequest(requests[0].id),
        f.frost.frostRedemptionRequest(requests[64].id),
        f.bank.balanceOf(f.depositor.address),
        f.bank.balanceOf(f.frost.address),
        f.bank.allowance(f.depositor.address, f.frost.address),
      ])
    )
    expect(after).eq(before)
    const reservationId = await f.frost.callStatic.reserveFrostRedemption(
      proposal,
      { gasLimit: 16777216 }
    )
    const admission = await (
      await f.frost.reserveFrostRedemption(proposal, { gasLimit: 16777216 })
    ).wait()
    expect(
      (await f.frost.frostReservation(reservationId)).requestIds.length
    ).eq(64)
    const payment = await runCoreSettlement({
      coreWitness: f.coreWitness,
      input: f.custodyUTXO,
      transaction: proposal.transaction,
      outputDirectory: `${evidence}/payment`,
    })
    const settlement = await (
      await f.frost.submitFrostRedemptionProof(
        reservationId,
        proposal.transaction,
        bitcoinProof(payment.proof),
        { gasLimit: 16777216 }
      )
    ).wait()
    expect(await f.bank.balanceOf(f.depositor.address)).eq(992000)
    expect(await f.bank.balanceOf(f.treasury.address)).eq(13920)
    expect(await f.bank.balanceOf(f.frost.address)).eq(3000)
    expect((await f.frost.frostWalletCustody(f.walletId)).value).eq(1008920)
    expect((await f.frost.frostRedemptionEscrow(f.walletId)).gross).eq(3000)
    for (const request of requests.slice(0, 64))
      expect((await f.frost.frostRedemptionRequest(request.id)).state).eq(4)
    expect((await f.frost.frostRedemptionRequest(requests[64].id)).state).eq(1)
    expect(admission.gasUsed.lt(16777216)).eq(true)
    expect(settlement.gasUsed.lt(16777216)).eq(true)
    fs.writeFileSync(
      `${evidence}/result.json`,
      JSON.stringify(
        {
          requests: 64,
          rejectedDistinctRequests: 65,
          outputs: 65,
          transactionGasCap: 16777216,
          bitcoinFee: 15000,
          admissionGas: admission.gasUsed.toString(),
          settlementGas: settlement.gasUsed.toString(),
          localBlockGasLimit: 30000000,
          bankTotal: 1008920,
          custody: 1008920,
          productionGasBudgetQualified: false,
          boundaries:
            "controlled readiness, known scalar3, regtest difficulty0; no G-F qualification",
        },
        null,
        2
      )
    )
  })
})
