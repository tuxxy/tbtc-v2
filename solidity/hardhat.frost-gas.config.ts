import normalConfig from "./hardhat.config"

// This Hardhat version predates EIP-7825. Autominers process one transaction per
// block here, so a block cap enforces the same16,777,216 transaction ceiling.
// Compiler/optimizer settings remain the repository's normal settings.
const transactionGasCap = 16777216
export default {
  ...normalConfig,
  networks: {
    ...normalConfig.networks,
    hardhat: {
      ...normalConfig.networks?.hardhat,
      blockGasLimit: transactionGasCap,
      gas: transactionGasCap,
      allowUnlimitedContractSize: false,
    },
  },
  gasReporter: { ...normalConfig.gasReporter, enabled: false },
  mocha: { ...normalConfig.mocha, timeout: 180000 },
}
