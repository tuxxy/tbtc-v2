/* eslint-disable no-await-in-loop, no-restricted-syntax */
import { ethers, network } from "hardhat"
import { expect } from "chai"

const requestType =
  "tuple(bytes32 walletId,bytes32 descriptorHash,bytes32 reservationId,address redeemer,uint64 gross,uint64 treasuryFee,uint64 maximumBitcoinFee,uint64 deadline,uint64 finalityBlocks,uint64 timeoutBlock,uint8 state,bytes script)"
const maximum = "2100000000000000"
const uint64Max = "18446744073709551615"

describe("FROST request escrow with real Bank (synthetic fixture credit only)", () => {
  async function fixture() {
    const [owner, payer, redeemer, stranger] = await ethers.getSigners()
    const ledger = await (
      await ethers.getContractFactory("FrostRedemptionLedgerFixture", owner)
    ).deploy()
    const bank = await ethers.getContractAt("Bank", await ledger.bank())
    const admission = {
      walletId: ethers.utils.id("wallet"),
      descriptorHash: ethers.utils.id("descriptor"),
      balanceOwner: payer.address,
      redeemer: redeemer.address,
      gross: "10000",
      treasuryFee: "100",
      maximumBitcoinFee: "500",
      timeoutSeconds: "100",
      finalityBlocks: "3",
      script: `0x0014${"11".repeat(20)}`,
    }
    // This is controlled test credit, not a Bitcoin custody/funding witness.
    await ledger.creditForTest(payer.address, "50000")
    await bank.connect(payer).approveBalance(ledger.address, "40000")
    const { chainId } = await ethers.provider.getNetwork()
    const id = (nonce = 1, input = admission) =>
      ethers.utils.keccak256(
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
            chainId,
            ledger.address,
            input.walletId,
            input.descriptorHash,
            nonce,
            ethers.utils.keccak256(input.script),
          ]
        )
      )
    const frame = async (ids = [id(), id(2)]) => ({
      nonce: (await ledger.nonce(admission.walletId)).toString(),
      escrow: (await ledger.escrow(admission.walletId)).toString(),
      netLiability: (await ledger.netLiability(admission.walletId)).toString(),
      requests: await Promise.all(
        ids.map(async (key) =>
          ethers.utils.defaultAbiCoder.encode(
            [requestType],
            [await ledger.getRequest(key)]
          )
        )
      ),
      balances: await Promise.all(
        [
          payer.address,
          redeemer.address,
          ledger.address,
          stranger.address,
          bank.address,
        ].map(async (address) => (await bank.balanceOf(address)).toString())
      ),
      allowances: await Promise.all(
        [payer.address, redeemer.address, ledger.address, stranger.address].map(
          async (address) =>
            (await bank.allowance(address, ledger.address)).toString()
        )
      ),
      bankNonces: await Promise.all(
        [payer.address, redeemer.address, ledger.address, stranger.address].map(
          async (address) => (await bank.nonces(address)).toString()
        )
      ),
    })
    const request = (input = admission) => ledger.connect(payer).request(input)
    const pending = async () => {
      const tx = await request()
      const receipt = await tx.wait()
      const block = await ethers.provider.getBlock(receipt.blockNumber)
      return { key: id(), block, stored: await ledger.getRequest(id()) }
    }
    return {
      owner,
      payer,
      redeemer,
      stranger,
      ledger,
      bank,
      admission,
      id,
      frame,
      request,
      pending,
    }
  }

  it("captures deadline, fees and liability and moves exactly gross through Bank", async () => {
    const f = await fixture()
    const { key, block, stored } = await f.pending()
    expect(stored.walletId).to.equal(f.admission.walletId)
    expect(stored.descriptorHash).to.equal(f.admission.descriptorHash)
    expect(stored.redeemer).to.equal(f.redeemer.address)
    expect(stored.gross).to.equal(10000)
    expect(stored.treasuryFee).to.equal(100)
    expect(stored.maximumBitcoinFee).to.equal(500)
    expect(stored.deadline).to.equal(block.timestamp + 100)
    expect(stored.finalityBlocks).to.equal(3)
    expect(stored.timeoutBlock).to.equal(0)
    expect(stored.reservationId).to.equal(ethers.constants.HashZero)
    expect(stored.state).to.equal(1)
    expect(stored.script).to.equal(f.admission.script)
    expect(await f.ledger.nonce(f.admission.walletId)).to.equal(1)
    expect(await f.ledger.escrow(f.admission.walletId)).to.equal(10000)
    expect(await f.ledger.netLiability(f.admission.walletId)).to.equal(9900)
    expect(await f.bank.balanceOf(f.payer.address)).to.equal(40000)
    expect(await f.bank.balanceOf(f.ledger.address)).to.equal(10000)
    expect(await f.bank.balanceOf(f.redeemer.address)).to.equal(0)
    expect(await f.bank.allowance(f.payer.address, f.ledger.address)).to.equal(
      30000
    )
    expect(await f.bank.nonces(f.payer.address)).to.equal(0)
    expect(key).to.equal(f.id())
  })

  it("rolls back the entire frame for absent/insufficient allowance and insufficient balance", async () => {
    for (const mode of ["no allowance", "short allowance", "short balance"]) {
      const f = await fixture()
      await f.pending() // Preserve a real unrelated request and escrow across failure.
      await f.bank.connect(f.payer).approveBalance(f.ledger.address, 0)
      if (mode === "short balance") {
        await f.bank.connect(f.payer).transferBalance(f.stranger.address, 35000)
        await f.bank.connect(f.payer).approveBalance(f.ledger.address, 20000)
      } else
        await f.bank
          .connect(f.payer)
          .approveBalance(f.ledger.address, mode === "no allowance" ? 0 : 9999)
      const before = await f.frame()
      await expect(f.request()).to.be.revertedWith(
        mode === "short balance"
          ? "Transfer amount exceeds balance"
          : "Transfer amount exceeds allowance"
      )
      expect(await f.frame()).to.deep.equal(before)
    }
  })

  it("refuses zero/nonpositive net payouts, full-width invalid amounts and malformed policy/scripts without financial changes", async () => {
    const f = await fixture()
    const cases = [
      { gross: "0" },
      { gross: "100", treasuryFee: "100" },
      { gross: "100", treasuryFee: "101" },
      { gross: "600", treasuryFee: "100", maximumBitcoinFee: "500" },
      { gross: "601", treasuryFee: "100", maximumBitcoinFee: "501" },
      { gross: "2100000000000001" },
      { gross: uint64Max },
      { treasuryFee: uint64Max },
      { maximumBitcoinFee: uint64Max },
      { timeoutSeconds: "0" },
      { finalityBlocks: "0" },
      { timeoutSeconds: uint64Max },
      { walletId: ethers.constants.HashZero },
      { descriptorHash: ethers.constants.HashZero },
      { redeemer: ethers.constants.AddressZero },
      { script: "0x" },
      { script: "0x0014" },
      { script: `0x5120${"11".repeat(32)}` },
    ]
    for (const update of cases) {
      const admission = { ...f.admission, ...update }
      const ids = [f.id(), f.id(1, admission)]
      const before = await f.frame(ids)
      await expect(f.request(admission)).to.be.reverted
      expect(await f.frame(ids)).to.deep.equal(before)
      expect(await f.ledger.nonce(admission.walletId)).to.equal(0)
      expect(await f.ledger.escrow(admission.walletId)).to.equal(0)
      expect(await f.ledger.netLiability(admission.walletId)).to.equal(0)
    }
  })

  it("rejects signed-negative and above-uint64 input at ABI encoding without sending a transaction", async () => {
    const f = await fixture()
    const before = await f.frame()
    for (const gross of ["-1", "18446744073709551616"]) {
      let refused = false
      try {
        f.ledger.interface.encodeFunctionData("request", [
          { ...f.admission, gross },
        ])
      } catch {
        refused = true
      }
      expect(refused).to.equal(true)
    }
    expect(await f.frame()).to.deep.equal(before)
  })

  it("accepts the supply boundary and prevents cumulative escrow exceeding it", async () => {
    const f = await fixture()
    await f.ledger.creditForTest(f.payer.address, maximum)
    await f.bank.connect(f.payer).approveBalance(f.ledger.address, 0)
    await f.bank
      .connect(f.payer)
      .approveBalance(f.ledger.address, ethers.constants.MaxUint256)
    const input = { ...f.admission, gross: maximum }
    await f.request(input)
    expect(await f.ledger.escrow(input.walletId)).to.equal(maximum)
    expect(await f.ledger.netLiability(input.walletId)).to.equal(
      ethers.BigNumber.from(maximum).sub(input.treasuryFee)
    )
    expect(await f.bank.allowance(f.payer.address, f.ledger.address)).to.equal(
      ethers.constants.MaxUint256
    )
    const before = await f.frame()
    await expect(f.request()).to.be.revertedWith("FROST escrow capacity")
    expect(await f.frame()).to.deep.equal(before)
  })

  it("rejects early/repeated timeout, observes at the inclusive deadline, and preserves escrow", async () => {
    const f = await fixture()
    const { key, stored } = await f.pending()
    let before = await f.frame()
    await expect(
      f.ledger.connect(f.stranger).observeTimeout(key)
    ).to.be.revertedWith("FROST deadline not reached")
    expect(await f.frame()).to.deep.equal(before)
    await network.provider.send("evm_setNextBlockTimestamp", [
      stored.deadline.toNumber(),
    ])
    const receipt = await (
      await f.ledger.connect(f.stranger).observeTimeout(key)
    ).wait()
    const pending = await f.ledger.getRequest(key)
    expect(pending.state).to.equal(3)
    expect(pending.timeoutBlock).to.equal(receipt.blockNumber)
    expect(pending.deadline).to.equal(stored.deadline)
    expect(await f.ledger.escrow(f.admission.walletId)).to.equal(10000)
    expect(await f.ledger.netLiability(f.admission.walletId)).to.equal(9900)
    expect(await f.bank.balanceOf(f.ledger.address)).to.equal(10000)
    before = await f.frame()
    await expect(f.ledger.observeTimeout(key)).to.be.revertedWith(
      "FROST timeout state"
    )
    expect(await f.frame()).to.deep.equal(before)
  })

  it("refunds exactly once at the finality boundary to the captured redeemer and clears only its liability", async () => {
    const f = await fixture()
    const { key, stored } = await f.pending()
    await f.request() // Separate request must remain Requested and funded.
    expect(await f.ledger.netLiability(f.admission.walletId)).to.equal(19800)
    const other = await f.ledger.getRequest(f.id(2))
    await network.provider.send("evm_setNextBlockTimestamp", [
      stored.deadline.toNumber(),
    ])
    const receipt = await (await f.ledger.observeTimeout(key)).wait()
    let before = await f.frame()
    await expect(
      f.ledger.connect(f.stranger).refundUnreserved(key)
    ).to.be.revertedWith("FROST timeout not final")
    expect(await f.frame()).to.deep.equal(before)
    // Mine to one block before the boundary; the refund transaction lands at equality.
    const current = await ethers.provider.getBlockNumber()
    const count =
      receipt.blockNumber + stored.finalityBlocks.toNumber() - 1 - current
    for (let i = 0; i < count; i++) await network.provider.send("evm_mine")
    const refund = await (
      await f.ledger.connect(f.stranger).refundUnreserved(key)
    ).wait()
    expect(refund.blockNumber).to.equal(receipt.blockNumber + 3)
    expect((await f.ledger.getRequest(key)).state).to.equal(5)
    expect(await f.ledger.escrow(f.admission.walletId)).to.equal(10000)
    expect(await f.ledger.netLiability(f.admission.walletId)).to.equal(9900)
    expect(await f.bank.balanceOf(f.ledger.address)).to.equal(10000)
    expect(await f.bank.balanceOf(f.redeemer.address)).to.equal(10000)
    expect(await f.bank.balanceOf(f.payer.address)).to.equal(30000)
    expect(await f.bank.allowance(f.payer.address, f.ledger.address)).to.equal(
      20000
    )
    expect(
      ethers.utils.defaultAbiCoder.encode(
        [requestType],
        [await f.ledger.getRequest(f.id(2))]
      )
    ).to.equal(ethers.utils.defaultAbiCoder.encode([requestType], [other]))
    before = await f.frame()
    await expect(f.ledger.refundUnreserved(key)).to.be.revertedWith(
      "FROST reservation retains escrow"
    )
    expect(await f.frame()).to.deep.equal(before)
  })

  it("clears the last gross escrow and captured net liability on refund", async () => {
    const f = await fixture()
    const { key, stored } = await f.pending()
    await network.provider.send("evm_setNextBlockTimestamp", [
      stored.deadline.toNumber(),
    ])
    await f.ledger.observeTimeout(key)
    await network.provider.send("hardhat_mine", ["0x3"])
    await f.ledger.refundUnreserved(key)
    expect(await f.ledger.escrow(f.admission.walletId)).to.equal(0)
    expect(await f.ledger.netLiability(f.admission.walletId)).to.equal(0)
    expect(await f.bank.balanceOf(f.ledger.address)).to.equal(0)
    expect(await f.bank.balanceOf(f.redeemer.address)).to.equal(10000)
    expect(await f.ledger.nonce(f.admission.walletId)).to.equal(1)
  })

  it("rejects unknown/forged IDs and refunds before timeout without changing the complete frame", async () => {
    const f = await fixture()
    await f.pending()
    const forged = ethers.utils.id("forged reservation/request")
    const before = await f.frame([f.id(), forged])
    await expect(f.ledger.refundUnreserved(f.id())).to.be.revertedWith(
      "FROST reservation retains escrow"
    )
    await expect(f.ledger.refundUnreserved(forged)).to.be.revertedWith(
      "FROST reservation retains escrow"
    )
    await expect(f.ledger.observeTimeout(forged)).to.be.revertedWith(
      "FROST timeout state"
    )
    expect(await f.frame([f.id(), forged])).to.deep.equal(before)
  })

  it("restricts synthetic credit and payer admission to their fixture authorities", async () => {
    const f = await fixture()
    const before = await f.frame()
    await expect(
      f.ledger.connect(f.stranger).creditForTest(f.stranger.address, 10000)
    ).to.be.revertedWith("Fixture owner only")
    await expect(
      f.ledger.connect(f.stranger).request(f.admission)
    ).to.be.revertedWith("Fixture balance owner")
    expect(await f.frame()).to.deep.equal(before)
  })
})
