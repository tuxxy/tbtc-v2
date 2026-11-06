// CONTROL (property 1): the bundle leaves the deployer owning the new
// BridgeGovernance. Expected: "[1 authority] after the bundle ..." fails at
// "BridgeGovernance owner is the council".
import { variant, council, governance } from "./wrong"

const v = variant(async (b, inputs, hre) => {
  const { deployer } = await hre.getNamedAccounts()
  return {
    ...b,
    steps: [
      ...b.steps,
      council(
        b.bridgeGovernance,
        governance.encodeFunctionData("transferOwnership", [deployer]),
        "WRONG: hand BridgeGovernance to the deployer"
      ),
    ],
  }
})
export default v.default
export const { deployFrostBridgeUpgrade } = v
