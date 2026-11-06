// CONTROL (property 4): the bundle binds a FROST registry (a FIXTURE it
// deploys itself) and turns FROST wallet requests on. Expected: "[4 G-D] ..."
// fails at "G-D: FROST wallet requests off".
import { variant, council, governance } from "./wrong"

const v = variant(async (b, inputs, hre) => {
  const { deployer } = await hre.getNamedAccounts()
  const registry = await hre.deployments.deploy("C11ControlRegistryFixture", {
    from: deployer,
    contract: "FrostRegistryFixture",
    args: [inputs.bridge],
  })
  return {
    ...b,
    steps: [
      ...b.steps,
      council(
        b.bridgeGovernance,
        governance.encodeFunctionData("configureFrostRegistry", [
          registry.address,
        ]),
        "WRONG: bind a registry"
      ),
      council(
        b.bridgeGovernance,
        governance.encodeFunctionData("setFrostRequestsEnabled", [true]),
        "WRONG: requests on"
      ),
    ],
  }
})
export default v.default
export const { deployFrostBridgeUpgrade } = v
