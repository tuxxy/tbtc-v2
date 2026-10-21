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

describe("FROST funding public configuration and deployment", () => {
  async function fixture() {
    const [governance, other, treasury] = await ethers.getSigners()
    const bank = await deploy("Bank")
    const implementation = await deploy("Bridge")
    const admin = await deploy("ProxyAdmin")
    // Placeholder relay/registry/pool: these tests exercise configuration only.
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
    const frost = await ethers.getContractAt("IFrostBridge", proxy.address)
    const verifier = await deploy("FrostVerifier")
    const hash = ethers.utils.keccak256(
      await ethers.provider.getCode(verifier.address)
    )
    return {
      governance,
      other,
      bank,
      frost,
      verifier,
      hash,
      bridge: implementation.attach(proxy.address),
    }
  }
  it("preserves the legacy SPV-maintainer gate through the real Bridge fallback", async () => {
    const f = await fixture()
    const funding = await ethers.getContractAt(
      "IFrostFundingBridge",
      f.frost.address
    )
    const transaction = {
      version: "0x02000000",
      inputVector: "0x00",
      outputVector: "0x00",
      locktime: "0x00000000",
    }
    const proof = {
      merkleProof: "0x",
      txIndexInBlock: 0,
      bitcoinHeaders: "0x",
      coinbasePreimage: ethers.constants.HashZero,
      coinbaseProof: "0x",
    }
    const request = {
      walletId: ethers.constants.HashZero,
      transaction,
      proof,
      includeMain: false,
      vault: ethers.constants.AddressZero,
    }
    const frame = async () =>
      JSON.stringify(
        await Promise.all([
          f.bank.balanceOf(f.governance.address),
          f.bank.balanceOf(f.other.address),
          f.bank.balanceOf(f.frost.address),
          f.bank.allowance(f.other.address, f.frost.address),
          funding.frostCustodyOutput(ethers.constants.HashZero),
          f.bridge.spentMainUTXOs(ethers.constants.HashZero),
        ])
      )
    const before = await frame()
    await expect(
      funding.connect(f.other).submitFrostDepositSweepProof(request)
    ).revertedWith("Caller is not SPV maintainer")
    expect(await frame()).eq(before)
    await f.bridge.setSpvMaintainerStatus(f.other.address, true)
    await expect(
      funding.connect(f.other).submitFrostDepositSweepProof(request)
    ).revertedWith("FROST sweep wallet")
    expect(await frame()).eq(before)
    await f.bridge.setSpvMaintainerStatus(f.other.address, false)
    await expect(
      funding.connect(f.other).submitFrostDepositSweepProof(request)
    ).revertedWith("Caller is not SPV maintainer")
    expect(await frame()).eq(before)
  })

  it("deploys fixed links under EIP170 and keeps uninstalled gates closed", async () => {
    const f = await fixture()
    await expect(f.frost.setFrostFundingGates(true, true)).revertedWith(
      "FROST funding not installed"
    )
    expect(await f.bank.balanceOf(f.frost.address)).eq(0)
  })
  it("authenticates one-time installation, exact code, and nonzero approval/network", async () => {
    const f = await fixture()
    const record = ethers.utils.id(
      "UNQUALIFIED local fixture approval reference"
    )
    const genesis = ethers.utils.id("controlled genesis")
    await expect(
      f.frost
        .connect(f.other)
        .configureFrostFunding(f.verifier.address, f.hash, record, genesis)
    ).revertedWith("Caller is not governance")
    await expect(
      f.frost.configureFrostFunding(
        f.verifier.address,
        ethers.constants.HashZero,
        record,
        genesis
      )
    ).revertedWith("FROST funding installation")
    await expect(
      f.frost.configureFrostFunding(
        f.verifier.address,
        f.hash,
        ethers.constants.HashZero,
        genesis
      )
    ).revertedWith("FROST funding installation")
    await expect(
      f.frost.configureFrostFunding(
        f.verifier.address,
        f.hash,
        record,
        ethers.constants.HashZero
      )
    ).revertedWith("FROST funding installation")
    await expect(
      f.frost.configureFrostFunding(f.verifier.address, f.hash, record, genesis)
    )
      .emit(f.frost, "FrostFundingInstalled")
      .withArgs(f.verifier.address, f.hash, record, genesis)
    await expect(
      f.frost.configureFrostFunding(f.verifier.address, f.hash, record, genesis)
    ).revertedWith("FROST funding already installed")
    // C-10: no gate opens before the exposure controller is installed.
    await expect(f.frost.setFrostFundingGates(true, false)).revertedWith(
      "FROST exposure not installed"
    )
    await expect(f.frost.setFrostFundingGates(false, true)).revertedWith(
      "FROST exposure not installed"
    )
    const exposure = await deploy("FrostExposureController", [
      f.frost.address,
      f.governance.address,
    ])
    await f.frost.installFrostExposureController(exposure.address)
    await expect(
      f.frost.connect(f.other).setFrostFundingGates(true, false)
    ).revertedWith("Caller is not governance")
    await expect(f.frost.setFrostFundingGates(true, false))
      .emit(f.frost, "FrostFundingGatesChanged")
      .withArgs(true, false)
    await expect(f.frost.setFrostFundingGates(false, true))
      .emit(f.frost, "FrostFundingGatesChanged")
      .withArgs(false, true)
    await expect(f.frost.setFrostFundingGates(false, false))
      .emit(f.frost, "FrostFundingGatesChanged")
      .withArgs(false, false)
    expect(await f.bank.balanceOf(f.frost.address)).eq(0)
  })
})
