/* eslint-disable no-await-in-loop, no-restricted-syntax */
// Public dispatch component only. Controlled registry readiness, known scalar 3,
// prototype verifier and zero regtest difficulty do not qualify K-03/G-F/threshold signing.
import { artifacts, ethers } from "hardhat"
import { expect } from "chai"
import fs from "fs"
import path from "path"
import {
  evidenceDirectory,
  prepareEvidenceDirectory,
} from "./frost-test-isolation"
import runCoreWitnessCheck, { validateDepositAmount } from "./frost-bitcoin"

export const DESCRIPTOR_TYPE =
  "tuple(uint8 scheme,uint8 profile,uint256 chainId,address registry,uint64 epoch,uint32[] members,address[] operators,uint16 threshold,bytes32 snowfallDescriptor,bytes32 outputKey)"
export const WALLET_TYPE = `tuple(${DESCRIPTOR_TYPE} descriptor,bytes32 id,bytes32 descriptorHash,uint64 deadline,uint8 state,bool quarantined,uint32 generation,uint32 capabilityVersion)`
export const rawTxHash = (txid: string) =>
  `0x${Buffer.from(txid, "hex").reverse().toString("hex")}`
export const outpointKey = (txHash: string, index: number) =>
  ethers.utils.solidityKeccak256(["bytes32", "uint32"], [txHash, index])
export const bitcoinInfo = (t: any) => ({
  version: t.version,
  inputVector: t.inputVector,
  outputVector: t.outputVector,
  locktime: t.locktime,
})
export const bitcoinProof = (p: any) => ({
  merkleProof: p.merkleProof,
  txIndexInBlock: p.txIndexInBlock,
  bitcoinHeaders: p.bitcoinHeaders,
  coinbasePreimage: p.coinbasePreimage,
  coinbaseProof: p.coinbaseProof,
})

export async function publicFundedFixture(
  options: {
    evidenceDirectory?: string
    digestBinary?: string
    depositAmount?: number
  } = {}
) {
  const depositAmount = validateDepositAmount(options.depositAmount)
  const sweepAmount = depositAmount - 1000
  const treasuryFee = Math.floor(depositAmount / 100)
  const depositorCredit = sweepAmount - treasuryFee
  const evidence =
    options.evidenceDirectory ||
    process.env.FROST_C04_PUBLIC_EVIDENCE ||
    evidenceDirectory("public-funding")
  const digest = options.digestBinary || process.env.FROST_C04_DIGEST_BINARY
  prepareEvidenceDirectory(evidence)
  const runtimeSizes: any[] = []
  const cache = new Map<string, string>()
  async function deploy(name: string, args: unknown[] = []): Promise<any> {
    const a = await artifacts.readArtifact(name)
    expect((a.deployedBytecode.length - 2) / 2, name).to.be.at.most(24576)
    let { bytecode } = a
    for (const [source, libraries] of Object.entries(a.linkReferences)) {
      for (const [library, positions] of Object.entries(libraries)) {
        const key = `${source}:${library}`
        if (!cache.has(key)) cache.set(key, (await deploy(key)).address)
        const address = cache.get(key)!
        for (const p of positions)
          bytecode =
            bytecode.slice(0, 2 + p.start * 2) +
            address.slice(2) +
            bytecode.slice(2 + (p.start + p.length) * 2)
      }
    }
    const [signer] = await ethers.getSigners()
    const c = await new ethers.ContractFactory(a.abi, bytecode, signer).deploy(
      ...args
    )
    await c.deployed()
    const code = await ethers.provider.getCode(c.address)
    expect((code.length - 2) / 2, name).to.be.at.most(24576)
    runtimeSizes.push({
      name,
      address: c.address,
      bytes: (code.length - 2) / 2,
      keccak256: ethers.utils.keccak256(code),
    })
    return c
  }
  const [governance, depositor, treasury, ...remaining] =
    await ethers.getSigners()
  const operators = remaining.slice(0, 3)
  const bank = await deploy("Bank")
  const relay = await deploy("FrostPublicFundingRegtestRelay")
  const verifier = await deploy("FrostVerifier")
  const implementation = await deploy("Bridge")
  const admin = await deploy("ProxyAdmin")
  // Legacy registry/reimbursement placeholders are unused here; the real public
  // FROST registry is installed below and the real relay validates Bitcoin proofs.
  const initialization = implementation.interface.encodeFunctionData(
    "initialize",
    [
      bank.address,
      relay.address,
      treasury.address,
      governance.address,
      governance.address,
      1,
    ]
  )
  const proxy = await deploy("TransparentUpgradeableProxy", [
    implementation.address,
    admin.address,
    initialization,
  ])
  const bridge = implementation.attach(proxy.address)
  await (await bridge.setSpvMaintainerStatus(governance.address, true)).wait()
  const frost = await ethers.getContractAt("IFrostBridge", bridge.address)
  await (await bank.updateBridge(bridge.address)).wait()
  // Public governance enforces dust > maximum fee, hence 3000 rather than 1000.
  await (await bridge.updateDepositParameters(3000, 100, 2000, 30)).wait()
  const registry = await deploy("FrostPublicFundingRegistryFixture", [
    bridge.address,
  ])
  await (await frost.configureFrostRegistry(registry.address)).wait()
  await (await frost.setFrostRequestsEnabled(true)).wait()
  await (await frost.requestNewFrostWallet()).wait()
  expect(await registry.requests()).to.equal(1)
  const { chainId } = await ethers.provider.getNetwork()
  const descriptor = {
    scheme: 2,
    profile: 1,
    chainId,
    registry: registry.address,
    epoch: await ethers.provider.getBlockNumber(),
    members: [1, 2, 3],
    operators: operators.map((s) => s.address),
    threshold: 2,
    snowfallDescriptor: ethers.utils.id(
      "UNQUALIFIED controlled public registry descriptor root"
    ),
    outputKey:
      "0xf9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
  }
  const descriptorHash = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["bytes32", DESCRIPTOR_TYPE],
      [ethers.utils.id("tbtc-v2/frost-descriptor/v1"), descriptor]
    )
  )
  const walletId = ethers.utils.keccak256(
    ethers.utils.concat([
      ethers.utils.id("tbtc-v2/frost-wallet-id/v1"),
      descriptor.outputKey,
    ])
  )
  const label = walletId.slice(0, 42)
  await (
    await registry.created(
      ethers.utils.defaultAbiCoder.encode([DESCRIPTOR_TYPE], [descriptor]),
      descriptor.epoch + 10000
    )
  ).wait()
  await (await registry.ready(walletId, descriptorHash)).wait()
  const walletView = async () =>
    ethers.utils.defaultAbiCoder.decode(
      [WALLET_TYPE],
      await frost.walletDescriptor(label)
    )[0]
  expect((await walletView()).state).to.equal(3)
  expect((await walletView()).descriptorHash).to.equal(descriptorHash)
  expect(await frost.resolveWallet(registry.address, walletId)).to.equal(label)
  const latest = await ethers.provider.getBlock("latest")
  const coreWitness = await runCoreWitnessCheck(
    path.join(evidence, "core"),
    digest,
    {
      chainId: String(chainId),
      bridge: bridge.address,
      depositor: depositor.address,
      vault: ethers.constants.AddressZero,
      descriptorHash,
      refundLocktime:
        Math.max(latest.timestamp, Math.floor(Date.now() / 1000)) + 1800,
    },
    { depositAmount }
  )
  expect(coreWitness.walletKey).to.equal(descriptor.outputKey)
  expect(coreWitness.terms.fullWalletId).to.equal(walletId)
  const genesis = coreWitness.terms.bitcoinGenesis
  await (
    await frost.configureFrostFunding(
      verifier.address,
      ethers.utils.keccak256(await ethers.provider.getCode(verifier.address)),
      ethers.utils.id(
        "UNQUALIFIED component installation reference; not G-F approval"
      ),
      genesis
    )
  ).wait()
  await (await frost.setFrostFundingGates(true, true)).wait()
  expect(await bank.balanceOf(depositor.address)).to.equal(0)
  expect((await frost.frostWalletCustody(walletId)).value).to.equal(0)
  const coreInput = coreWitness.sweep.input
  await (
    await frost
      .connect(depositor)
      .revealFrostDeposit(
        coreWitness.terms,
        bitcoinInfo(coreWitness.funding[0].transaction),
        coreInput.index
      )
  ).wait()
  expect(await bank.balanceOf(depositor.address)).to.equal(0)
  expect((await frost.frostWalletCustody(walletId)).value).to.equal(0)
  const sweep = {
    walletId,
    transaction: bitcoinInfo(coreWitness.sweep.transaction),
    proof: bitcoinProof(coreWitness.sweep.proof),
    includeMain: false,
    vault: ethers.constants.AddressZero,
  }
  await (await frost.submitFrostDepositSweepProof(sweep)).wait()
  const custodyUTXO = {
    txHash: rawTxHash(coreWitness.sweep.txid),
    txOutputIndex: 0,
    txOutputValue: sweepAmount,
  }
  expect(await bank.balanceOf(depositor.address)).to.equal(depositorCredit)
  expect(await bank.balanceOf(treasury.address)).to.equal(treasuryFee)
  expect(await bank.balanceOf(bridge.address)).to.equal(0)
  const custody = await frost.frostWalletCustody(walletId)
  expect(custody.value).to.equal(sweepAmount)
  expect(custody.mainOutpoint).to.equal(outpointKey(custodyUTXO.txHash, 0))
  expect((await walletView()).state).to.equal(4)
  fs.writeFileSync(
    path.join(evidence, "public-origin.json"),
    `${JSON.stringify(
      {
        scope:
          "Actual public Bridge proxy/Bank/Core SPV component; controlled registry readiness, prototype verifier, known scalar 3 and zero-difficulty relay; no K-03/G-F/threshold qualification",
        bridge: bridge.address,
        bank: bank.address,
        descriptor,
        descriptorHash,
        walletId,
        genesis,
        custodyUTXO,
        coreInput,
        amount: depositAmount,
        depositorCredit,
        treasuryCredit: treasuryFee,
        custody: sweepAmount,
        productionQualification: false,
        runtimeSizes,
      },
      null,
      2
    )}\n`
  )
  return {
    bridge,
    frost,
    bank,
    depositor,
    operators,
    descriptor,
    descriptorHash,
    walletId,
    genesis,
    custodyUTXO,
    coreWitness,
    governance,
    treasury,
    registry,
    relay,
    verifier,
    admin,
    implementation,
    sweep,
    walletView,
    coreInput,
    fullWalletId: walletId,
    recordedCustodyUTXO: custodyUTXO,
  }
}
export default publicFundedFixture
