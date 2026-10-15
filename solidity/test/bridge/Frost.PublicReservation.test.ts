/* eslint-disable no-await-in-loop, no-restricted-syntax */
import { ethers, network } from "hardhat"
import { expect } from "chai"
import { publicFundedFixture } from "../helpers/frost-public-funding"
import { reservationProposal } from "../helpers/frost-reservation-proposal"

// Actual Bridge, Bank, proof-backed custody and operator admission. The helper
// declares its controlled registry/readiness and Core regtest boundaries.
describe("FROST public proof-funded request and reservation", () => {
  let f: Awaited<ReturnType<typeof publicFundedFixture>>
  let snapshot: string
  const script = `0x0014${"11".repeat(20)}`

  before(async () => {
    f = await publicFundedFixture({
      evidenceDirectory:
        process.env.FROST_C04_RESERVATION_EVIDENCE ||
        // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
        require("../helpers/frost-test-isolation").evidenceDirectory(
          "public-reservation"
        ),
    })
    const movement = Array.from(await f.bridge.movingFundsParameters())
    movement[1] = 500
    await f.bridge.updateMovingFundsParameters(...movement)
    await f.bridge.updateRedemptionParameters(3000, 100, 2000, 2000, 3600, 0, 0)
    await f.frost.configureFrostRedemptions(
      f.genesis,
      2,
      1000,
      ethers.constants.AddressZero,
      ethers.utils.id("UNQUALIFIED local D08 fixture reference")
    )
    await f.frost.setFrostRedemptionsEnabled(true)
    snapshot = await network.provider.send("evm_snapshot")
  })

  beforeEach(async () => {
    await network.provider.send("evm_revert", [snapshot])
    snapshot = await network.provider.send("evm_snapshot")
  })

  async function request() {
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
    return id
  }

  async function proposal(id: string, overrides = {}) {
    const custody = await f.frost.frostWalletCustody(f.walletId)
    return reservationProposal({
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
      ...overrides,
    })
  }

  async function frame(id: string, reservationId = ethers.constants.HashZero) {
    const [
      balance,
      escrow,
      requestState,
      custody,
      allowance,
      held,
      treasury,
      intent,
    ] = await Promise.all([
      f.bank.balanceOf(f.depositor.address),
      f.frost.frostRedemptionEscrow(f.walletId),
      f.frost.frostRedemptionRequest(id),
      f.frost.frostWalletCustody(f.walletId),
      f.bank.allowance(f.depositor.address, f.frost.address),
      f.bank.balanceOf(f.frost.address),
      f.bank.balanceOf(await f.bridge.treasury()),
      f.frost.frostReservation(reservationId),
    ])
    return JSON.stringify({
      balance,
      escrow,
      requestState,
      custody,
      allowance,
      held,
      treasury,
      intent,
    })
  }

  it("escrows proven Bank balances and captures request policy before authenticating one reservation", async () => {
    expect(await f.bank.balanceOf(f.depositor.address)).eq(98000)
    const id = await request()
    const captured = await f.frost.frostRedemptionRequest(id)
    expect(captured.gross).eq(20000)
    expect(captured.treasuryFee).eq(200)
    expect(captured.maximumBitcoinFee).eq(2000)
    expect(captured.finalityBlocks).eq(2)
    expect(captured.script).eq(script)
    expect(await f.bank.balanceOf(f.depositor.address)).eq(78000)
    expect(await f.bank.balanceOf(f.frost.address)).eq(20000)
    const p = await proposal(id)
    const admitted = await f.frost.callStatic.reserveFrostRedemption(p)
    await f.frost.reserveFrostRedemption(p)
    const intent = await f.frost.frostReservation(admitted)
    expect(intent.snapshot).eq(p.snapshot)
    expect(intent.requestIds).deep.eq([id])
    expect(intent.reservedNet).eq(19800)
    expect(intent.certificate.intentCommitment).eq(
      p.certificate.intentCommitment
    )
    expect((await f.frost.frostWalletCustody(f.walletId)).activeReservation).eq(
      admitted
    )
    expect((await f.frost.frostRedemptionRequest(id)).state).eq(2)
  })

  it("rejects unfunded allowance without moving balances, counters or custody", async () => {
    const before = await frame(ethers.constants.HashZero)
    await expect(
      f.frost
        .connect(f.depositor)
        .requestFrostRedemption(f.walletId, script, 20000, f.depositor.address)
    ).reverted
    expect(await frame(ethers.constants.HashZero)).eq(before)
    const id = await request()
    const firstNonceId = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        [
          "string",
          "uint256",
          "address",
          "bytes32",
          "bytes32",
          "uint64",
          "bytes32",
        ],
        [
          "tbtc-v2/frost-redemption-request/v1",
          (await ethers.provider.getNetwork()).chainId,
          f.frost.address,
          f.walletId,
          f.descriptorHash,
          1,
          ethers.utils.keccak256(script),
        ]
      )
    )
    expect(id).eq(firstNonceId)
    expect((await f.frost.frostRedemptionRequest(id)).state).eq(1)
  })

  it("rejects insufficient certificate authority with the complete frame intact", async () => {
    const id = await request()
    const p = await proposal(id)
    const before = await frame(id)
    await expect(
      f.frost.reserveFrostRedemption({
        ...p,
        seats: [1],
        signatures: `0x${p.signatures.slice(2, 132)}`,
      })
    ).revertedWith("FROST reservation certificate")
    expect(await frame(id)).eq(before)
  })

  it("rolls back a duplicate request after the first tentative state transition", async () => {
    const id = await request()
    const duplicate = { id, value: 19300, script }
    const p = await proposal(id, { requests: [duplicate, duplicate] })
    const before = await frame(id)
    await expect(f.frost.reserveFrostRedemption(p)).revertedWith(
      "FROST request not reservable"
    )
    expect(await frame(id)).eq(before)
    await f.frost.reserveFrostRedemption(await proposal(id))
    expect((await f.frost.frostRedemptionRequest(id)).state).eq(2)
  })

  it("refuses a second valid reservation for the shared main custody", async () => {
    const first = await request()
    const p = await proposal(first)
    const admitted = await f.frost.callStatic.reserveFrostRedemption(p)
    await f.frost.reserveFrostRedemption(p)
    const second = await request()
    const next = await proposal(second)
    const before = await frame(second, admitted)
    await expect(f.frost.reserveFrostRedemption(next)).revertedWith(
      "FROST reservation custody state"
    )
    expect(await frame(second, admitted)).eq(before)
  })

  it("rejects signed stale counters and forged previous-output values atomically", async () => {
    const id = await request()
    for (const [overrides, reason] of [
      [{ stateVersion: 2 }, "FROST reservation counter"],
      [{ generation: 2 }, "FROST reservation counter"],
      [
        { inputs: [{ ...f.custodyUTXO, txOutputValue: 99001 }] },
        "FROST input not recognized custody",
      ],
    ] as const) {
      const before = await frame(id)
      await expect(
        f.frost.reserveFrostRedemption(await proposal(id, overrides))
      ).revertedWith(reason)
      expect(await frame(id)).eq(before)
    }
  })

  it("enforces the shared total fee cap even when every per-request cap and operator signature passes", async () => {
    const first = await request()
    const second = await request()
    const p = await proposal(first, {
      fee: 3000,
      maximumFee: 3000,
      requests: [
        { id: first, value: 18300, script },
        { id: second, value: 18300, script },
      ],
    })
    const before = await frame(first)
    const secondBefore = JSON.stringify(
      await f.frost.frostRedemptionRequest(second)
    )
    await expect(f.frost.reserveFrostRedemption(p)).revertedWith(
      "FROST reservation total fee policy"
    )
    expect(await frame(first)).eq(before)
    expect(JSON.stringify(await f.frost.frostRedemptionRequest(second))).eq(
      secondBefore
    )
    await f.bridge.updateRedemptionParameters(3000, 100, 2000, 4000, 3600, 0, 0)
    await f.frost.reserveFrostRedemption(p)
    expect((await f.frost.frostRedemptionRequest(first)).state).eq(2)
    expect((await f.frost.frostRedemptionRequest(second)).state).eq(2)
  })
})
