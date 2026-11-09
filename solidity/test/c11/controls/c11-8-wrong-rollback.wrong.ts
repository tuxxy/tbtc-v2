// CONTROL (property 8): the bundle records the new implementation as the
// rollback target. Expected: "[8 rollback] ..." fails at "rollback target is
// the pre-bundle implementation".
import { variant } from "./wrong"

const v = variant((b) => ({
  ...b,
  rollbackImplementation: b.bridgeImplementation,
}))
export default v.default
export const { deployFrostBridgeUpgrade } = v
