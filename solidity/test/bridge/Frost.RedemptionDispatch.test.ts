/* eslint-disable no-await-in-loop, no-restricted-syntax */
import { artifacts, ethers } from "hardhat"
import { expect } from "chai"

// Real recursive library links; the network must retain the EIP-170 limit.
async function deploy(
  name: string,
  args: unknown[] = [],
  cache = new Map<string, string>()
): Promise<any> {
  const artifact = await artifacts.readArtifact(name)
  expect((artifact.deployedBytecode.length - 2) / 2, name).to.be.at.most(24576)
  let { bytecode } = artifact
  for (const [source, libraries] of Object.entries(artifact.linkReferences)) {
    for (const [library, positions] of Object.entries(libraries)) {
      const key = `${source}:${library}`
      if (!cache.has(key))
        cache.set(key, (await deploy(key, [], cache)).address)
      for (const position of positions)
        bytecode =
          bytecode.slice(0, 2 + position.start * 2) +
          cache.get(key)!.slice(2) +
          bytecode.slice(2 + (position.start + position.length) * 2)
    }
  }
  const [signer] = await ethers.getSigners()
  const contract = await new ethers.ContractFactory(
    artifact.abi,
    bytecode,
    signer
  ).deploy(...args)
  await contract.deployed()
  expect(
    (await ethers.provider.getCode(contract.address)).length / 2 - 1
  ).to.be.at.most(24576)
  return contract
}

describe("FROST Bridge dispatch small checkpoint", () => {
  async function fixture() {
    const [governance, other, treasury] = await ethers.getSigners()
    const bank = await deploy("Bank")
    const implementation = await deploy("Bridge")
    const admin = await deploy("ProxyAdmin")
    // Relay/registry/pool placeholders are initialization-only: no proof or
    // custody operation is exercised by this small configuration checkpoint.
    const data = implementation.interface.encodeFunctionData("initialize", [
      bank.address,
      other.address,
      treasury.address,
      other.address,
      other.address,
      1,
    ])
    const proxy = await deploy("TransparentUpgradeableProxy", [
      implementation.address,
      admin.address,
      data,
    ])
    await bank.updateBridge(proxy.address)
    const bridge = implementation.attach(proxy.address)
    const frost = await ethers.getContractAt("IFrostBridge", proxy.address)
    return { governance, other, bank, bridge, frost }
  }

  it("refuses enabling redemption against a different or uninstalled funding network", async () => {
    const f = await fixture()
    await f.frost.configureFrostRedemptions(
      ethers.utils.id("redemption genesis"),
      2,
      1000,
      ethers.constants.AddressZero,
      ethers.utils.id("local D08 reference")
    )
    await expect(f.frost.setFrostRedemptionsEnabled(true)).revertedWith(
      "FROST redemption funding network"
    )
    const verifier = await deploy("FrostVerifier")
    const hash = ethers.utils.keccak256(
      await ethers.provider.getCode(verifier.address)
    )
    await f.frost.configureFrostFunding(
      verifier.address,
      hash,
      ethers.utils.id("local unqualified record"),
      ethers.utils.id("different funding genesis")
    )
    const before = await f.frost.frostRedemptionConfiguration()
    await expect(f.frost.setFrostRedemptionsEnabled(true)).revertedWith(
      "FROST redemption funding network"
    )
    expect(await f.frost.frostRedemptionConfiguration()).deep.eq(before)
    await f.frost.setFrostRedemptionsEnabled(false)
  })

  it("deploys links within EIP-170 and refuses a disabled public request", async () => {
    const f = await fixture()
    const id = ethers.utils.id("unregistered request")
    const before = await f.frost.frostRedemptionConfiguration()
    await expect(
      f.frost
        .connect(f.other)
        .requestFrostRedemption(
          id,
          `0x0014${"11".repeat(20)}`,
          10000,
          f.other.address
        )
    ).to.be.revertedWith("FROST redemptions disabled")
    expect(await f.frost.frostRedemptionConfiguration()).to.deep.equal(before)
    const escrow = await f.frost.frostRedemptionEscrow(id)
    expect(escrow.gross).to.equal(0)
    expect(escrow.netLiability).to.equal(0)
    expect(await f.bank.balanceOf(f.bridge.address)).to.equal(0)
  })

  it("restricts public configuration to governance and preserves legacy values", async () => {
    const f = await fixture()
    const beforeParameters = await f.bridge.redemptionParameters()
    const beforeGovernance = await f.bridge.governance()
    const beforeConfig = await f.frost.frostRedemptionConfiguration()
    const args = [
      ethers.utils.id("controlled genesis"),
      3,
      1000,
      ethers.constants.AddressZero,
      ethers.utils.id("controlled evidence reference"),
    ]
    await expect(
      f.frost.connect(f.other).configureFrostRedemptions(...args)
    ).to.be.revertedWith("Caller is not governance")
    expect(await f.frost.frostRedemptionConfiguration()).to.deep.equal(
      beforeConfig
    )
    await f.frost.configureFrostRedemptions(...args)
    const configured = await f.frost.frostRedemptionConfiguration()
    expect(configured.bitcoinGenesis).to.equal(args[0])
    expect(configured.finalityBlocks).to.equal(3)
    expect(configured.maximumCertificateBlocks).to.equal(1000)
    expect(configured.enabled).to.equal(false)
    expect(configured.legacyTransitionEvidence).to.equal(args[4])
    await expect(
      f.frost.connect(f.other).setFrostRedemptionsEnabled(true)
    ).to.be.revertedWith("Caller is not governance")
    expect(await f.bridge.redemptionParameters()).to.deep.equal(
      beforeParameters
    )
    expect(await f.bridge.governance()).to.equal(beforeGovernance)
    expect(await f.bank.bridge()).to.equal(f.bridge.address)
  })
})
