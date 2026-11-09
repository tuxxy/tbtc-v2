// CONTROL (property 1, review B3): the new BridgeGovernance has a 1 s
// governance delay instead of the old one's, so every base-delayed legacy
// parameter change becomes immediate. Expected: "[1, 3 side effects] ..."
// fails at "new BridgeGovernance governance delay equals the old one's".
import { utils } from "ethers"
import { variant } from "./wrong"

const transfer = new utils.Interface([
  "function beginBridgeGovernanceTransfer(address)",
])
const selector = transfer.getSighash("beginBridgeGovernanceTransfer")

const v = variant(async (b, inputs, hre) => {
  const { deployer } = await hre.getNamedAccounts()
  const short = await hre.deployments.deploy("C11ControlShortDelayGovernance", {
    from: deployer,
    contract: "BridgeGovernance",
    args: [inputs.bridge, 1],
    libraries: { BridgeGovernanceParameters: b.bridgeGovernanceParameters },
  })
  await hre.deployments.execute(
    "C11ControlShortDelayGovernance",
    { from: deployer },
    "transferOwnership",
    inputs.council
  )
  let applied = 0
  const steps = b.steps.map((s: any) => {
    if (s.kind === "council" && s.data.startsWith(selector)) {
      applied += 1
      return {
        ...s,
        data: transfer.encodeFunctionData("beginBridgeGovernanceTransfer", [
          short.address,
        ]),
      }
    }
    return s
  })
  if (applied !== 1)
    throw Error(
      "control did not apply: no single beginBridgeGovernanceTransfer step"
    )
  return { ...b, bridgeGovernance: short.address, steps }
})
export default v.default
export const { deployFrostBridgeUpgrade } = v
