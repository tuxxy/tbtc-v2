/* eslint-disable no-await-in-loop, no-restricted-syntax */
import { ethers } from "hardhat"
import fs from "fs"
import { expect } from "chai"
import {
  publicFundedFixture,
  bitcoinInfo,
  bitcoinProof,
  outpointKey,
} from "../helpers/frost-public-funding"
import { reservationProposal } from "../helpers/frost-reservation-proposal"
import { runCoreConflictingSweep } from "../helpers/frost-core-conflicting-sweep"
import { runCoreSettlement } from "../helpers/frost-core-settlement"
import { evidenceDirectory } from "../helpers/frost-test-isolation"

// Actual Core-valid mixed key/script-path conflict with public origin/Bank/SPV.
// Controlled registry, scalar3 and zero integer relay difficulty: no threshold
// or production canonical-chain/finality qualification is inferred.
describe("FROST actual Core sweep signed before redemption reservation", () => {
  const budgetVariants = [false, true]
  budgetVariants.forEach((withBudgets) => {
    it(`mines the archived sweep and resolves/refunds once${
      withBudgets ? " with two cancellation budgets" : ""
    }`, async () => {
      const evidence = evidenceDirectory(
        "sweep-conflict-core",
        process.env.FROST_C04_SWEEP_CONFLICT_EVIDENCE
      )
      const f = await publicFundedFixture({
        evidenceDirectory: `${evidence}/origin`,
      })
      const prepared = await runCoreConflictingSweep({
        coreWitness: f.coreWitness,
        input: f.custodyUTXO,
        outputDirectory: `${evidence}/prepare`,
      })
      expect(prepared.mempool.allowed).eq(true)
      await f.frost
        .connect(f.depositor)
        .revealFrostDeposit(
          prepared.terms,
          bitcoinInfo(prepared.funding.transaction),
          prepared.funding.index
        )
      const movement = Array.from(await f.bridge.movingFundsParameters())
      movement[1] = 500
      await f.bridge.updateMovingFundsParameters(...movement)
      await f.bridge.updateRedemptionParameters(
        3000,
        100,
        2000,
        2000,
        3600,
        0,
        0
      )
      await f.frost.configureFrostRedemptions(
        f.genesis,
        2,
        1000,
        ethers.constants.AddressZero,
        ethers.utils.id("UNQUALIFIED local D08 conflict witness")
      )
      await f.frost.setFrostRedemptionsEnabled(true)
      await f.bank.connect(f.depositor).approveBalance(f.frost.address, 20000)
      const caller = f.frost.connect(f.depositor)
      const script = `0x0014${"11".repeat(20)}`
      const id = await caller.callStatic.requestFrostRedemption(
        f.walletId,
        script,
        20000,
        f.depositor.address
      )
      await caller.requestFrostRedemption(
        f.walletId,
        script,
        20000,
        f.depositor.address
      )
      const beforeCustody = await f.frost.frostWalletCustody(f.walletId)
      const proposal = await reservationProposal({
        bridge: f.frost.address,
        chainId: f.descriptor.chainId,
        walletId: f.walletId,
        descriptorHash: f.descriptorHash,
        genesis: f.genesis,
        outputKey: f.descriptor.outputKey,
        generation: beforeCustody.generation.add(1),
        stateVersion: beforeCustody.stateVersion,
        validUntilBlock: (await ethers.provider.getBlockNumber()) + 100,
        inputs: [f.custodyUTXO],
        requests: [{ id, value: 18800, script }],
        fee: 1000,
        operators: f.operators,
      })
      const reservationId = await f.frost.callStatic.reserveFrostRedemption(
        proposal
      )
      await f.frost.reserveFrostRedemption(proposal)
      const original = await f.frost.frostReservation(reservationId)
      await expect(f.frost.refundResolvedFrostRedemption(id)).revertedWith(
        "FROST resolved refund state"
      )
      const cancellationHashes: string[] = []
      if (withBudgets) {
        const validator = await (
          await ethers.getContractFactory("FrostRedemptionTransactionFixture")
        ).deploy()
        for (const fee of [1000, 1500]) {
          const change = Buffer.alloc(8)
          change.writeBigUInt64LE(
            BigInt(f.custodyUTXO.txOutputValue.toString()) - BigInt(fee)
          )
          const transaction = {
            ...proposal.transaction,
            outputVector: `0x01${change.toString(
              "hex"
            )}225120${f.descriptor.outputKey.slice(2)}`,
          }
          const checked = await validator.validateCancellation(
            transaction,
            f.descriptor.outputKey,
            [f.custodyUTXO]
          )
          const authorization = {
            reservationId,
            snapshot: checked.snapshot,
            transactionHash: checked.txHash,
            fee,
            validUntilBlock: (await ethers.provider.getBlockNumber()) + 100,
          }
          const message = ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
              [
                "bytes32",
                "uint256",
                "address",
                "tuple(bytes32 reservationId,bytes32 snapshot,bytes32 transactionHash,uint64 fee,uint64 validUntilBlock)",
              ],
              [
                ethers.utils.id("tbtc-v2/frost-reservation-cancellation/v1"),
                f.descriptor.chainId,
                f.frost.address,
                authorization,
              ]
            )
          )
          const signed = ethers.utils.hexConcat(
            await Promise.all(
              f.operators
                .slice(0, 2)
                .map((signer) =>
                  signer.signMessage(ethers.utils.arrayify(message))
                )
            )
          )
          const sponsor = fee === 1000 ? f.treasury : f.depositor
          await f.bank.connect(sponsor).approveBalance(f.frost.address, fee)
          await f.frost
            .connect(sponsor)
            .authorizeFrostCancellation(
              authorization,
              transaction,
              [1, 2],
              signed
            )
          cancellationHashes.push(checked.txHash)
        }
      }
      const payment = await runCoreSettlement({
        coreWitness: f.coreWitness,
        input: f.custodyUTXO,
        transaction: proposal.transaction,
        outputDirectory: `${evidence}/competing-payment`,
      })
      expect(payment.mempool.allowed).eq(true)
      const mined = await runCoreConflictingSweep({
        coreWitness: f.coreWitness,
        input: f.custodyUTXO,
        prepared,
        competingRaw: payment.raw,
        outputDirectory: `${evidence}/mine`,
      })
      expect(mined.raw).eq(prepared.raw)
      const sweep = {
        walletId: f.walletId,
        transaction: bitcoinInfo(mined.transaction),
        proof: bitcoinProof(mined.proof),
        includeMain: true,
        vault: ethers.constants.AddressZero,
      }
      await expect(f.frost.submitFrostDepositSweepProof(sweep)).revertedWith(
        "FROST sweep main reserved"
      )
      const authorization = {
        reservationId,
        transactionHash: mined.txHash,
        vault: sweep.vault,
        validUntilBlock: (await ethers.provider.getBlockNumber()) + 100,
      }
      const digest = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          [
            "bytes32",
            "uint256",
            "address",
            "tuple(bytes32 reservationId,bytes32 transactionHash,address vault,uint64 validUntilBlock)",
          ],
          [
            ethers.utils.id("tbtc-v2/frost-reservation-sweep-resolution/v1"),
            f.descriptor.chainId,
            f.frost.address,
            authorization,
          ]
        )
      )
      const signatures = ethers.utils.hexConcat(
        await Promise.all(
          [f.operators[1], f.operators[2]].map((s) =>
            s.signMessage(ethers.utils.arrayify(digest))
          )
        )
      )
      const resolution = { sweep, authorization, seats: [2, 3], signatures }
      const submitted = await f.frost.submitFrostSweepResolutionProof(
        resolution
      )
      const receipt = await submitted.wait()
      const archivedTransaction = await ethers.provider.getTransaction(
        receipt.transactionHash
      )
      const canonicalBlock = await ethers.provider.getBlock(receipt.blockNumber)
      expect(canonicalBlock.hash).eq(receipt.blockHash)
      const archived = f.frost.interface.decodeFunctionData(
        "submitFrostSweepResolutionProof",
        archivedTransaction.data
      )[0]
      expect(archived.signatures).eq(signatures)
      expect(archived.authorization.transactionHash).eq(mined.txHash)
      const eventInterface = new ethers.utils.Interface([
        "event FrostSweepResolutionApproved(bytes32 indexed reservationId,bytes32 indexed transactionHash,address vault,uint64 validUntilBlock,uint16[] seats,bytes signatures)",
      ])
      const event = receipt.logs.filter(
        (log: any) =>
          log.topics[0] ===
          eventInterface.getEventTopic("FrostSweepResolutionApproved")
      )
      expect(event.length).eq(1)
      const fullCertificate = eventInterface.parseLog(event[0]).args
      expect(fullCertificate.signatures).eq(signatures)
      expect(fullCertificate.vault).eq(authorization.vault)
      expect(fullCertificate.validUntilBlock).eq(authorization.validUntilBlock)
      fs.writeFileSync(
        `${evidence}/resolution-archive.json`,
        JSON.stringify(
          {
            scope:
              "Local canonical calldata/receipt retrieval; not a production archive availability guarantee",
            transaction: archivedTransaction,
            receipt,
            canonicalBlock,
            authorization,
            seats: [2, 3],
            signatures,
            authorizationDigest: digest,
          },
          null,
          2
        )
      )
      if (withBudgets) {
        expect(await f.bank.balanceOf(f.frost.address)).eq(21500)
        expect(await f.bank.balanceOf(f.depositor.address)).eq(174500)
        expect(
          (
            await f.frost.frostCancellationAlternative(
              reservationId,
              cancellationHashes[0]
            )
          ).budgetSettled
        ).eq(true)
        expect(
          (
            await f.frost.frostCancellationAlternative(
              reservationId,
              cancellationHashes[1]
            )
          ).budgetSettled
        ).eq(false)
        await expect(
          f.frost.claimFrostCancellationBudget(
            reservationId,
            cancellationHashes[0]
          )
        ).reverted
        await f.frost
          .connect(f.operators[2])
          .claimFrostCancellationBudget(reservationId, cancellationHashes[1])
        await expect(
          f.frost.claimFrostCancellationBudget(
            reservationId,
            cancellationHashes[1]
          )
        ).reverted
        expect(
          (
            await f.frost.frostCancellationAlternative(
              reservationId,
              cancellationHashes[1]
            )
          ).budgetSettled
        ).eq(true)
      }
      // Confirmed conflict permits collection; escrow remains whole until paid.
      expect((await f.frost.frostRedemptionRequest(id)).state).eq(6)
      expect((await f.frost.frostRedemptionEscrow(f.walletId))[0]).eq(20000)
      expect((await f.frost.frostRedemptionEscrow(f.walletId))[1]).eq(19800)
      expect(await f.bank.balanceOf(f.frost.address)).eq(20000)
      expect(await f.bank.balanceOf(f.depositor.address)).eq(176000)
      await f.frost.connect(f.treasury).refundResolvedFrostRedemption(id)
      const result = await f.frost.frostReservation(reservationId)
      expect(result.state).eq(6)
      expect(result.transactionHash).eq(original.transactionHash)
      expect(result.snapshot).eq(original.snapshot)
      expect(result.signatures).eq(original.signatures)
      expect(result.sweepResolutionHash).eq(mined.txHash)
      expect(result.sweepResolutionSignaturesHash).eq(
        ethers.utils.keccak256(signatures)
      )
      expect(result.sweepResolutionAuthorizationHash).eq(digest)
      expect(result.sweepResolutionSeats.map((x: any) => Number(x))).deep.eq([
        2, 3,
      ])
      expect((await f.frost.frostRedemptionRequest(id)).state).eq(5)
      const custody = await f.frost.frostWalletCustody(f.walletId)
      expect(custody.mainOutpoint).eq(outpointKey(mined.txHash, 0))
      expect(custody.activeReservation).eq(ethers.constants.HashZero)
      expect(custody.value).eq(198000)
      expect(custody.stateVersion).eq(beforeCustody.stateVersion.add(1))
      expect(await f.bank.balanceOf(f.depositor.address)).eq(196000)
      expect(await f.bank.balanceOf(f.treasury.address)).eq(2000)
      expect(await f.bank.balanceOf(f.frost.address)).eq(0)
      const escrow = await f.frost.frostRedemptionEscrow(f.walletId)
      expect(escrow[0]).eq(0)
      expect(escrow[1]).eq(0)
      expect(
        (await f.frost.frostCustodyOutput(outpointKey(f.custodyUTXO.txHash, 0)))
          .spent
      ).eq(true)
      const frame = async () =>
        JSON.stringify(
          await Promise.all([
            f.frost.frostReservation(reservationId),
            f.frost.frostWalletCustody(f.walletId),
            f.frost.frostRedemptionEscrow(f.walletId),
            f.frost.frostRedemptionRequest(id),
            f.bank.balanceOf(f.depositor.address),
            f.bank.balanceOf(f.treasury.address),
            f.bank.balanceOf(f.frost.address),
          ])
        )
      const frozen = await frame()
      await expect(f.frost.refundResolvedFrostRedemption(id)).revertedWith(
        "FROST resolved refund state"
      )
      expect(await frame()).eq(frozen)
      await expect(
        f.frost.submitFrostSweepResolutionProof(resolution)
      ).revertedWith("FROST sweep resolution conflict")
      expect(await frame()).eq(frozen)
      await expect(
        f.frost.submitFrostRedemptionProof(
          reservationId,
          proposal.transaction,
          bitcoinProof(payment.proof)
        )
      ).revertedWith("FROST payment intent state")
      expect(await frame()).eq(frozen)
    })
  })
})
