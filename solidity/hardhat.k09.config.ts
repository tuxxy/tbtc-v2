import { extendEnvironment } from "hardhat/config"
import config from "./hardhat.config"

// Check after the ordinary config has loaded dotenv, before any fixture runs.
if (process.env.HARDHAT_NETWORK && process.env.HARDHAT_NETWORK !== "hardhat") {
  throw new Error("K-09 requires the local hardhat network")
}
config.defaultNetwork = "hardhat"
config.networks = {
  hardhat: {
    ...config.networks?.hardhat,
    forking: undefined,
    allowUnlimitedContractSize: false,
  },
}
extendEnvironment((hre) => {
  if (
    hre.network.name !== "hardhat" ||
    ("forking" in hre.network.config && hre.network.config.forking?.enabled)
  ) {
    throw new Error("K-09 requires a local, unforked hardhat network")
  }
})
config.mocha = { ...config.mocha, reporter: "json", timeout: 180000 }
config.gasReporter = { ...config.gasReporter, enabled: false }
export default config
