/* eslint-disable no-await-in-loop, no-restricted-syntax */
import { ethers, network } from "hardhat"
import { expect } from "chai"
import {
  publicFundedFixture,
  bitcoinProof,
  outpointKey,
} from "../helpers/frost-public-funding"
import { reservationProposal } from "../helpers/frost-reservation-proposal"
import {
  runCoreSettlement,
  TransactionInfo,
} from "../helpers/frost-core-settlement"

// Public financial lifecycle with actual Core inclusion. Controlled readiness,
// scalar-3 signing and zero regtest difficulty remain qualification boundaries.
describe("FROST public payment, quarantine and cancellation", () => {
  let f: Awaited<ReturnType<typeof publicFundedFixture>>
  let root: string
  let sequence = 0
  const evidence =
    process.env.FROST_C04_SETTLEMENT_EVIDENCE ||
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    require("../helpers/frost-test-isolation").evidenceDirectory(
      "public-settlement"
    )
  const script = `0x0014${"11".repeat(20)}`

  before(async () => {
    f = await publicFundedFixture({ evidenceDirectory: `${evidence}/origin` })
    const movement = Array.from(await f.bridge.movingFundsParameters())
    movement[1] = 500
    await f.bridge.updateMovingFundsParameters(...movement)
    await f.bridge.updateRedemptionParameters(3000, 100, 2000, 2000, 3600, 0, 0)
    await f.frost.configureFrostRedemptions(
      f.genesis,
      2,
      1000,
      ethers.constants.AddressZero,
      ethers.utils.id("UNQUALIFIED local D08 reference")
    )
    await f.frost.setFrostRedemptionsEnabled(true)
    root = await network.provider.send("evm_snapshot")
  })
  beforeEach(async () => {
    await network.provider.send("evm_revert", [root])
    root = await network.provider.send("evm_snapshot")
  })

  async function admitted(reserve = true) {
    await f.bank.connect(f.depositor).approveBalance(f.frost.address, 20000)
    const caller = f.frost.connect(f.depositor)
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
      requests: [{ id, value: 18800, script }],
      fee: 1000,
      operators: f.operators,
    })
    const reservationId = await f.frost.callStatic.reserveFrostRedemption(
      proposal
    )
    if (reserve) await f.frost.reserveFrostRedemption(proposal)
    return { id, proposal, reservationId }
  }

  async function mine(
    transaction: TransactionInfo,
    label: string,
    competingRaw?: string
  ) {
    sequence += 1
    return runCoreSettlement({
      coreWitness: f.coreWitness,
      input: f.custodyUTXO,
      transaction,
      outputDirectory: `${evidence}/${sequence}-${label}`,
      competingRaw,
    })
  }

  async function cancellation(reservationId: string) {
    // Same captured input, one exact-Q output: 99,000 - 1,000 sat fee.
    const transaction = {
      version: "0x02000000",
      inputVector: `0x01${f.custodyUTXO.txHash.slice(2)}0000000000fdffffff`,
      outputVector: `0x01d07e010000000000225120${f.descriptor.outputKey.slice(
        2
      )}`,
      locktime: "0x00000000",
    }
    const validator = await (
      await ethers.getContractFactory("FrostRedemptionTransactionFixture")
    ).deploy()
    const result = await validator.validateCancellation(
      transaction,
      f.descriptor.outputKey,
      [f.custodyUTXO]
    )
    expect(result.changeValue).eq(98000)
    const authorization = {
      reservationId,
      snapshot: result.snapshot,
      transactionHash: result.txHash,
      fee: 1000,
      validUntilBlock: (await ethers.provider.getBlockNumber()) + 100,
    }
    const tuple =
      "tuple(bytes32 reservationId,bytes32 snapshot,bytes32 transactionHash,uint64 fee,uint64 validUntilBlock)"
    const digest = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", "uint256", "address", tuple],
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
    // The sponsor budget comes from already proof-backed treasury Bank balance.
    await f.bank.connect(f.treasury).approveBalance(f.frost.address, 1000)
    await f.frost
      .connect(f.treasury)
      .authorizeFrostCancellation(
        authorization,
        transaction,
        [1, 2],
        signatures
      )
    return { transaction, authorization, signatures }
  }

  async function frame(id: string, reservationId: string) {
    return JSON.stringify(
      await Promise.all([
        f.bank.balanceOf(f.depositor.address),
        f.bank.balanceOf(f.treasury.address),
        f.bank.balanceOf(f.frost.address),
        f.bank.allowance(f.treasury.address, f.frost.address),
        f.frost.frostRedemptionRequest(id),
        f.frost.frostReservation(reservationId),
        f.frost.frostWalletCustody(f.walletId),
        f.frost.frostRedemptionEscrow(f.walletId),
        f.frost.frostCustodyOutput(
          outpointKey(f.custodyUTXO.txHash, f.custodyUTXO.txOutputIndex)
        ),
        f.bridge.spentMainUTXOs(
          outpointKey(f.custodyUTXO.txHash, f.custodyUTXO.txOutputIndex)
        ),
      ])
    )
  }

  it("settles a mined payment once, after certificate expiry, with the full financial equation", async () => {
    const a = await admitted()
    const payment = await mine(a.proposal.transaction, "payment")
    await network.provider.send("hardhat_mine", [ethers.utils.hexValue(101)])
    await f.frost.submitFrostRedemptionProof(
      a.reservationId,
      a.proposal.transaction,
      bitcoinProof(payment.proof)
    )
    expect(await f.bank.balanceOf(f.depositor.address)).eq(78000)
    expect(await f.bank.balanceOf(f.treasury.address)).eq(1200)
    expect(await f.bank.balanceOf(f.frost.address)).eq(0)
    expect((await f.frost.frostRedemptionEscrow(f.walletId)).gross).eq(0)
    const custody = await f.frost.frostWalletCustody(f.walletId)
    expect(custody.value).eq(79200)
    expect(custody.activeReservation).eq(ethers.constants.HashZero)
    expect(custody.stateVersion).eq(2)
    expect((await f.frost.frostCustodyOutput(custody.mainOutpoint)).value).eq(
      79200
    )
    expect(
      (await f.frost.frostCustodyOutput(outpointKey(f.custodyUTXO.txHash, 0)))
        .spent
    ).eq(true)
    expect(
      await f.bridge.spentMainUTXOs(outpointKey(f.custodyUTXO.txHash, 0))
    ).eq(true)
    expect((await f.frost.frostRedemptionRequest(a.id)).state).eq(4)
    const before = await frame(a.id, a.reservationId)
    await expect(
      f.frost.submitFrostRedemptionProof(
        a.reservationId,
        a.proposal.transaction,
        bitcoinProof(payment.proof)
      )
    ).revertedWith("FROST payment intent state")
    expect(await frame(a.id, a.reservationId)).eq(before)
  })

  it("serializes deadline admission and refunds an unreserved request only after captured finality", async () => {
    const a = await admitted(false)
    const request = await f.frost.frostRedemptionRequest(a.id)
    const initialCustody = await f.frost.frostWalletCustody(f.walletId)
    const before = await frame(a.id, a.reservationId)
    await expect(f.frost.notifyFrostRedemptionTimeout(a.id)).revertedWith(
      "FROST deadline not reached"
    )
    expect(await frame(a.id, a.reservationId)).eq(before)
    await network.provider.send("evm_setNextBlockTimestamp", [
      request.deadline.toNumber(),
    ])
    await expect(f.frost.reserveFrostRedemption(a.proposal)).revertedWith(
      "FROST request not reservable"
    )
    expect(await frame(a.id, a.reservationId)).eq(before)
    await f.frost.notifyFrostRedemptionTimeout(a.id)
    const pending = await frame(a.id, a.reservationId)
    await expect(
      f.frost.callStatic.refundUnreservedFrostRedemption(a.id)
    ).revertedWith("FROST timeout not final")
    expect(await frame(a.id, a.reservationId)).eq(pending)
    await network.provider.send("hardhat_mine", [
      ethers.utils.hexValue(request.finalityBlocks),
    ])
    await f.frost.callStatic.refundUnreservedFrostRedemption(a.id)
    await f.frost.refundUnreservedFrostRedemption(a.id)
    expect(await f.bank.balanceOf(f.depositor.address)).eq(98000)
    expect(await f.bank.balanceOf(f.treasury.address)).eq(1000)
    expect(await f.bank.balanceOf(f.frost.address)).eq(0)
    const escrow = await f.frost.frostRedemptionEscrow(f.walletId)
    expect(escrow.gross).eq(0)
    expect(escrow.netLiability).eq(0)
    expect(await f.frost.frostWalletCustody(f.walletId)).deep.eq(initialCustody)
    expect((await f.frost.frostRedemptionRequest(a.id)).state).eq(5)
    const refunded = await frame(a.id, a.reservationId)
    await expect(f.frost.refundUnreservedFrostRedemption(a.id)).reverted
    await expect(f.frost.reserveFrostRedemption(a.proposal)).reverted
    expect(await frame(a.id, a.reservationId)).eq(refunded)
  })

  it("quarantines timed-out reserved escrow and still permits proven original payment", async () => {
    const a = await admitted()
    const deadline = (
      await f.frost.frostRedemptionRequest(a.id)
    ).deadline.toNumber()
    await network.provider.send("evm_setNextBlockTimestamp", [deadline])
    await f.frost.notifyFrostRedemptionTimeout(a.id)
    expect((await f.frost.frostRedemptionRequest(a.id)).state).eq(3)
    expect(await f.bank.balanceOf(f.frost.address)).eq(20000)
    await network.provider.send("hardhat_mine", ["0x3"])
    const before = await frame(a.id, a.reservationId)
    await expect(f.frost.refundUnreservedFrostRedemption(a.id)).revertedWith(
      "FROST reservation retains escrow"
    )
    expect(await frame(a.id, a.reservationId)).eq(before)
    const payment = await mine(a.proposal.transaction, "late-payment")
    await f.frost.submitFrostRedemptionProof(
      a.reservationId,
      a.proposal.transaction,
      bitcoinProof(payment.proof)
    )
    expect((await f.frost.frostRedemptionRequest(a.id)).state).eq(4)
    expect(await f.bank.balanceOf(f.depositor.address)).eq(78000)
  })

  it("burns an independent proven cancellation budget and refunds full escrow once", async () => {
    const a = await admitted()
    const original = await mine(
      a.proposal.transaction,
      "original-competing-branch"
    )
    const c = await cancellation(a.reservationId)
    expect(await f.bank.balanceOf(f.frost.address)).eq(21000)
    expect(await f.bank.balanceOf(f.treasury.address)).eq(0)
    const cancelled = await mine(c.transaction, "cancellation", original.raw)
    expect(cancelled.conflictRejection?.allowed).eq(false)
    await f.frost.submitFrostCancellationProof(
      a.reservationId,
      c.transaction,
      bitcoinProof(cancelled.proof)
    )
    expect(await f.bank.balanceOf(f.depositor.address)).eq(98000)
    expect(await f.bank.balanceOf(f.treasury.address)).eq(0)
    expect(await f.bank.balanceOf(f.frost.address)).eq(0)
    expect((await f.frost.frostWalletCustody(f.walletId)).value).eq(98000)
    const intent = await f.frost.frostReservation(a.reservationId)
    expect(intent.state).eq(3)
    expect(intent.snapshot).eq(a.proposal.snapshot)
    expect(intent.cancellationSignatures).eq(c.signatures)
    expect(intent.cancellationValidUntilBlock).eq(
      c.authorization.validUntilBlock
    )
    expect(intent.requestIds).deep.eq([a.id])
    expect((await f.frost.frostRedemptionRequest(a.id)).state).eq(5)
    const before = await frame(a.id, a.reservationId)
    await expect(
      f.frost.submitFrostCancellationProof(
        a.reservationId,
        c.transaction,
        bitcoinProof(cancelled.proof)
      )
    ).revertedWith("FROST cancellation intent state")
    await expect(
      f.frost.submitFrostRedemptionProof(
        a.reservationId,
        a.proposal.transaction,
        bitcoinProof(original.proof)
      )
    ).revertedWith("FROST payment intent state")
    expect(await frame(a.id, a.reservationId)).eq(before)
  })

  it("records governance containment, preserves timeout quarantine and permits the original payment", async () => {
    const a = await admitted()
    const old = await f.frost.frostWalletCustody(f.walletId)
    const reason = ethers.utils.id("local availability containment")
    const evidenceHash = ethers.utils.id("local incident record")
    const receipt = await (
      await f.frost.quarantineFrostWallet(
        f.walletId,
        old.stateVersion,
        reason,
        evidenceHash
      )
    ).wait()
    const custody = await f.frost.frostWalletCustody(f.walletId)
    expect(custody.stateVersion).eq(old.stateVersion.add(1))
    expect(custody.generation).eq(old.generation)
    expect(custody.value).eq(old.value)
    expect(custody.mainOutpoint).eq(old.mainOutpoint)
    expect(custody.activeReservation).eq(a.reservationId)
    const record = await f.frost.frostWalletQuarantine(
      f.walletId,
      custody.stateVersion
    )
    expect(record.reservationId).eq(a.reservationId)
    expect(record.reasonHash).eq(reason)
    expect(record.evidenceHash).eq(evidenceHash)
    expect(record.authority).eq(await f.frost.signer.getAddress())
    expect(record.recordedBlock).eq(receipt.blockNumber)
    expect(record.previousStateVersion).eq(old.stateVersion)
    const retained = await f.frost.frostReservation(a.reservationId)
    expect(retained.state).eq(5)
    expect(retained.certificate.stateVersion).eq(old.stateVersion)
    expect(retained.snapshot).eq(a.proposal.snapshot)
    expect(await f.bank.balanceOf(f.frost.address)).eq(20000)
    await expect(
      f.frost
        .connect(f.depositor)
        .requestFrostRedemption(f.walletId, script, 3000, f.depositor.address)
    ).revertedWith("FROST redemption wallet unavailable")
    const deadline = (
      await f.frost.frostRedemptionRequest(a.id)
    ).deadline.toNumber()
    await network.provider.send("evm_setNextBlockTimestamp", [deadline])
    await f.frost.notifyFrostRedemptionTimeout(a.id)
    expect((await f.frost.frostReservation(a.reservationId)).state).eq(5)
    await expect(f.frost.refundUnreservedFrostRedemption(a.id)).revertedWith(
      "FROST reservation retains escrow"
    )
    const payment = await mine(a.proposal.transaction, "contained-payment")
    await f.frost.submitFrostRedemptionProof(
      a.reservationId,
      a.proposal.transaction,
      bitcoinProof(payment.proof)
    )
    expect((await f.frost.frostReservation(a.reservationId)).state).eq(2)
    expect((await f.frost.frostWalletCustody(f.walletId)).stateVersion).eq(3)
    expect(await f.bank.balanceOf(f.depositor.address)).eq(78000)
    expect(await f.bank.balanceOf(f.frost.address)).eq(0)
    expect(await f.frost.frostWalletQuarantine(f.walletId, 2)).deep.eq(record)
    expect(await f.frost.isFrostFundingTarget(f.walletId.slice(0, 42))).eq(
      false
    )
  })

  it("keeps authenticated cancellation and full escrow refund available under containment", async () => {
    const a = await admitted()
    await f.frost.quarantineFrostWallet(
      f.walletId,
      1,
      ethers.utils.id("contain"),
      ethers.utils.id("evidence")
    )
    const c = await cancellation(a.reservationId)
    const confirmed = await mine(c.transaction, "contained-cancellation")
    await f.frost.submitFrostCancellationProof(
      a.reservationId,
      c.transaction,
      bitcoinProof(confirmed.proof)
    )
    expect((await f.frost.frostReservation(a.reservationId)).state).eq(3)
    expect(await f.bank.balanceOf(f.depositor.address)).eq(98000)
    expect(await f.bank.balanceOf(f.treasury.address)).eq(0)
    expect(await f.bank.balanceOf(f.frost.address)).eq(0)
    expect((await f.frost.frostWalletCustody(f.walletId)).value).eq(98000)
    expect(await f.frost.isFrostFundingTarget(f.walletId.slice(0, 42))).eq(
      false
    )
  })

  it("rejects foreign, stale, empty and repeated containment without changing the financial frame", async () => {
    const a = await admitted()
    const reason = ethers.utils.id("contain")
    const evidenceHash = ethers.utils.id("evidence")
    const before = await frame(a.id, a.reservationId)
    await expect(
      f.frost
        .connect(f.depositor)
        .quarantineFrostWallet(f.walletId, 1, reason, evidenceHash)
    ).revertedWith("Caller is not governance")
    for (const [id, version, why, proof] of [
      [ethers.constants.HashZero, 1, reason, evidenceHash],
      [ethers.utils.id("unknown"), 1, reason, evidenceHash],
      [f.walletId, 2, reason, evidenceHash],
      [f.walletId, 1, ethers.constants.HashZero, evidenceHash],
      [f.walletId, 1, reason, ethers.constants.HashZero],
    ]) {
      await expect(f.frost.quarantineFrostWallet(id, version, why, proof))
        .reverted
      expect(await frame(a.id, a.reservationId)).eq(before)
      expect(
        (await f.frost.frostWalletQuarantine(f.walletId, 2)).recordedBlock
      ).eq(0)
    }
    await f.frost.quarantineFrostWallet(f.walletId, 1, reason, evidenceHash)
    const contained = await frame(a.id, a.reservationId)
    const record = await f.frost.frostWalletQuarantine(f.walletId, 2)
    await expect(
      f.frost.quarantineFrostWallet(f.walletId, 2, reason, evidenceHash)
    ).revertedWith("FROST quarantine wallet state")
    expect(await frame(a.id, a.reservationId)).eq(contained)
    expect(await f.frost.frostWalletQuarantine(f.walletId, 2)).deep.eq(record)
  })

  it("returns the unused cancellation budget when the original payment wins", async () => {
    const a = await admitted()
    // Governance changes cannot invalidate an already admitted fee policy.
    await f.bridge.updateRedemptionParameters(3000, 100, 500, 500, 3600, 0, 0)
    await cancellation(a.reservationId)
    const payment = await mine(a.proposal.transaction, "original-wins")
    await f.frost.submitFrostRedemptionProof(
      a.reservationId,
      a.proposal.transaction,
      bitcoinProof(payment.proof)
    )
    expect(await f.bank.balanceOf(f.treasury.address)).eq(1200)
    expect(await f.bank.balanceOf(f.depositor.address)).eq(78000)
    expect(await f.bank.balanceOf(f.frost.address)).eq(0)
    expect((await f.frost.frostReservation(a.reservationId)).state).eq(2)
  })

  it("rolls back a corrupted actual payment proof and permits a clean retry", async () => {
    const a = await admitted()
    const payment = await mine(a.proposal.transaction, "rollback")
    const proof = bitcoinProof(payment.proof)
    const before = await frame(a.id, a.reservationId)
    await expect(
      f.frost.submitFrostRedemptionProof(
        a.reservationId,
        a.proposal.transaction,
        {
          ...proof,
          merkleProof: `0x${"00".repeat((proof.merkleProof.length - 2) / 2)}`,
        }
      )
    ).reverted
    expect(await frame(a.id, a.reservationId)).eq(before)
    await f.frost.submitFrostRedemptionProof(
      a.reservationId,
      a.proposal.transaction,
      proof
    )
    expect((await f.frost.frostRedemptionRequest(a.id)).state).eq(4)
  })
})
