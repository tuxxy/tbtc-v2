/* eslint-disable no-await-in-loop, no-restricted-syntax */
// SYNTHETIC HISTORY UNIT TESTS ONLY: owner-initialized old Intent records.
// No Bank, funded custody, operator certificates, SPV or Bitcoin lifecycle.
import { ethers } from "hardhat"
import { Contract } from "ethers"
import { expect } from "chai"

type CancellationRecord = {
  transactionHash: string
  snapshot: string
  fee: number
  sponsor: string
  admittedBlock: number
  validUntilBlock: number
  seats: number[]
  signatures: string
  budgetSettled: boolean
}

describe("FROST cancellation history legacy compatibility (synthetic unit)", () => {
  const id = ethers.utils.id("synthetic legacy intent")
  const ZERO = ethers.constants.HashZero
  const firstHash = ethers.utils.id("synthetic first cancellation")
  const extraHash = ethers.utils.id("synthetic second cancellation")
  const thirdHash = ethers.utils.id("synthetic third cancellation")

  function record(
    sponsor: string,
    overrides: Partial<CancellationRecord> = {}
  ): CancellationRecord {
    return {
      transactionHash: firstHash,
      snapshot: ethers.utils.id("synthetic first snapshot"),
      fee: 100,
      sponsor,
      admittedBlock: 1,
      validUntilBlock: 2, // Historical certificate expiry must not reopen a budget.
      seats: [1, 3],
      signatures: "0x11223344", // Deliberately not an authenticated certificate.
      budgetSettled: false,
      ...overrides,
    }
  }

  async function fixture(state = 1, empty = false) {
    const [owner, other] = await ethers.getSigners()
    const f = await (
      await ethers.getContractFactory("FrostCancellationHistoryFixture", owner)
    ).deploy()
    await f.deployed()
    const first = record(
      owner.address,
      empty
        ? {
            transactionHash: ZERO,
            snapshot: ZERO,
            fee: 0,
            sponsor: ethers.constants.AddressZero,
            admittedBlock: 0,
            validUntilBlock: 0,
            seats: [],
            signatures: "0x",
          }
        : {}
    )
    await f.initializeLegacyForTest(id, state, first)
    return { f, owner, other, first }
  }

  async function frame(f: Contract) {
    const size = (await f.count(id)).toNumber()
    const records = []
    for (let i = 0; i < size; i++) {
      const hash = await f.at(id, i)
      records.push([hash, await f.get(id, hash)])
    }
    return JSON.stringify([
      await f.getIntent(id),
      await f.rawHistory(id),
      await f.maximumFee(id),
      records,
    ])
  }

  async function noHistoryWrites(f: Contract) {
    const raw = await f.rawHistory(id)
    expect(raw.extraCount).eq(0)
    expect(raw.maximumFee).eq(0)
    expect(raw.winningHash).eq(ZERO)
    expect(raw.firstBudgetSettled).eq(false)
  }

  it("infers old Paid and ConflictResolved first returns with zero history and refuses repeated claims without migration", async () => {
    for (const terminal of [2, 6]) {
      const { f, first } = await fixture(terminal)
      await noHistoryWrites(f)
      const before = await frame(f)
      expect(await f.count(id)).eq(1)
      expect(await f.at(id, 0)).eq(firstHash)
      expect(await f.maximumFee(id)).eq(100)
      const archived = await f.get(id, firstHash)
      expect(archived.budgetSettled).eq(true)
      expect(archived.sponsor).eq(first.sponsor)
      expect(archived.signatures).eq(first.signatures)
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(f.takeRefundForTest(id, firstHash)).revertedWith(
          "FROST cancellation budget settled"
        )
        expect(await frame(f)).eq(before)
      }
      await noHistoryWrites(f)
    }
  })

  it("infers the old Cancelled first burn with no winner/history marker and refuses claims or winner reinterpretation", async () => {
    const { f } = await fixture(3)
    await noHistoryWrites(f)
    const before = await frame(f)
    expect((await f.get(id, firstHash)).budgetSettled).eq(true)
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(f.takeRefundForTest(id, firstHash)).revertedWith(
        "FROST cancellation budget settled"
      )
      expect(await frame(f)).eq(before)
    }
    await expect(f.recordWinnerForTest(id, extraHash)).revertedWith(
      "FROST cancellation winner state"
    )
    await expect(f.recordWinnerForTest(id, firstHash)).revertedWith(
      "FROST cancellation winner state"
    )
    expect(await frame(f)).eq(before)
    await noHistoryWrites(f)
  })

  it("extends old Reserved max-zero history and leaves the old first budget collectible once when a new alternative wins", async () => {
    const { f, other } = await fixture()
    await noHistoryWrites(f)
    const originalIntent = await f.getIntent(id)
    const first = await f.get(id, firstHash)
    expect(await f.maximumFee(id)).eq(100)
    const extra = record(other.address, {
      transactionHash: extraHash,
      snapshot: ethers.utils.id("synthetic extra snapshot"),
      fee: 200,
      admittedBlock: 3,
      validUntilBlock: 4,
      seats: [2, 3],
      signatures: "0xaabbcc",
    })
    await f.appendForTest(id, extra)
    expect(await f.getIntent(id)).deep.eq(originalIntent)
    expect(await f.get(id, firstHash)).deep.eq(first)
    expect(await f.count(id)).eq(2)
    expect(await f.at(id, 0)).eq(firstHash)
    expect(await f.at(id, 1)).eq(extraHash)
    expect(await f.maximumFee(id)).eq(200)
    await f.recordWinnerForTest(id, extraHash)
    expect((await f.get(id, extraHash)).budgetSettled).eq(true)
    expect((await f.get(id, firstHash)).budgetSettled).eq(false)
    const beforeTerminal = await frame(f)
    await expect(f.takeRefundForTest(id, firstHash)).revertedWith(
      "FROST cancellation refund state"
    )
    expect(await frame(f)).eq(beforeTerminal)
    await f.setStateForTest(id, 3)
    expect((await f.rawHistory(id)).firstBudgetSettled).eq(false)
    expect((await f.get(id, firstHash)).budgetSettled).eq(false)
    const refund = await f.callStatic.takeRefundForTest(id, firstHash)
    expect(refund.sponsor).eq(first.sponsor)
    expect(refund.fee).eq(first.fee)
    await f.takeRefundForTest(id, firstHash)
    expect((await f.get(id, firstHash)).budgetSettled).eq(true)
    const settled = await frame(f)
    await expect(f.takeRefundForTest(id, firstHash)).revertedWith(
      "FROST cancellation budget settled"
    )
    await expect(f.takeRefundForTest(id, extraHash)).revertedWith(
      "FROST cancellation winning budget"
    )
    expect(await frame(f)).eq(settled)
    expect((await f.get(id, firstHash)).signatures).eq(first.signatures)
    expect((await f.get(id, extraHash)).signatures).eq(extra.signatures)
  })

  it("keeps first and extra archives immutable and enforces uniqueness and strict maximum fee increase", async () => {
    const { f, owner, other } = await fixture(1, true)
    const first = record(owner.address)
    const second = record(other.address, {
      transactionHash: extraHash,
      fee: 200,
      signatures: "0x5566",
      seats: [2],
    })
    const third = record(owner.address, {
      transactionHash: thirdHash,
      fee: 300,
      signatures: "0x7788",
      seats: [3],
    })
    await f.appendForTest(id, first)
    const firstArchive = await f.get(id, firstHash)
    await f.appendForTest(id, second)
    const secondArchive = await f.get(id, extraHash)
    await f.appendForTest(id, third)
    expect(await f.get(id, firstHash)).deep.eq(firstArchive)
    expect(await f.get(id, extraHash)).deep.eq(secondArchive)
    expect(await f.maximumFee(id)).eq(300)
    expect(await f.count(id)).eq(3)
    const before = await frame(f)
    const freshHash = ethers.utils.id("rejected fourth cancellation")
    for (const invalid of [
      record(owner.address, { transactionHash: firstHash, fee: 400 }),
      record(owner.address, { transactionHash: extraHash, fee: 400 }),
      record(owner.address, { transactionHash: ZERO, fee: 400 }),
      record(owner.address, { transactionHash: freshHash, fee: 0 }),
      record(owner.address, { transactionHash: freshHash, fee: 299 }),
      record(owner.address, { transactionHash: freshHash, fee: 300 }),
      record(ethers.constants.AddressZero, {
        transactionHash: freshHash,
        fee: 400,
      }),
      record(owner.address, {
        transactionHash: freshHash,
        fee: 400,
        budgetSettled: true,
      }),
    ]) {
      await expect(f.appendForTest(id, invalid)).reverted
      expect(await frame(f)).eq(before)
    }
    await expect(f.get(id, freshHash)).revertedWith(
      "FROST cancellation unknown"
    )
    await expect(f.get(id, ZERO)).revertedWith("FROST cancellation unknown")
    await expect(f.at(id, 3)).revertedWith("FROST cancellation history index")
    await f.recordWinnerForTest(id, firstHash)
    await f.setStateForTest(id, 3)
    expect((await f.get(id, firstHash)).budgetSettled).eq(true)
    const refund = await f.callStatic.takeRefundForTest(id, extraHash)
    expect(refund.sponsor).eq(other.address)
    expect(refund.fee).eq(200)
    await f.takeRefundForTest(id, extraHash)
    const claimed = await frame(f)
    await expect(f.takeRefundForTest(id, extraHash)).revertedWith(
      "FROST cancellation budget settled"
    )
    expect(await frame(f)).eq(claimed)
    expect((await f.get(id, thirdHash)).budgetSettled).eq(false)
  })

  it("guards all synthetic mutations by owner and keeps explicit first-return marking idempotent", async () => {
    const { f, other, first } = await fixture()
    const before = await frame(f)
    const outsider = f.connect(other)
    const attempts = [
      () =>
        outsider.initializeLegacyForTest(
          ethers.utils.id("unauthorized seed"),
          1,
          first
        ),
      () => outsider.setStateForTest(id, 3),
      () =>
        outsider.appendForTest(
          id,
          record(other.address, { transactionHash: extraHash, fee: 200 })
        ),
      () => outsider.recordWinnerForTest(id, firstHash),
      () => outsider.recordFirstReturnForTest(id),
      () => outsider.takeRefundForTest(id, firstHash),
    ]
    for (const attempt of attempts) {
      await expect(attempt()).revertedWith("Fixture owner only")
      expect(await frame(f)).eq(before)
    }
    await expect(f.initializeLegacyForTest(id, 1, first)).revertedWith(
      "Fixture already initialized"
    )
    await f.recordFirstReturnForTest(id)
    expect((await f.rawHistory(id)).firstBudgetSettled).eq(true)
    expect((await f.get(id, firstHash)).budgetSettled).eq(true)
    const marked = await frame(f)
    await f.recordFirstReturnForTest(id)
    expect(await frame(f)).eq(marked)
    await f.setStateForTest(id, 2)
    const terminal = await frame(f)
    await expect(f.takeRefundForTest(id, firstHash)).revertedWith(
      "FROST cancellation budget settled"
    )
    expect(await frame(f)).eq(terminal)
  })
})
