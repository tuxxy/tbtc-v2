// CONTROL (property 6, #56 class): the bundle reports a FrostBridge address
// with no code. Expected: "[6 bytecode, #56] ..." fails at "linked library
// has code: FrostBridge".
import { variant } from "./wrong"

const v = variant((b) => ({
  ...b,
  libraries: {
    ...b.libraries,
    FrostBridge: "0x000000000000000000000000000000000000c11b",
  },
}))
export default v.default
export const { deployFrostBridgeUpgrade } = v
