// CONTROL (properties 1 and 3, review B3): the bundle also trusts a new
// vault through the new BridgeGovernance, a governance mapping outside the
// inventory. Expected: "[1, 3 side effects] ..." fails at "bundle steps emit
// only the named events" (Bridge: VaultStatusUpdated).
import { utils } from "ethers"
import { variant, council } from "./wrong"

const governance = new utils.Interface([
  "function setVaultStatus(address,bool)",
])

const v = variant((b, inputs) => ({
  ...b,
  steps: [
    ...b.steps,
    council(
      b.bridgeGovernance,
      governance.encodeFunctionData("setVaultStatus", [inputs.council, true]),
      "WRONG: trust a new vault"
    ),
  ],
}))
export default v.default
export const { deployFrostBridgeUpgrade } = v
