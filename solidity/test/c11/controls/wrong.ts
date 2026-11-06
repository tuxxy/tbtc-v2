// Shared helper for the C-11 `.wrong` builder variants (controls). Each
// variant wraps the real builder and weakens one guard; run it with
// `C11_BUILDER=test/c11/controls/<variant>.wrong.ts` (see run-controls.sh).
// The variants need the implementation (deploy/87) to exist.
import { utils, constants } from "ethers"
import type { FrostUpgradeBundle } from "../../helpers/c11-upgrade-world"

// Loaded on use, so that `hardhat test` over the whole tree does not need the
// builder to exist.
const BUILDER = "../../../deploy/87_deploy_frost_bridge_upgrade"
// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require, import/no-dynamic-require
const real = () => require(BUILDER)

export type Bundle = FrostUpgradeBundle
export const proxyAdmin = new utils.Interface([
  "function upgrade(address,address)",
  "function upgradeAndCall(address,address,bytes)",
  "function transferOwnership(address)",
])
export const governance = new utils.Interface([
  "function transferOwnership(address)",
  "function beginLegacyDkgDrain()",
  "function configureFrostRegistry(address)",
  "function setFrostRequestsEnabled(bool)",
])
export const council = (to: string, data: string, description: string) => ({
  kind: "council" as const,
  to,
  value: 0,
  data,
  description,
})
export const HASH_ZERO = constants.HashZero

/// A variant: the real bundle, changed by `change`.
export function variant(
  change: (bundle: Bundle, inputs: any, hre: any) => Promise<Bundle> | Bundle
) {
  return {
    default: {
      get tags() {
        return real().default.tags
      },
      skip: (hre: any) => real().default.skip(hre),
    },
    deployFrostBridgeUpgrade: async (hre: any, inputs: any) =>
      change(await real().deployFrostBridgeUpgrade(hre, inputs), inputs, hre),
  }
}
