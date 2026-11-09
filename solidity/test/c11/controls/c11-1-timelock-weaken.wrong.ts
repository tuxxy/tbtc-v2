// CONTROL (property 1, review B3): a Timelock step shortens the Timelock's
// delay and grants a new proposer. Expected: "[1, 3 side effects] ..." fails
// at "bundle steps emit only the named events" (Timelock: MinDelayChange,
// RoleGranted).
import { utils } from "ethers"
import { variant, HASH_ZERO } from "./wrong"

const timelock = new utils.Interface([
  "function updateDelay(uint256)",
  "function grantRole(bytes32,address)",
])
const PROPOSER_ROLE = utils.id("PROPOSER_ROLE")

const v = variant((b, inputs) => ({
  ...b,
  steps: [
    ...b.steps,
    {
      kind: "timelock" as const,
      actions: [
        {
          target: inputs.timelock,
          value: 0,
          data: timelock.encodeFunctionData("updateDelay", [1]),
        },
        {
          target: inputs.timelock,
          value: 0,
          data: timelock.encodeFunctionData("grantRole", [
            PROPOSER_ROLE,
            "0x0000000000000000000000000000000000c11aaa",
          ]),
        },
      ],
      predecessor: HASH_ZERO,
      salt: utils.id("C11 WRONG timelock"),
      description: "WRONG: weaken the Timelock",
    },
  ],
}))
export default v.default
export const { deployFrostBridgeUpgrade } = v
