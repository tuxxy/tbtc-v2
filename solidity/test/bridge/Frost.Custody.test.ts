import { ethers } from "hardhat"
import { expect } from "chai"

const id = ethers.utils.hexZeroPad("0x01", 32)
const other = ethers.utils.hexZeroPad("0x02", 32)
const hash = ethers.utils.hexZeroPad("0x1234", 32)
const zero = ethers.constants.HashZero
const cap = "2100000000000000"
describe("C-05 shared qualified custody component", () => {
  async function fixture() {
    return (await ethers.getContractFactory("FrostCustodyFixture")).deploy()
  }
  it("keys raw hash plus packed full-width uint32 index without reversing", async () => {
    const p = await fixture()
    expect(await p.key(hash, 0x12345678)).eq(
      ethers.utils.keccak256(ethers.utils.concat([hash, "0x12345678"]))
    )
    expect(await p.key(hash, 0xffffffff)).eq(
      ethers.utils.solidityKeccak256(["bytes32", "uint32"], [hash, 0xffffffff])
    )
  })
  it("initializes version 1 and exact wallet/output values", async () => {
    const p = await fixture()
    await p.credit(id, 0, hash, 1, 123)
    const key = await p.key(hash, 1)
    const w = await p.wallet(id)
    expect(w.generation).eq(0)
    expect(w.stateVersion).eq(1)
    expect(w.value).eq(123)
    expect(w.mainOutpoint).eq(key)
    expect(w.activeReservation).eq(zero)
    expect(w.cancellationExposure).eq(0)
    const o = await p.output(key)
    expect(o.walletId).eq(id)
    expect(o.value).eq(123)
    expect(o.spent).eq(false)
  })
  it("adds distinct outputs and advances version without replacing main", async () => {
    const p = await fixture()
    await p.credit(id, 0, hash, 0, 100)
    const main = await p.key(hash, 0)
    await p.credit(id, 0, hash, 1, 200)
    const w = await p.wallet(id)
    expect(w.value).eq(300)
    expect(w.stateVersion).eq(2)
    expect(w.mainOutpoint).eq(main)
  })
  it("refuses duplicate outpoints across wallets, including spent records", async () => {
    const p = await fixture()
    await p.credit(id, 0, hash, 0, 100)
    await expect(p.credit(id, 0, hash, 0, 200)).revertedWith(
      "FROST custody duplicate"
    )
    await p.markSpent(await p.key(hash, 0))
    await expect(p.credit(other, 0, hash, 0, 100)).revertedWith(
      "FROST custody duplicate"
    )
    expect((await p.output(await p.key(hash, 0))).spent).eq(true)
    expect((await p.wallet(other)).stateVersion).eq(0)
  })
  it("accepts deposit-only credits while preserving the captured plan", async () => {
    const p = await fixture()
    await p.credit(id, 0, hash, 0, 100)
    await p.credit(id, 0, hash, 1, 200)
    const capturedKeys = [await p.key(hash, 0), await p.key(hash, 1)]
    const capturedOutputs = await Promise.all(
      capturedKeys.map((k) => p.output(k))
    )
    // Simulate C04 advancing its uint64 intent counter on reservation.
    await p.intentGeneration(id, 1)
    await p.reserve(id, other)
    const before = await p.wallet(id)
    await p.credit(id, 1, hash, 2, 50)
    await p.credit(id, 1, hash, 3, 75)
    const after = await p.wallet(id)
    expect(after.value).eq(425)
    expect(after.generation).eq(before.generation)
    expect(after.stateVersion).eq(before.stateVersion)
    expect(after.mainOutpoint).eq(before.mainOutpoint)
    expect(after.activeReservation).eq(other)
    expect(after.cancellationExposure).eq(before.cancellationExposure)
    expect(await Promise.all(capturedKeys.map((k) => p.output(k)))).deep.eq(
      capturedOutputs
    )
    expect((await p.output(await p.key(hash, 2))).value).eq(50)
    // A captured-input consumer subtracts 300, preserving 125 of later deposits.
    expect(after.value.sub(300)).eq(125)
    await p.reserve(id, zero)
    await p.credit(id, 1, hash, 4, 1)
    expect((await p.wallet(id)).stateVersion).eq(before.stateVersion.add(1))
    expect((await p.wallet(id)).mainOutpoint).eq(before.mainOutpoint)
  })
  it("retains generation, duplicate and value guards during reservations", async () => {
    const p = await fixture()
    await p.credit(id, 0, hash, 0, 100)
    await p.reserve(id, other)
    await expect(p.credit(id, 1, hash, 1, 100)).revertedWith(
      "FROST custody generation"
    )
    await expect(p.credit(id, 0, hash, 0, 100)).revertedWith(
      "FROST custody duplicate"
    )
    await expect(p.credit(id, 0, hash, 1, 0)).revertedWith(
      "FROST custody value"
    )
    await expect(p.credit(id, 0, hash, 1, cap)).revertedWith(
      "FROST custody total"
    )
    expect((await p.wallet(id)).stateVersion).eq(1)
    expect((await p.wallet(id)).value).eq(100)
    expect((await p.output(await p.key(hash, 1))).walletId).eq(zero)
  })
  it("refuses active reservation state that would initialize or set a main", async () => {
    const p = await fixture()
    await p.reserve(id, other)
    await expect(p.credit(id, 0, hash, 0, 100)).revertedWith(
      "FROST custody reservation state"
    )
    await p.version(id, 1)
    await expect(p.credit(id, 0, hash, 0, 100)).revertedWith(
      "FROST custody reservation state"
    )
    expect((await p.wallet(id)).mainOutpoint).eq(zero)
    expect((await p.output(await p.key(hash, 0))).walletId).eq(zero)
  })
  it("checks positive values and full-width money cap without narrowing", async () => {
    const p = await fixture()
    await expect(p.credit(zero, 0, hash, 0, 1)).revertedWith(
      "FROST custody wallet"
    )
    await expect(p.credit(id, 0, hash, 0, 0)).revertedWith(
      "FROST custody value"
    )
    await expect(p.credit(id, 0, hash, 0, "18446744073709551615")).revertedWith(
      "FROST custody value"
    )
    await p.credit(id, 0, hash, 0, cap)
    expect((await p.wallet(id)).value).eq(cap)
    await expect(p.credit(id, 0, hash, 1, 1)).revertedWith(
      "FROST custody total"
    )
    expect((await p.wallet(id)).stateVersion).eq(1)
    expect((await p.output(await p.key(hash, 1))).walletId).eq(zero)
  })
  it("refuses version wrap and leaves failed-credit state unchanged", async () => {
    const p = await fixture()
    await p.credit(id, 0, hash, 0, 100)
    await p.version(id, "18446744073709551615")
    await expect(p.credit(id, 0, hash, 1, 100)).reverted
    expect((await p.wallet(id)).value).eq(100)
    expect((await p.output(await p.key(hash, 1))).walletId).eq(zero)
  })
})
