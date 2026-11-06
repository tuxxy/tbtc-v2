import fs from "fs"
import path from "path"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction, DeployOptions } from "hardhat-deploy/types"
import { BigNumberish, constants, utils } from "ethers"

// C-11a: the FROST Bridge upgrade bundle (KC-SF-V3 §7 C-11).
//
// The deployer deploys contracts only and keeps no role. Everything that
// changes the Bridge is a governance step for the Council Safe:
//   1. Council Safe -> BridgeGovernance.beginBridgeGovernanceTransfer(new)
//   2. wait the BridgeGovernance governance delay (48h on mainnet)
//   3. Council Safe -> BridgeGovernance.finalizeBridgeGovernanceTransfer()
//      The new BridgeGovernance version adds one immediate onlyOwner
//      forwarder per FROST governance call (D22), so FROST is governable
//      through the production authority once the upgrade lands.
//   4. Timelock route: Council Safe -> Timelock.scheduleBatch() -> [wait] ->
//      Timelock.executeBatch() -> ProxyAdmin.upgrade(Bridge, implementation)
// The upgrade comes last, so the FROST entrypoints never exist under a
// governance that cannot reach them. It needs no initializer: every FROST
// field starts in its disabled zero state (creation mode LegacyOpen, gates,
// drain, requests and redemptions off, no registry, verifier or exposure
// controller). The verifier and the exposure controller are deployed here
// and installed later by the activation runbook, through BridgeGovernance.

// EIP-1967 slots (as in script 85).
export const EIP_1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
export const EIP_1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"

// Known mainnet addresses (as in script 85).
export const KNOWN_PROXY_ADMIN = "0x16A76d3cd3C1e3CE843C6680d6B37E9116b5C706"
export const KNOWN_TIMELOCK = "0x92f2d8b72a7F6a551Be60b9aa4194248E9B4913D"
export const KNOWN_COUNCIL_SAFE = "0x9F6e831c8f8939dc0c830c6e492e7cef4f9c2f5f"

// Timelock salt of the upgrade batch.
export const FROST_UPGRADE_SALT = utils.id("C-11a FROST Bridge upgrade")

const PROXY_ADMIN_ABI = [
  "function upgrade(address proxy, address implementation)",
]
const BRIDGE_GOVERNANCE_ABI = [
  "function beginBridgeGovernanceTransfer(address _newBridgeGovernance)",
  "function finalizeBridgeGovernanceTransfer()",
  "function governanceDelays(uint256) view returns (uint256)",
]
const proxyAdminInterface = new utils.Interface(PROXY_ADMIN_ABI)
const bridgeGovInterface = new utils.Interface(BRIDGE_GOVERNANCE_ABI)

export type FrostUpgradeInputs = {
  bridge: string // Bridge proxy
  proxyAdmin: string // its ProxyAdmin (owned by the Timelock)
  timelock: string // TimelockController
  bridgeGovernance: string // the current BridgeGovernance
  council: string // Council Safe: Timelock proposer/executor, BridgeGovernance owner
  exposureGovernance: string // governance of the FrostExposureController (D-10 OPEN)
}

export type FrostUpgradeStep =
  | {
      kind: "timelock"
      actions: { target: string; value: BigNumberish; data: string }[]
      predecessor: string
      salt: string
      description: string
    }
  | {
      kind: "council"
      to: string
      value: BigNumberish
      data: string
      description: string
    }
  | { kind: "wait"; seconds: number; description: string }

export type FrostUpgradeBundle = {
  bridgeImplementation: string
  libraries: Record<string, string>
  bridgeGovernance: string
  bridgeGovernanceParameters: string
  verifier: string
  exposureController: string
  rollbackImplementation: string
  steps: FrostUpgradeStep[]
}

/**
 * Encodes ProxyAdmin.upgrade() calldata for the Bridge proxy. The upgrade
 * carries no initializer call.
 */
export function encodeBridgeUpgrade(
  bridgeProxy: string,
  newBridgeImpl: string
): string {
  return proxyAdminInterface.encodeFunctionData("upgrade", [
    bridgeProxy,
    newBridgeImpl,
  ])
}

/**
 * Encodes BridgeGovernance.beginBridgeGovernanceTransfer() calldata, a
 * direct onlyOwner call that starts the governance delay.
 */
export function encodeBeginBridgeGovernanceTransfer(
  newBridgeGovernance: string
): string {
  return bridgeGovInterface.encodeFunctionData(
    "beginBridgeGovernanceTransfer",
    [newBridgeGovernance]
  )
}

/**
 * Encodes BridgeGovernance.finalizeBridgeGovernanceTransfer() calldata,
 * callable by the owner once the governance delay has elapsed.
 */
export function encodeFinalizeBridgeGovernanceTransfer(): string {
  return bridgeGovInterface.encodeFunctionData(
    "finalizeBridgeGovernanceTransfer"
  )
}

/**
 * The governance steps of the bundle, in order, for the given addresses.
 */
export function buildFrostUpgradeSteps(params: {
  bridge: string
  proxyAdmin: string
  bridgeGovernance: string
  newBridgeGovernance: string
  governanceDelay: number
  bridgeImplementation: string
}): FrostUpgradeStep[] {
  return [
    {
      kind: "council",
      to: params.bridgeGovernance,
      value: 0,
      data: encodeBeginBridgeGovernanceTransfer(params.newBridgeGovernance),
      description:
        "BridgeGovernance.beginBridgeGovernanceTransfer(new BridgeGovernance)",
    },
    {
      kind: "wait",
      seconds: params.governanceDelay,
      description: "BridgeGovernance governance delay",
    },
    {
      kind: "council",
      to: params.bridgeGovernance,
      value: 0,
      data: encodeFinalizeBridgeGovernanceTransfer(),
      description: "BridgeGovernance.finalizeBridgeGovernanceTransfer()",
    },
    {
      kind: "timelock",
      actions: [
        {
          target: params.proxyAdmin,
          value: 0,
          data: encodeBridgeUpgrade(params.bridge, params.bridgeImplementation),
        },
      ],
      predecessor: constants.HashZero,
      salt: FROST_UPGRADE_SALT,
      description: "ProxyAdmin.upgrade(Bridge, FROST Bridge implementation)",
    },
  ]
}

/** The address stored in an EIP-1967 slot of a proxy. */
async function proxySlotAddress(
  hre: HardhatRuntimeEnvironment,
  proxy: string,
  slot: string
): Promise<string> {
  const word = await hre.ethers.provider.getStorageAt(proxy, slot)
  return hre.ethers.utils.getAddress(`0x${word.slice(26)}`)
}

/**
 * Checks the inputs against the chain and throws on any mismatch:
 * - the chain ID is the network's configured one, and on mainnet the
 *   Timelock and the council are the known addresses;
 * - the Bridge proxy's admin slot holds the given ProxyAdmin;
 * - the ProxyAdmin is owned by the given Timelock;
 * - the given BridgeGovernance is `Bridge.governance()`, owned by the
 *   given council.
 */
export async function verifyFrostUpgradeInputs(
  hre: HardhatRuntimeEnvironment,
  inputs: FrostUpgradeInputs
): Promise<void> {
  const { ethers } = hre
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const refuse = (what: string, actual: string, expected: string) => {
    throw new Error(`C-11 input refused: ${what} is ${actual}, not ${expected}`)
  }

  const chainId = Number(await hre.getChainId())
  const expectedChainId = hre.network.config.chainId
  if (expectedChainId !== undefined && chainId !== expectedChainId) {
    refuse("chain ID", String(chainId), String(expectedChainId))
  }
  if (chainId === 1) {
    if (!same(inputs.timelock, KNOWN_TIMELOCK))
      refuse("mainnet Timelock", inputs.timelock, KNOWN_TIMELOCK)
    if (!same(inputs.council, KNOWN_COUNCIL_SAFE))
      refuse("mainnet council", inputs.council, KNOWN_COUNCIL_SAFE)
  }

  const admin = await proxySlotAddress(hre, inputs.bridge, EIP_1967_ADMIN_SLOT)
  if (!same(admin, inputs.proxyAdmin))
    refuse("Bridge proxy admin", admin, inputs.proxyAdmin)

  const owned = (address: string) =>
    new ethers.Contract(
      address,
      [
        "function owner() view returns (address)",
        "function governance() view returns (address)",
      ],
      ethers.provider
    )
  const adminOwner = await owned(inputs.proxyAdmin).owner()
  if (!same(adminOwner, inputs.timelock))
    refuse("ProxyAdmin owner", adminOwner, inputs.timelock)

  const bridgeGovernance = await owned(inputs.bridge).governance()
  if (!same(bridgeGovernance, inputs.bridgeGovernance))
    refuse("Bridge governance", bridgeGovernance, inputs.bridgeGovernance)

  const governanceOwner = await owned(inputs.bridgeGovernance).owner()
  if (!same(governanceOwner, inputs.council))
    refuse("BridgeGovernance owner", governanceOwner, inputs.council)
}

/**
 * Deploys the bundle's contracts from the named `deployer` and returns them
 * with the governance steps. The deployer holds no role afterwards.
 */
export async function deployFrostBridgeUpgrade(
  hre: HardhatRuntimeEnvironment,
  inputs: FrostUpgradeInputs
): Promise<FrostUpgradeBundle> {
  const { deployments, getNamedAccounts, ethers } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const deployOptions: DeployOptions = {
    from: deployer,
    log: true,
    waitConfirmations: 1,
  }

  // Refuses a wrong target before anything is deployed.
  await verifyFrostUpgradeInputs(hre, inputs)
  const proxyAdmin = ethers.utils.getAddress(inputs.proxyAdmin)
  const rollbackImplementation = await proxySlotAddress(
    hre,
    inputs.bridge,
    EIP_1967_IMPLEMENTATION_SLOT
  )

  const oldGovernance = new ethers.Contract(
    inputs.bridgeGovernance,
    bridgeGovInterface,
    ethers.provider
  )
  const governanceDelay = (await oldGovernance.governanceDelays(0)).toNumber()

  // --- Bridge libraries, as deploy 06 links them ---
  const FrostWallets = await deploy("FrostWallets", deployOptions)
  const FrostDepositAdmission = await deploy(
    "FrostDepositAdmission",
    deployOptions
  )
  const FrostDepositSweep = await deploy("FrostDepositSweep", deployOptions)
  const FrostRedemptions = await deploy("FrostRedemptions", deployOptions)
  const FrostRedemptionRequests = await deploy(
    "FrostRedemptionRequests",
    deployOptions
  )
  const FrostCancellationAdmissions = await deploy(
    "FrostCancellationAdmissions",
    deployOptions
  )
  const FrostRedemptionSettlement = await deploy("FrostRedemptionSettlement", {
    ...deployOptions,
    libraries: {
      FrostCancellationAdmissions: FrostCancellationAdmissions.address,
    },
  })
  const FrostMovement = await deploy("FrostMovement", deployOptions)
  const FrostFraud = await deploy("FrostFraud", deployOptions)
  const FrostLifecycle = await deploy("FrostLifecycle", deployOptions)
  const FrostExposure = await deploy("FrostExposure", deployOptions)
  const FrostFraudDispatch = await deploy("FrostFraudDispatch", {
    ...deployOptions,
    libraries: {
      FrostFraud: FrostFraud.address,
      FrostLifecycle: FrostLifecycle.address,
      FrostExposure: FrostExposure.address,
    },
  })
  const FrostMovementDispatch = await deploy("FrostMovementDispatch", {
    ...deployOptions,
    libraries: {
      FrostMovement: FrostMovement.address,
      FrostFraudDispatch: FrostFraudDispatch.address,
    },
  })
  const FrostBridge = await deploy("FrostBridge", {
    ...deployOptions,
    libraries: {
      FrostWallets: FrostWallets.address,
      FrostDepositAdmission: FrostDepositAdmission.address,
      FrostDepositSweep: FrostDepositSweep.address,
      FrostRedemptions: FrostRedemptions.address,
      FrostRedemptionRequests: FrostRedemptionRequests.address,
      FrostRedemptionSettlement: FrostRedemptionSettlement.address,
      FrostMovementDispatch: FrostMovementDispatch.address,
    },
  })
  const Deposit = await deploy("Deposit", deployOptions)
  const DepositSweep = await deploy("DepositSweep", {
    ...deployOptions,
    libraries: { FrostMovement: FrostMovement.address },
  })
  const Redemption = await deploy("Redemption", deployOptions)
  const Wallets = await deploy("Wallets", {
    contract: "contracts/bridge/Wallets.sol:Wallets",
    ...deployOptions,
  })
  const Fraud = await deploy("Fraud", deployOptions)
  const MovingFunds = await deploy("MovingFunds", {
    ...deployOptions,
    libraries: { FrostMovement: FrostMovement.address },
  })

  const bridgeLibraries = {
    FrostBridge: FrostBridge.address,
    Deposit: Deposit.address,
    DepositSweep: DepositSweep.address,
    Redemption: Redemption.address,
    Wallets: Wallets.address,
    Fraud: Fraud.address,
    MovingFunds: MovingFunds.address,
  }
  const libraries: Record<string, string> = {
    ...bridgeLibraries,
    FrostWallets: FrostWallets.address,
    FrostDepositAdmission: FrostDepositAdmission.address,
    FrostDepositSweep: FrostDepositSweep.address,
    FrostRedemptions: FrostRedemptions.address,
    FrostRedemptionRequests: FrostRedemptionRequests.address,
    FrostCancellationAdmissions: FrostCancellationAdmissions.address,
    FrostRedemptionSettlement: FrostRedemptionSettlement.address,
    FrostMovement: FrostMovement.address,
    FrostFraud: FrostFraud.address,
    FrostLifecycle: FrostLifecycle.address,
    FrostExposure: FrostExposure.address,
    FrostFraudDispatch: FrostFraudDispatch.address,
    FrostMovementDispatch: FrostMovementDispatch.address,
  }

  // --- Bridge implementation (as script 85: a distinct artifact name keeps
  // the Bridge proxy artifact) ---
  const bridgeImplementation = await deploy("BridgeFrostImplementation", {
    ...deployOptions,
    contract: "Bridge",
    skipIfAlreadyDeployed: false,
    libraries: bridgeLibraries,
  })

  // --- The new BridgeGovernance version (as script 70), with the current
  // governance delay ---
  const bridgeGovernanceParameters = await deploy(
    "BridgeGovernanceParameters",
    deployOptions
  )
  const bridgeGovernance = await deploy("BridgeGovernance", {
    ...deployOptions,
    contract: "BridgeGovernance",
    args: [inputs.bridge, governanceDelay],
    libraries: {
      BridgeGovernanceParameters: bridgeGovernanceParameters.address,
    },
  })
  // As deploy 22: the Council Safe owns BridgeGovernance.
  await deployments.execute(
    "BridgeGovernance",
    deployOptions,
    "transferOwnership",
    inputs.council
  )

  // --- FROST components, deployed but not installed ---
  const verifier = await deploy("FrostVerifier", deployOptions)
  const exposureController = await deploy("FrostExposureController", {
    ...deployOptions,
    args: [inputs.bridge, inputs.exposureGovernance],
  })

  return {
    bridgeImplementation: bridgeImplementation.address,
    libraries,
    bridgeGovernance: bridgeGovernance.address,
    bridgeGovernanceParameters: bridgeGovernanceParameters.address,
    verifier: verifier.address,
    exposureController: exposureController.address,
    rollbackImplementation,
    steps: buildFrostUpgradeSteps({
      bridge: inputs.bridge,
      proxyAdmin,
      bridgeGovernance: inputs.bridgeGovernance,
      newBridgeGovernance: bridgeGovernance.address,
      governanceDelay,
      bridgeImplementation: bridgeImplementation.address,
    }),
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, helpers } = hre
  const { deployer, governance } = await getNamedAccounts()

  const exposureGovernance = process.env.FROST_EXPOSURE_GOVERNANCE
  if (!exposureGovernance) {
    // D-10 OPEN: the exposure controller's governance has no default.
    throw new Error("Set FROST_EXPOSURE_GOVERNANCE")
  }

  // Per network, as base names them: the council is the `governance` named
  // account (deploy 22), the Timelock is deploy 42's record. The ProxyAdmin
  // has no record; it defaults to the known address on mainnet only.
  const chainId = Number(await hre.getChainId())
  const Bridge = await deployments.get("Bridge")
  const BridgeGovernance = await deployments.get("BridgeGovernance")
  const timelock =
    process.env.TIMELOCK_ADDRESS ??
    (await deployments.getOrNull("Timelock"))?.address
  if (!timelock) {
    throw new Error("Set TIMELOCK_ADDRESS: no Timelock deployment record")
  }
  const proxyAdmin =
    process.env.PROXY_ADMIN_ADDRESS ??
    (chainId === 1 ? KNOWN_PROXY_ADMIN : undefined)
  if (!proxyAdmin) {
    throw new Error("Set PROXY_ADMIN_ADDRESS off mainnet")
  }
  const inputs: FrostUpgradeInputs = {
    bridge: Bridge.address,
    proxyAdmin,
    timelock,
    bridgeGovernance: BridgeGovernance.address,
    council: process.env.COUNCIL_SAFE_ADDRESS ?? governance,
    exposureGovernance,
  }

  console.log("=".repeat(80))
  console.log("C-11a FROST Bridge upgrade")
  console.log("=".repeat(80))
  console.log(`Network:  ${hre.network.name}`)
  console.log(`Deployer: ${deployer}`)
  Object.entries(inputs).forEach(([key, value]) =>
    console.log(`  ${key}: ${value}`)
  )
  const bundle = await deployFrostBridgeUpgrade(hre, inputs)

  console.log("\nDeployed:")
  console.log(`  Bridge implementation:      ${bundle.bridgeImplementation}`)
  console.log(`  BridgeGovernance:           ${bundle.bridgeGovernance}`)
  console.log(
    `  BridgeGovernanceParameters: ${bundle.bridgeGovernanceParameters}`
  )
  console.log(`  FrostVerifier:              ${bundle.verifier}`)
  console.log(`  FrostExposureController:    ${bundle.exposureController}`)
  console.log(`  Rollback implementation:    ${bundle.rollbackImplementation}`)
  Object.entries(bundle.libraries).forEach(([name, address]) =>
    console.log(`  library ${name}: ${address}`)
  )
  console.log("\nGovernance steps (Council Safe):")
  bundle.steps.forEach((step, i) => {
    console.log(`  [${i}] ${step.kind}: ${step.description}`)
    if (step.kind === "council") {
      console.log(`      To: ${step.to}`)
      console.log(`      Calldata: ${step.data}`)
    } else if (step.kind === "timelock") {
      console.log(`      Timelock: ${inputs.timelock}`)
      step.actions.forEach((a) =>
        console.log(`      Action: ${a.target} ${a.data}`)
      )
      console.log(`      Predecessor: ${step.predecessor}`)
      console.log(`      Salt: ${step.salt}`)
    } else {
      console.log(`      Seconds: ${step.seconds}`)
    }
  })

  const summaryDir = path.join(__dirname, "..", "deployments", hre.network.name)
  fs.mkdirSync(summaryDir, { recursive: true })
  const summaryPath = path.join(
    summaryDir,
    `frost-upgrade-deployment-${Date.now()}.json`
  )
  fs.writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        network: hre.network.name,
        chainId: await hre.getChainId(),
        timestamp: new Date().toISOString(),
        deployer,
        inputs,
        bundle,
      },
      null,
      2
    )
  )
  console.log(`\nDeployment summary saved to: ${summaryPath}`)

  if (hre.network.tags.etherscan) {
    const names = [
      ...Object.keys(bundle.libraries),
      "BridgeFrostImplementation",
      "BridgeGovernanceParameters",
      "BridgeGovernance",
      "FrostVerifier",
      "FrostExposureController",
    ]
    // eslint-disable-next-line no-restricted-syntax
    for (const name of names) {
      // eslint-disable-next-line no-await-in-loop
      await helpers.etherscan.verify(await deployments.get(name))
    }
  }
}

export default func

func.tags = ["DeployFrostBridgeUpgrade"]
// Set DEPLOY_FROST_UPGRADE=true and FROST_EXPOSURE_GOVERNANCE when running
// the deployment.
// yarn deploy --tags DeployFrostBridgeUpgrade --network <NETWORK>
func.skip = async () => process.env.DEPLOY_FROST_UPGRADE !== "true"
