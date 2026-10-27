import config from "./hardhat.config"
// The upstream legacy suites use BridgeStub and external dependency deployment
// fixtures. Keep their ordinary stub size setting, with an unforked local chain.
config.defaultNetwork = "hardhat"
config.networks = {hardhat: {...config.networks?.hardhat, forking: undefined}}
config.mocha = {...config.mocha, reporter: "json", timeout: 180000}
config.gasReporter = {...config.gasReporter, enabled: false}
export default config
