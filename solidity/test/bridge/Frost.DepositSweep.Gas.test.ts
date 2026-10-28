/* eslint-disable no-await-in-loop, no-restricted-syntax */
// F5 gas component measurements only: actual Bridge/proxy, verifier, Bank
// and TBTCVault; controlled registry metadata and synthetic regtest SPV headers.
// No Bitcoin Core script acceptance, production finality or qualification claim.
import { artifacts, ethers, network } from "hardhat"
import { expect } from "chai"
import fs from "fs"
import path from "path"
import * as secp from "@noble/secp256k1"
import {
  baseTerms,
  unsigned,
  toHex,
  compact,
  encodeProfile,
  NUMS,
  tagged,
  fromHex,
} from "../data/frost/deposit-profile"

const Q = "0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
const TYPE =
  "tuple(uint8 scheme,uint8 profile,uint256 chainId,address registry,uint64 epoch,uint32[] members,address[] operators,uint16 threshold,bytes32 snowfallDescriptor,bytes32 outputKey)"
const ID = ethers.utils.keccak256(
  ethers.utils.hexConcat([ethers.utils.id("tbtc-v2/frost-wallet-id/v1"), Q])
)
const ZERO = ethers.constants.AddressZero
const hash256 = (bytes: string) =>
  ethers.utils.sha256(ethers.utils.sha256(bytes))
const txHash = (tx: any) =>
  hash256(
    ethers.utils.hexConcat([
      tx.version,
      tx.inputVector,
      tx.outputVector,
      tx.locktime,
    ])
  )
const outpoint = (hash: string, index = 0) =>
  ethers.utils.solidityKeccak256(["bytes32", "uint32"], [hash, index])
const entry = (hash: string, index = 0, script = "00") =>
  `${hash.slice(2)}${toHex(unsigned(index, 4, true)).slice(2)}${script}ffffffff`
const output = (value: string | number, key = Q) =>
  `${toHex(unsigned(value, 8, true)).slice(2)}225120${key.slice(2)}`

async function deploy(
  name: string,
  args: any[] = [],
  cache = new Map<string, string>()
): Promise<any> {
  const a = await artifacts.readArtifact(name)
  let { bytecode } = a
  for (const [source, libraries] of Object.entries(a.linkReferences)) {
    for (const [library, positions] of Object.entries(libraries)) {
      const key = `${source}:${library}`
      if (!cache.has(key))
        cache.set(key, (await deploy(key, [], cache)).address)
      const address = cache.get(key)
      if (!address) throw Error(key)
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
  expect((await ethers.provider.getCode(c.address)).length / 2 - 1).at.most(
    24576
  )
  deployed.push({
    name,
    address: c.address,
    runtimeHash: ethers.utils.keccak256(
      await ethers.provider.getCode(c.address)
    ),
    runtimeBytes: (await ethers.provider.getCode(c.address)).length / 2 - 1,
  })
  return c
}

// Two-leaf synthetic block. The real BitcoinTx validator checks both inclusion
// paths and actual header PoW. Difficulty zero is deliberately unqualified.
function syntheticProof(tx: any) {
  const coinbasePreimage = ethers.utils.id(
    "synthetic coinbase preimage, not Core"
  )
  const coinbaseHash = ethers.utils.sha256(coinbasePreimage)
  const hash = txHash(tx)
  const root = hash256(ethers.utils.hexConcat([coinbaseHash, hash]))
  const header = Buffer.alloc(80)
  header.writeUInt32LE(2, 0)
  Buffer.from(root.slice(2), "hex").copy(header, 36)
  header.writeUInt32LE(1700000000, 68)
  header.writeUInt32LE(0x207fffff, 72)
  const target = BigInt("0x7fffff") * BigInt(2) ** BigInt(232)
  for (let nonce = 0; ; nonce += 1) {
    if (nonce > 10000) throw Error("Synthetic regtest nonce search cap")
    header.writeUInt32LE(nonce, 76)
    const digest = Buffer.from(hash256(toHex(header)).slice(2), "hex").reverse()
    if (BigInt(`0x${digest.toString("hex")}`) <= target) break
  }
  return {
    merkleProof: coinbaseHash,
    txIndexInBlock: 1,
    bitcoinHeaders: toHex(header),
    coinbasePreimage,
    coinbaseProof: hash,
  }
}

const TX_CAP = 16777216
const AMOUNT = 100000
const CREDIT = 98000
const ROUTE = process.env.FROST_C05_GAS_ROUTE || "vault"
const COUNTS = (process.env.FROST_C05_GAS_COUNTS || "32,64,96,128,129")
  .split(",")
  .map(Number)
const deployed: any[] = []

describe(`C05 F5 ${ROUTE} gas component (synthetic SPV, unqualified)`, function gasMeasurements() {
  this.timeout(170000)
  let bridge: any
  let frost: any
  let bank: any
  let vault: any
  let token: any
  let treasury: any
  let hashes: string[]
  let recipients: string[]
  let leaves: number[]
  let snapshot: string
  let sourceBinding: any
  const records: any[] = []

  before(async () => {
    expect(["bank", "vault"]).to.include(ROUTE)
    expect(
      COUNTS.every((n) => Number.isInteger(n) && n > 0 && n <= 256)
    ).to.equal(true)
    const [owner, payer, second, feeRecipient] = await ethers.getSigners()
    treasury = feeRecipient
    bank = await deploy("Bank")
    const relay = await deploy("FrostDepositRegtestRelay")
    const implementation = await deploy("Bridge")
    const admin = await deploy("ProxyAdmin")
    const proxy = await deploy("TransparentUpgradeableProxy", [
      implementation.address,
      admin.address,
      implementation.interface.encodeFunctionData("initialize", [
        bank.address,
        relay.address,
        treasury.address,
        owner.address,
        owner.address,
        1,
      ]),
    ])
    bridge = implementation.attach(proxy.address)
    frost = await ethers.getContractAt("IFrostBridge", proxy.address)
    await bank.updateBridge(proxy.address)
    await bridge.setSpvMaintainerStatus(owner.address, true)
    await bridge.updateDepositParameters(10000, 100, 2000, 30)
    const registry = await deploy("FrostRegistryFixture", [proxy.address])
    await frost.configureFrostRegistry(registry.address)
    const descriptor = {
      scheme: 2,
      profile: 1,
      chainId: (await ethers.provider.getNetwork()).chainId,
      registry: registry.address,
      epoch: await ethers.provider.getBlockNumber(),
      members: [1, 2, 3],
      operators: [owner.address, payer.address, second.address],
      threshold: 2,
      snowfallDescriptor: ethers.utils.id("controlled F5 gas component"),
      outputKey: Q,
    }
    const descriptorHash = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", TYPE],
        [ethers.utils.id("tbtc-v2/frost-descriptor/v1"), descriptor]
      )
    )
    await registry.created(
      ethers.utils.defaultAbiCoder.encode([TYPE], [descriptor]),
      (await ethers.provider.getBlockNumber()) + 1000
    )
    await registry.ready(ID, descriptorHash)
    const verifier = await deploy("FrostVerifier")
    const genesis = ethers.utils.id("synthetic F5 gas network")
    await frost.configureFrostFunding(
      verifier.address,
      ethers.utils.keccak256(await ethers.provider.getCode(verifier.address)),
      ethers.utils.id("UNQUALIFIED F5 gas component"),
      genesis
    )
    // C-10: the exposure controller with test ceilings (D-10 values OPEN).
    const exposure = await deploy("FrostExposureController", [
      proxy.address,
      (await ethers.getSigners())[0].address,
    ])
    await exposure.openBudgetPeriod(
      ethers.BigNumber.from(2).pow(64).sub(1),
      ethers.BigNumber.from(2).pow(64).sub(1),
      ethers.utils.id("C-10 test budget; D-10 OPEN")
    )
    await frost.installFrostExposureController(exposure.address)
    await frost.setFrostFundingGates(true, true)
    token = await deploy("TBTC")
    vault = await deploy("TBTCVault", [
      bank.address,
      token.address,
      bridge.address,
    ])
    await token.transferOwnership(vault.address)
    await bridge.setVaultStatus(vault.address, true)
    hashes = []
    recipients = []
    leaves = []
    const locktime =
      (await ethers.provider.getBlock("latest")).timestamp + 86400
    for (let i = 0; i < Math.max(...COUNTS); i++) {
      // Deterministic fresh EOAs; only gas-paying ETH is supplied by the test.
      // Every receipt comes from reveal, never a seeded funding/custody record.
      const recipient = new ethers.Wallet(
        ethers.utils.id(`C05 F5 recipient ${i}`)
      ).address
      await network.provider.send("hardhat_impersonateAccount", [recipient])
      await network.provider.send("hardhat_setBalance", [
        recipient,
        ethers.utils.hexValue(ethers.utils.parseEther("1")),
      ])
      const terms = {
        ...baseTerms,
        chainId: String(descriptor.chainId),
        bridge: bridge.address,
        bitcoinGenesis: genesis,
        fullWalletId: ID,
        descriptorHash,
        depositor: recipient,
        vault: ROUTE === "vault" ? vault.address : ZERO,
        refundKey: Q,
        refundLocktime: locktime,
        blinding: toHex(unsigned(i + 1, 8)),
      }
      // Independent byte encoder and noble relation avoid an extra expensive
      // eth_call per setup receipt. Actual reveal enforces the C07 relation.
      const profile = encodeProfile(terms, Q)
      const tweak = BigInt(
        toHex(
          tagged(
            "TapTweak",
            Buffer.concat([fromHex(NUMS), fromHex(profile.root)])
          )
        )
      )
      if (tweak >= secp.CURVE.n) throw Error("Out-of-range test tweak")
      const q = secp.Point.fromHex(`02${NUMS.slice(2)}`).add(
        secp.Point.BASE.multiply(tweak)
      )
      const key = ethers.utils.hexZeroPad(`0x${q.x.toString(16)}`, 32)
      const tx = {
        version: "0x02000000",
        inputVector: `0x01${entry(ethers.utils.id(`F5 funding ${i}`))}`,
        outputVector: `0x01${output(AMOUNT, key)}`,
        locktime: "0x00000000",
      }
      await frost
        .connect(await ethers.getSigner(recipient))
        .revealFrostDeposit(terms, tx, 0, { gasLimit: 2000000 })
      hashes.push(txHash(tx))
      recipients.push(recipient)
      leaves.push(fromHex(profile.walletLeaf).length)
      await network.provider.send("hardhat_stopImpersonatingAccount", [
        recipient,
      ])
    }
    const builds: any[] = []
    for (const contract of [
      "contracts/bridge/Bridge.sol:Bridge",
      "contracts/vault/TBTCVault.sol:TBTCVault",
      "contracts/frost/FrostVerifier.sol:FrostVerifier",
    ]) {
      const build = await artifacts.getBuildInfo(contract)
      if (!build) throw Error(`Missing build ${contract}`)
      builds.push({
        contract,
        solcLongVersion: build.solcLongVersion,
        settings: build.input.settings,
        sourcesSHA256: Object.fromEntries(
          Object.entries(build.input.sources).map(([name, source]: any) => [
            name,
            ethers.utils.sha256(ethers.utils.toUtf8Bytes(source.content)),
          ])
        ),
      })
    }
    sourceBinding = {
      builds,
      deployed,
      proxyAddress: bridge.address,
      proxyRuntimeHash: ethers.utils.keccak256(
        await ethers.provider.getCode(bridge.address)
      ),
      blockGasLimit: (
        await ethers.provider.getBlock("latest")
      ).gasLimit.toString(),
      transactionGasLimit: TX_CAP,
      route: ROUTE,
      qualification: false,
    }
    expect(sourceBinding.blockGasLimit).to.equal("30000000")
    expect(new Set(recipients).size).to.equal(Math.max(...COUNTS))
    snapshot = await network.provider.send("evm_snapshot")
  })
  beforeEach(async () => {
    expect(await network.provider.send("evm_revert", [snapshot])).to.equal(true)
    snapshot = await network.provider.send("evm_snapshot")
  })

  COUNTS.forEach((count) => {
    it(`records ${count} distinct first credits/mints with the explicit transaction cap`, async () => {
      const transaction = {
        version: "0x02000000",
        inputVector: `0x${toHex(compact(count)).slice(2)}${hashes
          .slice(0, count)
          .map((h) => entry(h))
          .join("")}`,
        outputVector: `0x01${output(99000 * count)}`,
        locktime: "0x00000000",
      }
      const request = {
        walletId: ID,
        transaction,
        proof: syntheticProof(transaction),
        includeMain: false,
        vault: ROUTE === "vault" ? vault.address : ZERO,
      }
      const hash = txHash(transaction)
      const newKey = outpoint(hash)
      expect(await bank.balanceOf(vault.address)).to.equal(0)
      expect(await token.totalSupply()).to.equal(0)
      for (const address of recipients.slice(0, count)) {
        expect(await bank.balanceOf(address)).to.equal(0)
        expect(await token.balanceOf(address)).to.equal(0)
        expect(await vault.optimisticMintingDebt(address)).to.equal(0)
      }
      const calldata = frost.interface.encodeFunctionData(
        "submitFrostDepositSweepProof",
        [request]
      )
      // A diagnostic estimate may exceed the transaction cap. It never makes
      // such a transaction executable or qualified; submission stays capped.
      let estimate: string | null = null
      try {
        estimate = (
          await frost.estimateGas.submitFrostDepositSweepProof(request, {
            gasLimit: 30000000,
          })
        ).toString()
      } catch {
        /* Record a capped-node estimation refusal without inventing demand. */
      }
      let receipt: any
      let failure: string | null = null
      try {
        const sent = await frost.submitFrostDepositSweepProof(request, {
          gasLimit: TX_CAP,
        })
        receipt = await sent.wait()
      } catch (error: any) {
        failure = String(error.reason || error.code || error.message)
        receipt = error.receipt
        const hashFromError =
          error.transactionHash || error.data?.transactionHash
        if (!receipt && hashFromError)
          receipt = await ethers.provider.getTransactionReceipt(hashFromError)
      }
      if (!receipt) throw Error(`Missing mined receipt: ${failure}`)
      const accepted = receipt.status === 1
      const strippedBytes =
        Object.values(transaction).join("").replace(/0x/g, "").length / 2
      // Three-item D04 wallet witness: signature(64), exact wallet leaf, control(65).
      // Bitcoin weight is a separate byte calculation, not Core acceptance.
      const witnessBytes =
        2 +
        leaves
          .slice(0, count)
          .reduce(
            (sum, length) =>
              sum + 1 + 1 + 64 + compact(length).length + length + 1 + 65,
            0
          )
      const record = {
        count,
        distinctRecipients: count,
        firstCredits: true,
        route: ROUTE,
        gasLimit: TX_CAP,
        estimatedGasDiagnostic: estimate,
        accepted,
        gasUsed: receipt.gasUsed.toString(),
        transactionHash: receipt.transactionHash,
        calldataBytes: (calldata.length - 2) / 2,
        strippedBitcoinBytes: strippedBytes,
        illustrativeWalletLeafWitnessBytes: witnessBytes,
        illustrativeBitcoinWeight: 4 * strippedBytes + witnessBytes,
        bitcoinCoreAcceptance: false,
        failure,
      }
      records.push(record)
      console.log("C05_F5_GAS", JSON.stringify(record))
      const destination = process.env.FROST_C05_GAS_EVIDENCE
      if (destination) {
        fs.mkdirSync(destination, { recursive: true })
        fs.writeFileSync(
          path.join(destination, `${ROUTE}-gas.json`),
          `${JSON.stringify({ sourceBinding, records }, null, 2)}\n`
        )
      }
      if (accepted) {
        expect(receipt.gasUsed.toNumber()).to.be.at.most(TX_CAP)
        expect(await bank.balanceOf(treasury.address)).to.equal(1000 * count)
        if (ROUTE === "vault") {
          expect(await bank.balanceOf(vault.address)).to.equal(CREDIT * count)
          expect(await token.totalSupply()).to.equal(
            ethers.BigNumber.from(CREDIT * count).mul(10000000000)
          )
          for (const address of recipients.slice(0, count))
            expect(await token.balanceOf(address)).to.equal(
              ethers.BigNumber.from(CREDIT).mul(10000000000)
            )
        } else {
          for (const address of recipients.slice(0, count))
            expect(await bank.balanceOf(address)).to.equal(CREDIT)
        }
      } else {
        // The old256-input demand is retained separately. Current over-limit
        // cases test the published profile guard, not a fresh gas demand bound.
        expect(count).to.be.greaterThan(128)
        await expect(
          frost.callStatic.submitFrostDepositSweepProof(request, {
            gasLimit: TX_CAP,
          })
        ).revertedWith("FROST sweep inputs bound")
        expect(await bank.balanceOf(treasury.address)).to.equal(0)
        expect(await bank.balanceOf(vault.address)).to.equal(0)
        expect(await token.totalSupply()).to.equal(0)
        expect((await frost.frostCustodyOutput(newKey)).walletId).to.equal(
          ethers.constants.HashZero
        )
        for (const address of recipients.slice(0, count)) {
          expect(await bank.balanceOf(address)).to.equal(0)
          expect(await token.balanceOf(address)).to.equal(0)
        }
      }
      expect(accepted, "128-input profile acceptance boundary").to.equal(
        count <= 128
      )
    })
  })
})
