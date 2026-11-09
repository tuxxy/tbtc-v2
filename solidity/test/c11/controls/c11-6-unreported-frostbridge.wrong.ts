// CONTROL (property 6, #56 class): the bundle does not account for the
// FrostBridge link. Expected: "[6 bytecode, #56] ..." fails at "bundle reports
// the address of library FrostBridge (linked by Bridge implementation)".
import { variant } from "./wrong"

const v = variant((b) => {
  const libraries = { ...b.libraries }
  delete libraries.FrostBridge
  return { ...b, libraries }
})
export default v.default
export const { deployFrostBridgeUpgrade } = v
