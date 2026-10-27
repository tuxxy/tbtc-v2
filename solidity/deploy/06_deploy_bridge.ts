import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction, DeployOptions } from "hardhat-deploy/types"

const func: DeployFunction = async function deployBridge(
  hre: HardhatRuntimeEnvironment
) {
  const { ethers, helpers, deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer, treasury } = await getNamedAccounts()

  const Bank = await deployments.get("Bank")
  const LightRelay = await deployments.get("LightRelay")
  const WalletRegistry = await deployments.get("WalletRegistry")
  const ReimbursementPool = await deployments.get("ReimbursementPool")

  // Local tests and Sepolia (testnet4 Bitcoin): use `1` to ease SPV proofs.
  // Other live networks use mainnet-style `6`.
  const network = deployments.getNetworkName()
  const txProofDifficultyFactor =
    network === "hardhat" ||
    network === "development" ||
    network === "system_tests" ||
    network === "sepolia"
      ? 1
      : 6

  const deployOptions: DeployOptions = {
    from: deployer,
    log: true,
    waitConfirmations: 1,
  }

  // The inactive extension has a fixed library target. It does not configure
  // a registry or enable FROST wallet requests.
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
  const FrostLegacyRecovery = await deploy("FrostLegacyRecovery", deployOptions)
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
      FrostLegacyRecovery: FrostLegacyRecovery.address,
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
  // C-10: legacy main replacements release a committed FROST drain.
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
  // C-10: legacy main replacements release a committed FROST drain.
  const MovingFunds = await deploy("MovingFunds", {
    ...deployOptions,
    libraries: { FrostMovement: FrostMovement.address, FrostLegacyRecovery: FrostLegacyRecovery.address },
  })

  const [bridge, proxyDeployment] = await helpers.upgrades.deployProxy(
    "Bridge",
    {
      contractName:
        process.env.TEST_USE_STUBS_TBTC === "true" ? "BridgeStub" : "Bridge",
      initializerArgs: [
        Bank.address,
        LightRelay.address,
        treasury,
        WalletRegistry.address,
        ReimbursementPool.address,
        txProofDifficultyFactor,
      ],
      factoryOpts: {
        signer: await ethers.getSigner(deployer),
        libraries: {
          FrostBridge: FrostBridge.address,
          Deposit: Deposit.address,
          DepositSweep: DepositSweep.address,
          Redemption: Redemption.address,
          Wallets: Wallets.address,
          Fraud: Fraud.address,
          MovingFunds: MovingFunds.address,
        },
      },
      proxyOpts: {
        kind: "transparent",
        // Allow external libraries linking. We need to ensure manually that the
        // external  libraries we link are upgrade safe, as the OpenZeppelin plugin
        // doesn't perform such a validation yet.
        // See: https://docs.openzeppelin.com/upgrades-plugins/1.x/faq#why-cant-i-use-external-libraries
        unsafeAllow: ["external-library-linking"],
      },
    }
  )

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(FrostWallets)
    await helpers.etherscan.verify(FrostDepositAdmission)
    await helpers.etherscan.verify(FrostDepositSweep)
    await helpers.etherscan.verify(FrostRedemptions)
    await helpers.etherscan.verify(FrostRedemptionRequests)
    await helpers.etherscan.verify(FrostCancellationAdmissions)
    await helpers.etherscan.verify(FrostRedemptionSettlement)
    await helpers.etherscan.verify(FrostLifecycle)
    await helpers.etherscan.verify(FrostExposure)
    await helpers.etherscan.verify(FrostFraud)
    await helpers.etherscan.verify(FrostFraudDispatch)
    await helpers.etherscan.verify(FrostMovement)
    await helpers.etherscan.verify(FrostLegacyRecovery)
    await helpers.etherscan.verify(FrostMovementDispatch)
    await helpers.etherscan.verify(FrostBridge)
    await helpers.etherscan.verify(Deposit)
    await helpers.etherscan.verify(DepositSweep)
    await helpers.etherscan.verify(Redemption)
    await helpers.etherscan.verify(Wallets)
    await helpers.etherscan.verify(Fraud)
    await helpers.etherscan.verify(MovingFunds)

    // We use `verify` instead of `verify:verify` as the `verify` task is defined
    // in "@openzeppelin/hardhat-upgrades" to perform Etherscan verification
    // of Proxy and Implementation contracts.
    await hre.run("verify", {
      address: proxyDeployment.address,
      constructorArgsParams: proxyDeployment.args,
    })
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "Bridge",
      address: bridge.address,
    })
  }
}

export default func

func.tags = ["Bridge"]
func.dependencies = [
  "Bank",
  "LightRelay",
  "Treasury",
  "WalletRegistry",
  "ReimbursementPool",
]
