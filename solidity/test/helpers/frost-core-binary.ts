// Bitcoin Core for the Core-backed default tests, provisioned into the
// checkout by test/helpers/bitcoin-core/provision.cjs (a step of the
// contracts workflow; run it once locally). Nothing outside the checkout is
// read.
import path from "path"
import pins from "./bitcoin-core/pins.json"

const platform = `${process.platform}-${process.arch}`
const pin = (pins.platforms as Record<string, { bitcoindSha256: string }>)[
  platform
]

export const CORE = path.resolve(
  __dirname,
  `../../.tools/bitcoin-${pins.version}/bin`
)
// The executable pin for this platform; an unpinned platform fails the
// executable check with this message.
export const CORE_SHA =
  pin?.bitcoindSha256 ??
  `no pinned Bitcoin Core ${pins.version} for ${platform}`
