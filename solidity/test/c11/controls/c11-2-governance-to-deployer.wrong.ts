// CONTROL (property 2): the bundle moves the Bridge governance to the
// deployer EOA instead of the new BridgeGovernance, so a non-governance
// account of the production shape can write FROST state in the window.
// Expected: "[2 window] ..." fails at "after step <i>: deployer <fn> on the
// Bridge: ..." (not refused, or refused for a state reason instead of the
// governance reason).
import { utils } from "ethers"
import { variant } from "./wrong"

const transfer = new utils.Interface([
  "function beginBridgeGovernanceTransfer(address)",
])
const selector = transfer.getSighash("beginBridgeGovernanceTransfer")

const v = variant(async (b, inputs, hre) => {
  const { deployer } = await hre.getNamedAccounts()
  let applied = 0
  const steps = b.steps.map((s: any) => {
    if (s.kind === "council" && s.data.startsWith(selector)) {
      applied += 1
      return {
        ...s,
        data: transfer.encodeFunctionData("beginBridgeGovernanceTransfer", [
          deployer,
        ]),
        description: "WRONG: Bridge governance to the deployer",
      }
    }
    return s
  })
  if (applied !== 1)
    throw Error(
      "control did not apply: no single beginBridgeGovernanceTransfer step"
    )
  return { ...b, steps }
})
export default v.default
export const { deployFrostBridgeUpgrade } = v
