import config from "./hardhat.config"

// Local K-09 acceptance only: machine-readable cases, production size checks
// and sufficient per-case time for sequential Core subprocesses.
config.mocha = { ...config.mocha, reporter: "json", timeout: 180000 }
config.gasReporter = { ...config.gasReporter, enabled: false }
if (config.networks?.hardhat) {
  config.networks.hardhat.allowUnlimitedContractSize = false
}
export default config
