// Builds the FROST Bridge client ABI: the IFrostBridge interface plus the
// events its linked libraries emit at the Bridge address (the interface alone
// cannot decode them). Run after compiling ../solidity:
//   node scripts/frost-bridge-abi.js ../solidity/build/contracts/frost src/lib/ethereum/artifacts/frost/IFrostBridge.json
const fs = require("fs")
const path = require("path")

const [root, out] = process.argv.slice(2)
if (!root || !out)
  throw new Error("usage: frost-bridge-abi.js <frost build dir> <out.json>")
const read = (name) =>
  JSON.parse(fs.readFileSync(path.join(root, `${name}.sol`, `${name}.json`)))
    .abi
const signature = (e) => `${e.name}${JSON.stringify(e.inputs)}`
const abi = read("IFrostBridge")
const seen = new Set(abi.filter((e) => e.type === "event").map(signature))
const events = []
for (const source of [
  "FrostRedemptionLedger",
  "FrostRedemptionRequests",
  "FrostRedemptionSettlement",
  "FrostCancellationAdmissions",
  "FrostDepositSweep",
  "FrostDepositAdmission",
  "FrostFundingConfiguration",
  "FrostWallets",
]) {
  for (const e of read(source)) {
    if (e.type === "event" && !seen.has(signature(e))) {
      seen.add(signature(e))
      events.push(e)
    }
  }
}
events.sort((a, b) => (signature(a) < signature(b) ? -1 : 1))
fs.writeFileSync(
  out,
  `${JSON.stringify({ abi: abi.concat(events) }, null, 2)}\n`
)
