/* eslint-disable no-await-in-loop, no-restricted-syntax */
import { ethers } from "hardhat"
import { expect } from "chai"

// Seeds are deliberately unqualified synthetic roots, not real Bank funding or custody.
describe("FROST cancellation capacity common ledger helpers", () => {
  const wallet = ethers.utils.id("synthetic wallet")
  const intent = ethers.utils.id("synthetic active intent")
  const maximum = "2100000000000000"
  const uint64Max = "18446744073709551615"
  async function fixture(
    value = "1000",
    net = "900",
    reserved = "200",
    active = true
  ) {
    const [owner, other] = await ethers.getSigners()
    const f = await (
      await ethers.getContractFactory("FrostCancellationCapacityFixture", owner)
    ).deploy()
    await f.seed(wallet, intent, value, net, reserved, active)
    return { f, other }
  }

  it("rejects a cancellation fee stranding other pending liabilities before storing authorization", async () => {
    const { f } = await fixture()
    const before = await f.frame(wallet, intent)
    await expect(f.authorizeForTest(intent, 301)).to.be.revertedWith(
      "FROST cancellation strands liabilities"
    )
    expect(await f.frame(wallet, intent)).to.deep.equal(before)
  })

  it("accepts equality and records only fee minus the batch refundable net", async () => {
    const { f } = await fixture()
    await f.authorizeForTest(intent, 300)
    const frame = await f.frame(wallet, intent)
    expect(frame.exposure).to.equal(100)
    expect(frame.cancellationFee).to.equal(300)
    expect(frame.pendingNet).to.equal(900)
    expect(frame.reservedNet).to.equal(200)
    expect(frame.value).to.equal(1000)
  })

  it("records zero exposure when the refundable batch net covers the fee", async () => {
    for (const fee of [1, 199, 200]) {
      const { f } = await fixture()
      await f.authorizeForTest(intent, fee)
      expect((await f.frame(wallet, intent)).exposure).to.equal(0)
    }
  })

  it("admits new net liability exactly at adjusted capacity and rolls back one over", async () => {
    const { f } = await fixture("1000", "800", "200")
    await f.authorizeForTest(intent, 300) // Exposure 100; adjusted capacity 900.
    const before = await f.frame(wallet, intent)
    await expect(f.requestCapacityForTest(wallet, 101)).to.be.revertedWith(
      "FROST insufficient recognized custody"
    )
    expect(await f.frame(wallet, intent)).to.deep.equal(before)
    await f.requestCapacityForTest(wallet, 100)
    expect((await f.frame(wallet, intent)).pendingNet).to.equal(900)
    const atCapacity = await f.frame(wallet, intent)
    await expect(f.requestCapacityForTest(wallet, 1)).to.be.revertedWith(
      "FROST insufficient recognized custody"
    )
    expect(await f.frame(wallet, intent)).to.deep.equal(atCapacity)
  })

  it("handles supply-boundary fees and full-width uint64 values without narrowing", async () => {
    const { f } = await fixture(maximum, maximum, maximum)
    await f.authorizeForTest(intent, maximum)
    expect((await f.frame(wallet, intent)).exposure).to.equal(0)
    const before = await f.frame(wallet, intent)
    await expect(
      f.authorizeForTest(intent, ethers.BigNumber.from(maximum).add(1))
    ).to.be.revertedWith("FROST cancellation strands liabilities")
    await expect(f.authorizeForTest(intent, uint64Max)).to.be.revertedWith(
      "FROST cancellation strands liabilities"
    )
    expect(await f.frame(wallet, intent)).to.deep.equal(before)
    await expect(
      f.requestCapacityForTest(wallet, uint64Max)
    ).to.be.revertedWith("FROST insufficient recognized custody")
    expect(await f.frame(wallet, intent)).to.deep.equal(before)
  })

  it("refuses inactive or missing intent IDs without modifying the financial frame", async () => {
    for (const active of [false, true]) {
      const { f } = await fixture("1000", "900", "200", active)
      const before = await f.frame(wallet, intent)
      await expect(
        f.authorizeForTest(
          active ? ethers.utils.id("missing intent") : intent,
          100
        )
      ).to.be.revertedWith("FROST cancellation strands liabilities")
      expect(await f.frame(wallet, intent)).to.deep.equal(before)
    }
  })

  it("refuses malformed reserved totals and guards all synthetic mutation methods by owner", async () => {
    const { f, other } = await fixture("1000", "100", "200")
    const before = await f.frame(wallet, intent)
    await expect(f.authorizeForTest(intent, 100)).to.be.revertedWith(
      "FROST cancellation strands liabilities"
    )
    await expect(
      f.connect(other).seed(wallet, intent, 1000, 900, 200, true)
    ).to.be.revertedWith("Fixture owner only")
    await expect(
      f.connect(other).authorizeForTest(intent, 100)
    ).to.be.revertedWith("Fixture owner only")
    await expect(
      f.connect(other).requestCapacityForTest(wallet, 1)
    ).to.be.revertedWith("Fixture owner only")
    expect(await f.frame(wallet, intent)).to.deep.equal(before)
  })
})
