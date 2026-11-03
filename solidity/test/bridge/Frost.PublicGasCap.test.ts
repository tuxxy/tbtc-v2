/* eslint-disable no-await-in-loop, no-restricted-syntax */
import { ethers, network } from "hardhat"
import { expect } from "chai"
import fs from "fs"
import os from "os"
import path from "path"
import {
  publicFundedFixture,
  bitcoinProof,
} from "../helpers/frost-public-funding"
import { reservationProposal } from "../helpers/frost-reservation-proposal"
import { runCoreSettlement } from "../helpers/frost-core-settlement"

describe("FROST transaction gas cap measurement", () => {
  const count = Number(process.env.FROST_C04_GAS_REQUESTS || 64)
  const transactionGasCap = 16777216
  it("measures public admission, payment and cancellation under the transaction cap", async () => {
    const evidence =
      process.env.FROST_C04_GAS_EVIDENCE ||
      fs.mkdtempSync(path.join(os.tmpdir(), "c04-gas-cap-"))
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
    await f.bank
      .connect(f.depositor)
      .approveBalance(f.frost.address, 3000 * count)
    const caller = f.frost.connect(f.depositor)
    const script = `0x0020${"11".repeat(32)}`
    const requests: { id: string; value: number; script: string }[] = []
    for (let i = 0; i < count; i++) {
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
      // Allocate the fee deterministically, retaining each captured request cap.
      const fee =
        Math.floor(15000 / count) + (i === count - 1 ? 15000 % count : 0)
      requests.push({ id, value: 2970 - fee, script })
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
      requests,
      fee: 15000,
      maximumFee: 20000,
      operators: f.operators,
    })
    const reservationId = await f.frost.callStatic.reserveFrostRedemption(
      proposal,
      { gasLimit: transactionGasCap }
    )
    const admission = await (
      await f.frost.reserveFrostRedemption(proposal, {
        gasLimit: transactionGasCap,
      })
    ).wait()
    expect(
      (await f.frost.frostReservation(reservationId)).requestIds.length
    ).eq(count)
    const reservedSnapshot = await network.provider.send("evm_snapshot")
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
        { gasLimit: transactionGasCap }
      )
    ).wait()
    expect(await f.bank.balanceOf(f.depositor.address)).eq(
      1187000 - 3000 * count
    )
    expect(await f.bank.balanceOf(f.treasury.address)).eq(12000 + 30 * count)
    expect(await f.bank.balanceOf(f.frost.address)).eq(0)
    expect((await f.frost.frostWalletCustody(f.walletId)).value).eq(
      1199000 - 2970 * count
    )
    expect((await f.frost.frostRedemptionEscrow(f.walletId)).gross).eq(0)
    for (const request of requests)
      expect((await f.frost.frostRedemptionRequest(request.id)).state).eq(4)
    expect(admission.gasUsed.lt(transactionGasCap)).eq(true)
    expect(settlement.gasUsed.lt(transactionGasCap)).eq(true)
    await network.provider.send("evm_revert", [reservedSnapshot])
    const cancellationFee = 1000
    const change = 1199000 - cancellationFee
    const encodedValue = Buffer.alloc(8)
    encodedValue.writeBigUInt64LE(BigInt(change))
    const cancellationTransaction = {
      version: "0x02000000",
      inputVector: proposal.transaction.inputVector,
      outputVector: `0x01${encodedValue.toString(
        "hex"
      )}225120${f.descriptor.outputKey.slice(2)}`,
      locktime: "0x00000000",
    }
    const validator = await (
      await ethers.getContractFactory("FrostRedemptionTransactionFixture")
    ).deploy()
    const result = await validator.validateCancellation(
      cancellationTransaction,
      f.descriptor.outputKey,
      [f.custodyUTXO]
    )
    const authorization = {
      reservationId,
      snapshot: result.snapshot,
      transactionHash: result.txHash,
      fee: cancellationFee,
      validUntilBlock: (await ethers.provider.getBlockNumber()) + 100,
    }
    const digest = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        [
          "bytes32",
          "uint256",
          "address",
          "tuple(bytes32 reservationId,bytes32 snapshot,bytes32 transactionHash,uint64 fee,uint64 validUntilBlock)",
        ],
        [
          ethers.utils.id("tbtc-v2/frost-reservation-cancellation/v1"),
          (await ethers.provider.getNetwork()).chainId,
          f.frost.address,
          authorization,
        ]
      )
    )
    const signatures = ethers.utils.hexConcat(
      await Promise.all(
        f.operators
          .slice(0, 2)
          .map((operator) =>
            operator.signMessage(ethers.utils.arrayify(digest))
          )
      )
    )
    await f.bank
      .connect(f.treasury)
      .approveBalance(f.frost.address, cancellationFee)
    const cancellationAuthorization = await (
      await f.frost
        .connect(f.treasury)
        .authorizeFrostCancellation(
          authorization,
          cancellationTransaction,
          [1, 2],
          signatures,
          { gasLimit: transactionGasCap }
        )
    ).wait()
    const cancellation = await runCoreSettlement({
      coreWitness: f.coreWitness,
      input: f.custodyUTXO,
      transaction: cancellationTransaction,
      outputDirectory: `${evidence}/cancellation`,
      competingRaw: payment.raw,
    })
    expect(cancellation.conflictRejection?.allowed).eq(false)
    const cancellationSettlement = await (
      await f.frost.submitFrostCancellationProof(
        reservationId,
        cancellationTransaction,
        bitcoinProof(cancellation.proof),
        { gasLimit: transactionGasCap }
      )
    ).wait()
    expect(cancellationAuthorization.gasUsed.lt(transactionGasCap)).eq(true)
    expect(cancellationSettlement.gasUsed.lt(transactionGasCap)).eq(true)
    expect(await f.bank.balanceOf(f.depositor.address)).eq(1187000)
    expect(await f.bank.balanceOf(f.treasury.address)).eq(11000)
    expect(await f.bank.balanceOf(f.frost.address)).eq(0)
    expect((await f.frost.frostWalletCustody(f.walletId)).value).eq(change)
    expect((await f.frost.frostRedemptionEscrow(f.walletId)).gross).eq(0)
    for (const request of requests)
      expect((await f.frost.frostRedemptionRequest(request.id)).state).eq(5)
    const measurement = {
      requests: count,
      inputs: 1,
      transactionGasCap,
      admissionGas: admission.gasUsed.toString(),
      paymentGas: settlement.gasUsed.toString(),
      cancellationAuthorizationGas:
        cancellationAuthorization.gasUsed.toString(),
      cancellationGas: cancellationSettlement.gasUsed.toString(),
      productionJointMaximumQualified: false,
      boundaries:
        "controlled readiness, known scalar3, regtest difficulty0; joint maximum inputs not qualified",
    }
    fs.writeFileSync(
      `${evidence}/result.json`,
      JSON.stringify(measurement, null, 2)
    )
    console.log(JSON.stringify(measurement))
  })
})
