// CONTROL (property 7): the bundle's verifier is not the FrostVerifier
// artifact (here: the exposure controller's address). Expected: "[7 verifier]
// ..." fails at "bundle verifier is the FrostVerifier artifact".
import { variant } from "./wrong"

const v = variant((b) => ({ ...b, verifier: b.exposureController }))
export default v.default
export const { deployFrostBridgeUpgrade } = v
