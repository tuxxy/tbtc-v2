// CONTROL (properties 3 and 4): the bundle also begins the legacy DKG drain.
// Expected: "[4 G-D] ..." fails at "G-D: creation mode LegacyOpen", and
// "[3 legacy] the whole frame ..." at "frame differences outside the
// allow-list".
import { variant, council, governance } from "./wrong"

const v = variant((b) => ({
  ...b,
  steps: [
    ...b.steps,
    council(
      b.bridgeGovernance,
      governance.encodeFunctionData("beginLegacyDkgDrain"),
      "WRONG: begin the legacy DKG drain"
    ),
  ],
}))
export default v.default
export const { deployFrostBridgeUpgrade } = v
