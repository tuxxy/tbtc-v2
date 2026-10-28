/* eslint-disable no-await-in-loop, no-restricted-syntax */
// Joint maximum resolution gas witness: real public Bridge/proxy and Bank.
// Reuses C05 gas transaction, independent profile and synthetic proof encoders.
// No Bitcoin Core script acceptance, production finality or qualification claim.
import { artifacts, ethers, network } from "hardhat"
import { expect } from "chai"
import * as secp from "@noble/secp256k1"
import { reservationProposal } from "../helpers/frost-reservation-proposal"
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
const ROUTE = process.env.ROUTE || "bank"
const deployed: any[] = []
const SCRIPT = `0x0014${"11".repeat(20)}`
const RESOLUTION_TYPE =
  "tuple(bytes32 reservationId,bytes32 transactionHash,address vault,uint64 validUntilBlock)"
const CANCELLATION_TYPE =
  "tuple(bytes32 reservationId,bytes32 snapshot,bytes32 transactionHash,uint64 fee,uint64 validUntilBlock)"

// Run ONLY this one witness, --no-compile, against the parent-selected artifacts.
// Requires the parent-confirmed hash-archive, pull-refund and A4 history build.
describe("C-04 joint maximum sweep resolution gas (synthetic SPV component)", function jointMaximum() {
  this.timeout(170000)
  it("measures 64 public refunds + 128 sweep inputs + 100 distinct operator signatures under the transaction cap", async () => {
    expect(["bank", "vault"]).include(ROUTE)
    const [owner, treasury] = await ethers.getSigners()
    const bank = await deploy("Bank")
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
    const bridge = implementation.attach(proxy.address)
    const frost = await ethers.getContractAt("IFrostBridge", proxy.address)
    await bank.updateBridge(proxy.address)
    await bridge.setSpvMaintainerStatus(owner.address, true)
    await bridge.updateDepositParameters(10000, 100, 2000, 30)
    const movement = Array.from(await bridge.movingFundsParameters())
    movement[1] = 500
    await bridge.updateMovingFundsParameters(...movement)
    await bridge.updateRedemptionParameters(3000, 100, 2000, 10000, 86400, 0, 0)
    const registry = await deploy("FrostRegistryFixture", [proxy.address])
    await frost.configureFrostRegistry(registry.address)
    const operators = Array.from(
      { length: 100 },
      (_, i) => new ethers.Wallet(ethers.utils.id(`A3 max operator ${i}`))
    )
    const seats = Array.from({ length: 100 }, (_, i) => i + 1)
    const { chainId } = await ethers.provider.getNetwork()
    const descriptor = {
      scheme: 2,
      profile: 1,
      chainId,
      registry: registry.address,
      epoch: await ethers.provider.getBlockNumber(),
      members: seats,
      operators: operators.map((w) => w.address),
      threshold: 100,
      snowfallDescriptor: ethers.utils.id(
        "UNQUALIFIED A3 joint max descriptor"
      ),
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
      descriptor.epoch + 10000
    )
    await registry.ready(ID, descriptorHash)
    const verifier = await deploy("FrostVerifier")
    const genesis = ethers.utils.id("UNQUALIFIED A3 joint max synthetic chain")
    await frost.configureFrostFunding(
      verifier.address,
      ethers.utils.keccak256(await ethers.provider.getCode(verifier.address)),
      ethers.utils.id("UNQUALIFIED joint max gas component"),
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
    await frost.configureFrostRedemptions(
      genesis,
      2,
      1000,
      ZERO,
      ethers.utils.id("UNQUALIFIED joint max D08 fixture")
    )
    await frost.setFrostRedemptionsEnabled(true)
    let token: any
    let vault: any
    let sweepVault = ZERO
    if (ROUTE === "vault") {
      token = await deploy("TBTC")
      vault = await deploy("TBTCVault", [
        bank.address,
        token.address,
        bridge.address,
      ])
      await token.transferOwnership(vault.address)
      await bridge.setVaultStatus(vault.address, true)
      sweepVault = vault.address
      expect(await bank.balanceOf(sweepVault)).eq(0)
      expect(await token.totalSupply()).eq(0)
    }
    const locktime =
      (await ethers.provider.getBlock("latest")).timestamp + 86400
    async function reveal(
      index: number,
      recipient: string,
      amount: number,
      target = ZERO
    ) {
      const terms = {
        ...baseTerms,
        chainId: String(chainId),
        bridge: bridge.address,
        bitcoinGenesis: genesis,
        fullWalletId: ID,
        descriptorHash,
        depositor: recipient,
        vault: target,
        amount: String(amount),
        refundKey: Q,
        refundLocktime: locktime,
        blinding: toHex(unsigned(index + 1, 8)),
      }
      // Same independent TapTweak relation as Frost.DepositSweep.Gas: no extra
      // expensive frostDepositOutput call for each of the 127 setup receipts.
      const profile = encodeProfile(terms, Q)
      const tweak = BigInt(
        toHex(
          tagged(
            "TapTweak",
            Buffer.concat([fromHex(NUMS), fromHex(profile.root)])
          )
        )
      )
      if (tweak >= secp.CURVE.n) throw Error("Out-of-range component tweak")
      const point = secp.Point.fromHex(`02${NUMS.slice(2)}`).add(
        secp.Point.BASE.multiply(tweak)
      )
      const key = ethers.utils.hexZeroPad(`0x${point.x.toString(16)}`, 32)
      const tx = {
        version: "0x02000000",
        inputVector: `0x01${entry(ethers.utils.id(`A3 max funding ${index}`))}`,
        outputVector: `0x01${output(amount, key)}`,
        locktime: "0x00000000",
      }
      await frost
        .connect(await ethers.getSigner(recipient))
        .revealFrostDeposit(terms, tx, 0, { gasLimit: 2000000 })
      // C-10: the host signs only reserved deposits, so the joint maximum
      // is measured with every deposit reserved (UNRESERVED=1 for the old
      // C-05 shape, where each is charged at its proof).
      if (!process.env.UNRESERVED)
        await frost.reserveFrostDeposit(
          outpoint(txHash(tx)),
          tx,
          syntheticProof(tx)
        )
      return txHash(tx)
    }
    const initialDeposit = await reveal(0, owner.address, 1000000)
    const mainTx = {
      version: "0x02000000",
      inputVector: `0x01${entry(initialDeposit)}`,
      outputVector: `0x01${output(999000)}`,
      locktime: "0x00000000",
    }
    await frost.submitFrostDepositSweepProof({
      walletId: ID,
      transaction: mainTx,
      proof: syntheticProof(mainTx),
      includeMain: false,
      vault: ZERO,
    })
    const mainHash = txHash(mainTx)
    const refundRecipients = Array.from(
      { length: 64 },
      (_, i) => new ethers.Wallet(ethers.utils.id(`A3 max refund ${i}`)).address
    )
    await bank.approveBalance(bridge.address, 64 * 3000)
    const requests = []
    for (let i = 0; i < 64; i++) {
      const id = ethers.utils.keccak256(
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
            bridge.address,
            ID,
            descriptorHash,
            i + 1,
            ethers.utils.keccak256(SCRIPT),
          ]
        )
      )
      await frost.requestFrostRedemption(ID, SCRIPT, 3000, refundRecipients[i])
      requests.push({ id, value: 2950, script: SCRIPT })
    }
    const custody = await frost.frostWalletCustody(ID)
    const p = await reservationProposal({
      bridge: bridge.address,
      chainId,
      walletId: ID,
      descriptorHash,
      genesis,
      outputKey: Q,
      generation: custody.generation.add(1),
      stateVersion: custody.stateVersion,
      validUntilBlock: (await ethers.provider.getBlockNumber()) + 1000,
      inputs: [{ txHash: mainHash, txOutputIndex: 0, txOutputValue: 999000 }],
      requests,
      fee: 1280,
      maximumFee: 2000,
      operators,
    })
    p.seats = seats
    p.signatures = ethers.utils.hexConcat(
      await Promise.all(
        operators.map((w) => w.signMessage(ethers.utils.arrayify(p.digest)))
      )
    )
    const id = await frost.callStatic.reserveFrostRedemption(p)
    await frost.reserveFrostRedemption(p, { gasLimit: TX_CAP })
    async function sign(domain: string, tuple: string, authorization: any) {
      const digest = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ["bytes32", "uint256", "address", tuple],
          [ethers.utils.id(domain), chainId, bridge.address, authorization]
        )
      )
      return ethers.utils.hexConcat(
        await Promise.all(
          operators.map((w) => w.signMessage(ethers.utils.arrayify(digest)))
        )
      )
    }
    const cancellationTx = {
      version: "0x02000000",
      inputVector: `0x01${entry(mainHash)}`,
      outputVector: `0x01${output(998000)}`,
      locktime: "0x00000000",
    }
    const validator = await deploy("FrostRedemptionTransactionFixture")
    const c = await validator.validateCancellation(cancellationTx, Q, p.inputs)
    const cancelAuthorization = {
      reservationId: id,
      snapshot: c.snapshot,
      transactionHash: txHash(cancellationTx),
      fee: 1000,
      validUntilBlock: (await ethers.provider.getBlockNumber()) + 1000,
    }
    await bank.connect(treasury).approveBalance(bridge.address, 1000)
    await frost
      .connect(treasury)
      .authorizeFrostCancellation(
        cancelAuthorization,
        cancellationTx,
        seats,
        await sign(
          "tbtc-v2/frost-reservation-cancellation/v1",
          CANCELLATION_TYPE,
          cancelAuthorization
        ),
        { gasLimit: TX_CAP }
      )
    const originalIntent = await frost.frostReservation(id)
    const firstAlternative = await frost.frostCancellationAlternative(
      id,
      cancelAuthorization.transactionHash
    )
    const metadata = (approval: any) => [
      approval.transactionHash,
      approval.snapshot,
      approval.fee,
      approval.sponsor,
      approval.admittedBlock,
      approval.validUntilBlock,
      approval.seats,
      approval.signatures,
    ]
    const secondTx = {
      version: "0x02000000",
      inputVector: `0x01${entry(mainHash)}`,
      outputVector: `0x01${output(997500)}`,
      locktime: "0x00000000",
    }
    const secondResult = await validator.validateCancellation(
      secondTx,
      Q,
      p.inputs
    )
    const secondAuthorization = {
      reservationId: id,
      snapshot: secondResult.snapshot,
      transactionHash: txHash(secondTx),
      fee: 1500,
      validUntilBlock: (await ethers.provider.getBlockNumber()) + 1000,
    }
    expect(originalIntent.certificate.maximumFee).eq(2000)
    const ownerBeforeAdditional = await bank.balanceOf(owner.address)
    expect(await bank.allowance(owner.address, bridge.address)).eq(0)
    await bank.approveBalance(bridge.address, 1500)
    const secondSignatures = await sign(
      "tbtc-v2/frost-reservation-cancellation/v1",
      CANCELLATION_TYPE,
      secondAuthorization
    )
    expect(ethers.utils.arrayify(secondSignatures).length).eq(6500)
    const additionalAdmission = await (
      await frost.authorizeFrostCancellation(
        secondAuthorization,
        secondTx,
        seats,
        secondSignatures,
        { gasLimit: TX_CAP }
      )
    ).wait()
    expect(additionalAdmission.status).eq(1)
    expect(additionalAdmission.gasUsed.lt(TX_CAP)).eq(true)
    expect(await bank.balanceOf(owner.address)).eq(
      ownerBeforeAdditional.sub(1500)
    )
    expect(await bank.balanceOf(bridge.address)).eq(194500)
    expect(await bank.allowance(owner.address, bridge.address)).eq(0)
    expect(await frost.frostReservation(id)).deep.eq(originalIntent)
    expect(
      await frost.frostCancellationAlternative(
        id,
        cancelAuthorization.transactionHash
      )
    ).deep.eq(firstAlternative)
    expect(await frost.frostCancellationCount(id)).eq(2)
    expect(await frost.frostCancellationHash(id, 0)).eq(
      cancelAuthorization.transactionHash
    )
    expect(await frost.frostCancellationHash(id, 1)).eq(
      secondAuthorization.transactionHash
    )
    const secondAlternative = await frost.frostCancellationAlternative(
      id,
      secondAuthorization.transactionHash
    )
    expect(secondAlternative.transactionHash).eq(
      secondAuthorization.transactionHash
    )
    expect(secondAlternative.snapshot).eq(secondResult.snapshot)
    expect(secondAlternative.fee).eq(1500)
    expect(secondAlternative.sponsor).eq(owner.address)
    expect(secondAlternative.admittedBlock).eq(additionalAdmission.blockNumber)
    expect(secondAlternative.validUntilBlock).eq(
      secondAuthorization.validUntilBlock
    )
    expect(secondAlternative.seats).deep.eq(seats)
    expect(secondAlternative.signatures).eq(secondSignatures)
    expect(secondAlternative.budgetSettled).eq(false)
    console.log(
      "A4_MAX_ADDITIONAL_ADMISSION_GAS",
      JSON.stringify({
        route: ROUTE,
        fee: 1500,
        independentSponsor: owner.address,
        certificateSeats: 100,
        certificateBytes: 6500,
        gasUsed: additionalAdmission.gasUsed.toString(),
        gasCap: TX_CAP,
        transactionHash: additionalAdmission.transactionHash,
      })
    )
    console.log(
      "A3_MAX_SETUP",
      JSON.stringify({
        phase:
          "64 requests and 100-seat reservation/two cancellations publicly admitted",
      })
    )
    const deposits = []
    const recipients = []
    for (let i = 0; i < 127; i++) {
      const recipient = new ethers.Wallet(
        ethers.utils.id(`A3 max new depositor ${i}`)
      ).address
      await network.provider.send("hardhat_impersonateAccount", [recipient])
      await network.provider.send("hardhat_setBalance", [
        recipient,
        ethers.utils.hexValue(ethers.utils.parseEther("1")),
      ])
      deposits.push(await reveal(i + 1, recipient, 100000, sweepVault))
      recipients.push(recipient)
      await network.provider.send("hardhat_stopImpersonatingAccount", [
        recipient,
      ])
    }
    expect(new Set(operators.map((w) => w.address)).size).eq(100)
    expect(new Set([...refundRecipients, ...recipients]).size).eq(191)
    for (const address of [...refundRecipients, ...recipients])
      expect(await bank.balanceOf(address)).eq(0)
    if (ROUTE === "vault") {
      expect(await token.totalSupply()).eq(0)
      for (const address of recipients)
        expect(await token.balanceOf(address)).eq(0)
    }
    const transaction = {
      version: "0x02000000",
      inputVector: `0x80${entry(mainHash)}${deposits
        .map((h) => entry(h))
        .join("")}`,
      outputVector: `0x01${output(999000 + 127 * 99000)}`,
      locktime: "0x00000000",
    }
    const authorization = {
      reservationId: id,
      transactionHash: txHash(transaction),
      vault: sweepVault,
      validUntilBlock: (await ethers.provider.getBlockNumber()) + 1000,
    }
    const resolution = {
      sweep: {
        walletId: ID,
        transaction,
        proof: syntheticProof(transaction),
        includeMain: true,
        vault: sweepVault,
      },
      authorization,
      seats,
      signatures: await sign(
        "tbtc-v2/frost-reservation-sweep-resolution/v1",
        RESOLUTION_TYPE,
        authorization
      ),
    }
    const reservationBuild = await artifacts.getBuildInfo(
      "contracts/frost/FrostRedemptionLedger.sol:FrostRedemptionLedger"
    )
    const ledgerSource =
      reservationBuild?.input.sources[
        "contracts/frost/FrostRedemptionLedger.sol"
      ]?.content || ""
    const artifactArchive = ledgerSource.includes(
      "bytes32 sweepResolutionSignaturesHash;"
    )
      ? "hash-and-event"
      : "full-signatures-or-other"
    expect(artifactArchive, "parent-confirmed hash/event build required").eq(
      "hash-and-event"
    )
    expect(
      ledgerSource.includes("State.Refundable"),
      "parent-confirmed individual refund build required"
    ).eq(true)
    console.log(
      "A3_MAX_SETUP",
      JSON.stringify({
        phase: "ready",
        requestCount: 64,
        sweepInputs: 128,
        freshDeposits: 127,
        operators: 100,
        certificateBytes: ethers.utils.arrayify(resolution.signatures).length,
        artifactArchive,
      })
    )
    const before = {
      wallet: await frost.frostWalletCustody(ID),
      intent: await frost.frostReservation(id),
      escrow: await frost.frostRedemptionEscrow(ID),
      held: await bank.balanceOf(bridge.address),
    }
    if (process.env.A3_ESTIMATE)
      console.log(
        "A3_ESTIMATE",
        (
          await frost.estimateGas.submitFrostSweepResolutionProof(resolution, {
            gasLimit: 30000000,
          })
        ).toString()
      )
    let receipt: any
    let failure: string | null = null
    try {
      receipt = await (
        await frost.submitFrostSweepResolutionProof(resolution, {
          gasLimit: TX_CAP,
        })
      ).wait()
    } catch (error: any) {
      failure = String(error.reason || error.message)
      receipt = error.receipt
      const failedHash = error.transactionHash || error.data?.transactionHash
      if (!receipt && failedHash)
        receipt = await ethers.provider.getTransactionReceipt(failedHash)
    }
    console.log(
      "A3_MAX_RESOLUTION_GAS",
      JSON.stringify({
        requestCount: 64,
        sweepInputs: 128,
        freshDeposits: 127,
        operators: 100,
        route: ROUTE,
        distinctNewBankCreditRecipients: ROUTE === "bank" ? 127 : 1,
        distinctNewTokenRecipients: ROUTE === "vault" ? 127 : 0,
        distinctRefundRecipients: 64,
        cancellationBudgets: [1000, 1500],
        additionalAdmissionGas: additionalAdmission.gasUsed.toString(),
        artifactArchive,
        gasCap: TX_CAP,
        accepted: receipt?.status === 1,
        gasUsed: receipt?.gasUsed.toString() ?? null,
        transactionHash: receipt?.transactionHash ?? null,
        blockGasLimit: (
          await ethers.provider.getBlock("latest")
        ).gasLimit.toString(),
        failure,
        bridgeRuntimeHash: ethers.utils.keccak256(
          await ethers.provider.getCode(implementation.address)
        ),
        calldataBytes: ethers.utils.arrayify(
          frost.interface.encodeFunctionData(
            "submitFrostSweepResolutionProof",
            [resolution]
          )
        ).length,
        syntheticProof: true,
        bitcoinConsensusQualified: false,
      })
    )
    if (!receipt || receipt.status !== 1) {
      expect(await frost.frostWalletCustody(ID)).deep.eq(before.wallet)
      expect(await frost.frostReservation(id)).deep.eq(before.intent)
      expect(await frost.frostRedemptionEscrow(ID)).deep.eq(before.escrow)
      expect(await bank.balanceOf(bridge.address)).eq(before.held)
      for (const address of [...refundRecipients, ...recipients])
        expect(await bank.balanceOf(address)).eq(0)
      expect.fail(`Joint maximum resolution exceeds cap or refuses: ${failure}`)
    }
    expect(receipt.gasUsed.lt(TX_CAP)).eq(true)
    const events = new ethers.utils.Interface([
      "event FrostSweepResolutionApproved(bytes32 indexed reservationId,bytes32 indexed transactionHash,address vault,uint64 validUntilBlock,uint16[] seats,bytes signatures)",
    ])
    const approvals = receipt.logs.filter(
      (log: any) =>
        log.address.toLowerCase() === bridge.address.toLowerCase() &&
        log.topics[0] === events.getEventTopic("FrostSweepResolutionApproved")
    )
    expect(approvals.length).eq(1)
    const archived = events.parseLog(approvals[0]).args
    expect(archived.signatures).eq(resolution.signatures)
    expect(archived.seats).deep.eq(seats)
    expect(archived.reservationId).eq(id)
    expect(archived.transactionHash).eq(authorization.transactionHash)
    expect(archived.vault).eq(sweepVault)
    expect(archived.validUntilBlock).eq(authorization.validUntilBlock)
    const intent = await frost.frostReservation(id)
    expect(intent.sweepResolutionSignaturesHash).eq(
      ethers.utils.keccak256(archived.signatures)
    )
    expect(intent.sweepResolutionAuthorizationHash).eq(
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ["bytes32", "uint256", "address", RESOLUTION_TYPE],
          [
            ethers.utils.id("tbtc-v2/frost-reservation-sweep-resolution/v1"),
            chainId,
            bridge.address,
            authorization,
          ]
        )
      )
    )
    expect((await frost.frostReservation(id)).state).eq(6)
    const after = await frost.frostWalletCustody(ID)
    expect(after.stateVersion).eq(before.wallet.stateVersion.add(1))
    expect(after.value).eq(13572000)
    expect(after.mainOutpoint).eq(outpoint(txHash(transaction)))
    expect(after.activeReservation).eq(ethers.constants.HashZero)
    // This receipt measures proof only. Refund transactions are separately bounded.
    expect(await bank.balanceOf(bridge.address)).eq(193500)
    const firstAfterProof = await frost.frostCancellationAlternative(
      id,
      cancelAuthorization.transactionHash
    )
    expect(firstAfterProof.budgetSettled).eq(true)
    expect(metadata(firstAfterProof)).deep.eq(metadata(firstAlternative))
    expect(
      await frost.frostCancellationAlternative(
        id,
        secondAuthorization.transactionHash
      )
    ).deep.eq(secondAlternative)
    expect(await frost.frostCancellationWinner(id)).eq(
      ethers.constants.HashZero
    )
    const heldEscrow = await frost.frostRedemptionEscrow(ID)
    expect(heldEscrow[0]).eq(192000)
    expect(heldEscrow[1]).eq(190080)
    expect(await bank.balanceOf(treasury.address)).eq(137000)
    for (const r of requests)
      expect((await frost.frostRedemptionRequest(r.id)).state).eq(6)
    for (const address of refundRecipients)
      expect(await bank.balanceOf(address)).eq(0)
    if (ROUTE === "bank") {
      for (const address of recipients)
        expect(await bank.balanceOf(address)).eq(98000)
    } else {
      expect(await bank.balanceOf(sweepVault)).eq(127 * 98000)
      expect(await token.totalSupply()).eq(
        ethers.BigNumber.from(127 * 98000).mul(10000000000)
      )
      for (const address of recipients) {
        expect(await bank.balanceOf(address)).eq(0)
        expect(await token.balanceOf(address)).eq(
          ethers.BigNumber.from(98000).mul(10000000000)
        )
        expect(await vault.optimisticMintingDebt(address)).eq(0)
      }
    }
    const [, , claimant] = await ethers.getSigners()
    const claimantBalance = await bank.balanceOf(claimant.address)
    const heldBeforeFirstClaim = await bank.balanceOf(bridge.address)
    await expect(
      frost
        .connect(claimant)
        .claimFrostCancellationBudget(id, cancelAuthorization.transactionHash)
    ).revertedWith("FROST cancellation budget settled")
    expect(await bank.balanceOf(bridge.address)).eq(heldBeforeFirstClaim)
    expect(await bank.balanceOf(owner.address)).eq(
      ownerBeforeAdditional.sub(1500)
    )
    let maximumClaimGas = ethers.BigNumber.from(0)
    const claimGas = []
    for (let i = 0; i < requests.length; i++) {
      const claim = await (
        await frost
          .connect(claimant)
          .refundResolvedFrostRedemption(requests[i].id, { gasLimit: TX_CAP })
      ).wait()
      expect(claim.status).eq(1)
      expect(claim.gasUsed.lt(TX_CAP)).eq(true)
      if (claim.gasUsed.gt(maximumClaimGas)) maximumClaimGas = claim.gasUsed
      claimGas.push(claim.gasUsed.toString())
      expect((await frost.frostRedemptionRequest(requests[i].id)).state).eq(5)
      expect(await bank.balanceOf(refundRecipients[i])).eq(3000)
      const remaining = await frost.frostRedemptionEscrow(ID)
      expect(remaining[0]).eq((63 - i) * 3000)
      expect(remaining[1]).eq((63 - i) * 2970)
      expect(await bank.balanceOf(bridge.address)).eq((63 - i) * 3000 + 1500)
    }
    expect(await bank.balanceOf(claimant.address)).eq(claimantBalance)
    expect(await bank.balanceOf(bridge.address)).eq(1500)
    expect(await bank.balanceOf(owner.address)).eq(
      ownerBeforeAdditional.sub(1500)
    )
    expect(
      await frost.frostCancellationAlternative(
        id,
        secondAuthorization.transactionHash
      )
    ).deep.eq(secondAlternative)
    const budgetClaim = await (
      await frost
        .connect(claimant)
        .claimFrostCancellationBudget(id, secondAuthorization.transactionHash, {
          gasLimit: TX_CAP,
        })
    ).wait()
    expect(budgetClaim.status).eq(1)
    expect(budgetClaim.gasUsed.lt(TX_CAP)).eq(true)
    expect(await bank.balanceOf(owner.address)).eq(ownerBeforeAdditional)
    expect(await bank.balanceOf(claimant.address)).eq(claimantBalance)
    expect(await bank.balanceOf(bridge.address)).eq(0)
    expect(await bank.balanceOf(treasury.address)).eq(137000)
    const secondAfterClaim = await frost.frostCancellationAlternative(
      id,
      secondAuthorization.transactionHash
    )
    expect(secondAfterClaim.budgetSettled).eq(true)
    expect(metadata(secondAfterClaim)).deep.eq(metadata(secondAlternative))
    expect(
      await frost.frostCancellationAlternative(
        id,
        cancelAuthorization.transactionHash
      )
    ).deep.eq(firstAfterProof)
    await expect(
      frost
        .connect(claimant)
        .claimFrostCancellationBudget(id, secondAuthorization.transactionHash)
    ).revertedWith("FROST cancellation budget settled")
    expect(await bank.balanceOf(owner.address)).eq(ownerBeforeAdditional)
    expect(await bank.balanceOf(claimant.address)).eq(claimantBalance)
    expect(await bank.balanceOf(bridge.address)).eq(0)
    expect(await frost.frostWalletCustody(ID)).deep.eq(after)
    expect(await frost.frostReservation(id)).deep.eq(intent)
    await expect(
      frost.connect(claimant).refundResolvedFrostRedemption(requests[0].id)
    ).revertedWith("FROST resolved refund state")
    console.log(
      "A3_MAX_INDIVIDUAL_REFUND_GAS",
      JSON.stringify({
        route: ROUTE,
        claims: 64,
        maxClaimGas: maximumClaimGas.toString(),
        budgetClaimGas: budgetClaim.gasUsed.toString(),
        additionalAdmissionGas: additionalAdmission.gasUsed.toString(),
        proofGas: receipt.gasUsed.toString(),
        gasCap: TX_CAP,
        claimGas,
        syntheticProof: true,
      })
    )
  })
})
