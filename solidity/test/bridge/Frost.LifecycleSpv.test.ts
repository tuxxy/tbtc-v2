import { ethers } from "hardhat"
import { expect } from "chai"
import vector from "../data/k09-mainnet-spv.json"

// Retained mainnet vector from BitcoinTx.test.ts (bitcoin-spv v3.4.0).
// This is deliberately separate from the live zero-difficulty regtest run.
// The real BitcoinTx validation uses the mainnet deployment's factor six.
describe("K-09 realistic-header SPV at production difficulty factor", () => {
  let relay: any
  let validator: any
  const mutate = (value: string, byte: number) => {
    const bytes = Buffer.from(value.slice(2), "hex")
    bytes[byte] ^= 1
    return `0x${bytes.toString("hex")}`
  }
  before(async () => {
    relay = await (await ethers.getContractFactory("SystemTestRelay")).deploy()
    validator = await (
      await ethers.getContractFactory("FrostLifecycleSpvFixture")
    ).deploy(relay.address)
    await relay.setCurrentEpochDifficultyFromHeaders(vector.proof.bitcoinHeaders)
  })

  it("accepts six real mainnet headers, inclusion and coinbase at nonzero epoch difficulty", async () => {
    expect(await relay.getCurrentEpochDifficulty()).to.equal(7019199231177)
    expect((vector.proof.bitcoinHeaders.length - 2) / 160).to.equal(6)
    expect(await validator.validate(vector.txInfo, vector.proof)).to.equal(
      vector.txHash
    )
  })

  it("rejects five valid headers at the accumulated-work guard", async () => {
    await expect(
      validator.validate(vector.txInfo, {
        ...vector.proof,
        bitcoinHeaders: vector.proof.bitcoinHeaders.slice(0, 2 + 5 * 160),
      })
    ).to.be.revertedWith("Insufficient accumulated difficulty in header chain")
  })

  it("rejects an invalid link at the header-chain guard", async () => {
    await expect(
      validator.validate(vector.txInfo, {
        ...vector.proof,
        bitcoinHeaders: mutate(vector.proof.bitcoinHeaders, 80 + 4),
      })
    ).to.be.revertedWith("Invalid headers chain")
  })

  it("rejects a changed last-header nonce at the proof-of-work guard", async () => {
    await expect(
      validator.validate(vector.txInfo, {
        ...vector.proof,
        bitcoinHeaders: mutate(vector.proof.bitcoinHeaders, 5 * 80 + 76),
      })
    ).to.be.revertedWith("Insufficient work in a header")
  })

  it("rejects changed transaction inclusion at its merkle guard", async () => {
    await expect(
      validator.validate(vector.txInfo, {
        ...vector.proof,
        merkleProof: mutate(vector.proof.merkleProof, 0),
      })
    ).to.be.revertedWith(
      "Tx merkle proof is not valid for provided header and tx hash"
    )
  })

  it("rejects changed coinbase inclusion at its merkle guard", async () => {
    await expect(
      validator.validate(vector.txInfo, {
        ...vector.proof,
        coinbaseProof: mutate(vector.proof.coinbaseProof, 0),
      })
    ).to.be.revertedWith(
      "Coinbase merkle proof is not valid for provided header and hash"
    )
  })
})
