/* eslint-disable no-await-in-loop, no-restricted-syntax, @typescript-eslint/no-loop-func */
// Loop-created Mocha callbacks use the fixture restored by beforeEach.
import { ethers, network } from "hardhat"
import { expect } from "chai"
import { Signer } from "ethers"
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
import { evidenceDirectory } from "../helpers/frost-test-isolation"

// Public proof-backed Bank origin; controlled readiness, scalar 3 and zero
// regtest relay difficulty do not qualify production threshold custody.
describe("FROST cancellation alternatives", () => {
  const evidence = evidenceDirectory(
    "cancellation-alternatives",
    process.env.FROST_C04_ALTERNATIVES_EVIDENCE
  )
  const script = `0x0014${"11".repeat(20)}`
  let f: Awaited<ReturnType<typeof publicFundedFixture>>
  let root: string
  let sequence = 0
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
      ethers.utils.id("UNQUALIFIED alternatives fixture")
    )
    await f.frost.setFrostRedemptionsEnabled(true)
    root = await network.provider.send("evm_snapshot")
  })
  beforeEach(async () => {
    await network.provider.send("evm_revert", [root])
    root = await network.provider.send("evm_snapshot")
  })
  async function admit(gross = 20000, paymentFee = 1000) {
    const caller = f.frost.connect(f.depositor)
    await f.bank.connect(f.depositor).approveBalance(f.frost.address, gross)
    const id = await caller.callStatic.requestFrostRedemption(
      f.walletId,
      script,
      gross,
      f.depositor.address
    )
    await caller.requestFrostRedemption(
      f.walletId,
      script,
      gross,
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
      requests: [
        { id, value: gross - Math.floor(gross / 100) - paymentFee, script },
      ],
      fee: paymentFee,
      minimumFee: 100,
      maximumFee: 2000,
      maximumSatPerVByte: 100,
      operators: f.operators,
    })
    const reservationId = await f.frost.callStatic.reserveFrostRedemption(
      proposal
    )
    await f.frost.reserveFrostRedemption(proposal)
    return { id, proposal, reservationId }
  }
  async function alternative(reservationId: string, fee: number, locktime = 0) {
    const value = Buffer.alloc(8)
    value.writeBigUInt64LE(
      BigInt(f.custodyUTXO.txOutputValue.toString()) - BigInt(fee)
    )
    const time = Buffer.alloc(4)
    time.writeUInt32LE(locktime)
    const transaction = {
      version: "0x02000000",
      inputVector: `0x01${f.custodyUTXO.txHash.slice(2)}0000000000fdffffff`,
      outputVector: `0x01${value.toString(
        "hex"
      )}225120${f.descriptor.outputKey.slice(2)}`,
      locktime: `0x${time.toString("hex")}`,
    }
    const validator = await (
      await ethers.getContractFactory("FrostRedemptionTransactionFixture")
    ).deploy()
    const result = await validator.validateCancellation(
      transaction,
      f.descriptor.outputKey,
      [f.custodyUTXO]
    )
    const authorization = {
      reservationId,
      snapshot: result.snapshot,
      transactionHash: result.txHash,
      fee,
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
    return { transaction, authorization, signatures }
  }
  type Alternative = Awaited<ReturnType<typeof alternative>>
  async function authorize(c: Alternative, sponsor: Signer) {
    return f.frost
      .connect(sponsor)
      .authorizeFrostCancellation(
        c.authorization,
        c.transaction,
        [1, 2],
        c.signatures
      )
  }
  async function pair(gross = 20000, paymentFee = 1000) {
    const a = await admit(gross, paymentFee)
    const first = await alternative(a.reservationId, 1000)
    await f.bank.connect(f.treasury).approveBalance(f.frost.address, 1000)
    await authorize(first, f.treasury)
    const legacy = JSON.stringify(
      await f.frost.frostReservation(a.reservationId)
    )
    const second = await alternative(a.reservationId, 1500)
    await f.bank.connect(f.depositor).approveBalance(f.frost.address, 1500)
    await authorize(second, f.depositor)
    expect(JSON.stringify(await f.frost.frostReservation(a.reservationId))).eq(
      legacy
    )
    expect(await f.frost.frostCancellationCount(a.reservationId)).eq(2)
    for (const [index, c, sponsor] of [
      [0, first, f.treasury],
      [1, second, f.depositor],
    ] as const) {
      expect(await f.frost.frostCancellationHash(a.reservationId, index)).eq(
        c.authorization.transactionHash
      )
      const record = await f.frost.frostCancellationAlternative(
        a.reservationId,
        c.authorization.transactionHash
      )
      expect(record.transactionHash).eq(c.authorization.transactionHash)
      expect(record.snapshot).eq(c.authorization.snapshot)
      expect(record.fee).eq(c.authorization.fee)
      expect(record.sponsor).eq(sponsor.address)
      expect(record.validUntilBlock).eq(c.authorization.validUntilBlock)
      expect(Number(record.admittedBlock)).greaterThan(0)
      expect(record.seats.map(Number)).deep.eq([1, 2])
      expect(record.signatures).eq(c.signatures)
      expect(record.budgetSettled).eq(false)
    }
    expect(await f.bank.balanceOf(f.frost.address)).eq(gross + 2500)
    return { ...a, first, second }
  }
  async function frame(a: Awaited<ReturnType<typeof admit>>) {
    const count = Number(await f.frost.frostCancellationCount(a.reservationId))
    const records = []
    for (let i = 0; i < count; i++) {
      const hash = await f.frost.frostCancellationHash(a.reservationId, i)
      records.push([
        hash,
        await f.frost.frostCancellationAlternative(a.reservationId, hash),
      ])
    }
    return JSON.stringify(
      await Promise.all([
        f.frost.frostReservation(a.reservationId),
        f.frost.frostRedemptionRequest(a.id),
        f.frost.frostWalletCustody(f.walletId),
        f.frost.frostRedemptionEscrow(f.walletId),
        f.frost.frostCustodyOutput(
          outpointKey(f.custodyUTXO.txHash, f.custodyUTXO.txOutputIndex)
        ),
        f.bridge.spentMainUTXOs(
          outpointKey(f.custodyUTXO.txHash, f.custodyUTXO.txOutputIndex)
        ),
        ...[f.depositor, f.treasury, f.governance].flatMap((sponsor) => [
          f.bank.balanceOf(sponsor.address),
          f.bank.allowance(sponsor.address, f.frost.address),
        ]),
        f.bank.balanceOf(f.frost.address),
        Promise.resolve(records),
      ])
    )
  }
  async function rejectsWithoutChange(
    a: Awaited<ReturnType<typeof admit>>,
    action: () => Promise<unknown>
  ) {
    const before = await frame(a)
    await expect(action()).reverted
    expect(await frame(a)).eq(before)
  }
  async function mine(
    transaction: TransactionInfo,
    label: string,
    replaceRaw?: string
  ) {
    sequence += 1
    return runCoreSettlement({
      coreWitness: f.coreWitness,
      input: f.custodyUTXO,
      transaction,
      outputDirectory: `${evidence}/${sequence}-${label}`,
      replaceRaw,
      competingRaw: replaceRaw,
    })
  }
  for (const winnerIndex of [0, 1]) {
    it(`settles cancellation ${
      winnerIndex + 1
    }, refunds full gross and releases only the losing budget`, async () => {
      const a = await pair()
      const choices = [a.first, a.second]
      const winner = choices[winnerIndex]
      const loser = choices[1 - winnerIndex]
      for (const c of choices)
        await rejectsWithoutChange(a, () =>
          f.frost.claimFrostCancellationBudget(
            a.reservationId,
            c.authorization.transactionHash
          )
        )
      await network.provider.send("hardhat_mine", ["0xc8"])
      const previouslySigned =
        winnerIndex === 1
          ? await mine(a.first.transaction, "old-signature-for-replacement")
          : undefined
      const confirmed = await mine(
        winner.transaction,
        `cancellation-${winnerIndex}`,
        previouslySigned?.raw
      )
      if (winnerIndex === 1) {
        expect(confirmed.replacement?.previousRemoved).eq(true)
        expect(confirmed.conflictRejection?.allowed).eq(false)
      }
      await f.frost.submitFrostCancellationProof(
        a.reservationId,
        winner.transaction,
        bitcoinProof(confirmed.proof)
      )
      expect((await f.frost.frostReservation(a.reservationId)).state).eq(3)
      expect(await f.frost.frostCancellationWinner(a.reservationId)).eq(
        winner.authorization.transactionHash
      )
      expect((await f.frost.frostRedemptionRequest(a.id)).state).eq(5)
      expect((await f.frost.frostWalletCustody(f.walletId)).value).eq(
        99000 - winner.authorization.fee
      )
      expect(await f.bank.balanceOf(f.frost.address)).eq(
        loser.authorization.fee
      )
      expect(await f.bank.balanceOf(f.depositor.address)).eq(96500)
      expect(await f.bank.balanceOf(f.treasury.address)).eq(0)
      await rejectsWithoutChange(a, () =>
        f.frost.claimFrostCancellationBudget(
          a.reservationId,
          winner.authorization.transactionHash
        )
      )
      await f.frost
        .connect(f.operators[2])
        .claimFrostCancellationBudget(
          a.reservationId,
          loser.authorization.transactionHash
        )
      expect(await f.bank.balanceOf(f.frost.address)).eq(0)
      expect(await f.bank.balanceOf(f.treasury.address)).eq(
        winnerIndex === 1 ? 1000 : 0
      )
      expect(await f.bank.balanceOf(f.depositor.address)).eq(
        winnerIndex === 0 ? 98000 : 96500
      )
      for (const c of choices)
        expect(
          (
            await f.frost.frostCancellationAlternative(
              a.reservationId,
              c.authorization.transactionHash
            )
          ).budgetSettled
        ).eq(true)
      await rejectsWithoutChange(a, () =>
        f.frost.claimFrostCancellationBudget(
          a.reservationId,
          loser.authorization.transactionHash
        )
      )
      await rejectsWithoutChange(a, () =>
        f.frost.submitFrostCancellationProof(
          a.reservationId,
          winner.transaction,
          bitcoinProof(confirmed.proof)
        )
      )
      const escrow = await f.frost.frostRedemptionEscrow(f.walletId)
      expect(escrow[0]).eq(0)
      expect(escrow[1]).eq(0)
    })
  }
  it("returns the first budget automatically on payment and permits a separate second-budget claim", async () => {
    const a = await pair()
    const paid = await mine(a.proposal.transaction, "payment-wins")
    await f.frost.submitFrostRedemptionProof(
      a.reservationId,
      a.proposal.transaction,
      bitcoinProof(paid.proof)
    )
    expect((await f.frost.frostReservation(a.reservationId)).state).eq(2)
    expect(await f.frost.frostCancellationWinner(a.reservationId)).eq(
      ethers.constants.HashZero
    )
    expect(await f.bank.balanceOf(f.treasury.address)).eq(1200)
    expect(await f.bank.balanceOf(f.depositor.address)).eq(76500)
    expect(await f.bank.balanceOf(f.frost.address)).eq(1500)
    expect((await f.frost.frostWalletCustody(f.walletId)).value).eq(79200)
    expect(
      (
        await f.frost.frostCancellationAlternative(
          a.reservationId,
          a.first.authorization.transactionHash
        )
      ).budgetSettled
    ).eq(true)
    await rejectsWithoutChange(a, () =>
      f.frost.claimFrostCancellationBudget(
        a.reservationId,
        a.first.authorization.transactionHash
      )
    )
    await f.frost
      .connect(f.operators[2])
      .claimFrostCancellationBudget(
        a.reservationId,
        a.second.authorization.transactionHash
      )
    expect(await f.bank.balanceOf(f.depositor.address)).eq(78000)
    expect(await f.bank.balanceOf(f.frost.address)).eq(0)
    await rejectsWithoutChange(a, () =>
      f.frost.claimFrostCancellationBudget(
        a.reservationId,
        a.second.authorization.transactionHash
      )
    )
  })
  it("reserves exposure for the highest fee rather than the sum of independently funded budgets", async () => {
    await f.bridge.updateRedemptionParameters(1000, 100, 500, 2000, 3600, 0, 0)
    const a = await pair(1000, 100)
    expect(
      (await f.frost.frostWalletCustody(f.walletId)).cancellationExposure
    ).eq(510)
    const escrow = await f.frost.frostRedemptionEscrow(f.walletId)
    expect(escrow[0]).eq(1000)
    expect(escrow[1]).eq(990)
    expect(await f.bank.balanceOf(f.frost.address)).eq(3500)
    expect(await f.frost.frostCancellationCount(a.reservationId)).eq(2)
  })

  it("rolls back duplicate/equal/lower/over-cap/invalid-certificate/unfunded authorizations", async () => {
    const a = await pair()
    await f.bank.connect(f.depositor).approveBalance(f.frost.address, 10000)
    const equal = await alternative(a.reservationId, 1500, 1)
    const lower = await alternative(a.reservationId, 1200, 2)
    const excessive = await alternative(a.reservationId, 2500)
    const invalid = await alternative(a.reservationId, 1750)
    const unfunded = await alternative(a.reservationId, 1800)
    for (const c of [a.first, a.second, equal, lower, excessive])
      await rejectsWithoutChange(a, () => authorize(c, f.depositor))
    await rejectsWithoutChange(a, () =>
      f.frost
        .connect(f.depositor)
        .authorizeFrostCancellation(
          invalid.authorization,
          invalid.transaction,
          [1, 2],
          `0x${"00".repeat(130)}`
        )
    )
    await f.bank.connect(f.governance).approveBalance(f.frost.address, 1800)
    await rejectsWithoutChange(a, () => authorize(unfunded, f.governance))
    await expect(
      f.frost.frostCancellationAlternative(
        a.reservationId,
        unfunded.authorization.transactionHash
      )
    ).revertedWith("FROST cancellation unknown")
    expect(await f.frost.frostCancellationCount(a.reservationId)).eq(2)
  })
})
