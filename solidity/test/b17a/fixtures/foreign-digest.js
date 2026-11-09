#!/usr/bin/env node
// FIXTURE (remediation batch 17a, tuxxy/tbtc-v2#17): a transaction parser that
// is NOT the committed frost-tapscript-digest.go build. It answers the schema
// probe of test/helpers/frost-digest-builder.ts (checkSchema) correctly for
// the probe's legacy transaction and nothing else: it splits the raw bytes at
// fixed offsets instead of parsing them. A run must never use it unless it was
// pinned; the batch 17a test only checks that it is not used.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createHash } = require("crypto")

let input = ""
process.stdin.on("data", (chunk) => {
  input += chunk
})
process.stdin.on("end", () => {
  const raw = JSON.parse(input).rawTransaction
  const sha = (b) => createHash("sha256").update(b).digest()
  const txid = Buffer.from(sha(sha(Buffer.from(raw, "hex"))))
    .reverse()
    .toString("hex")
  process.stdout.write(
    JSON.stringify({
      version: `0x${raw.slice(0, 8)}`,
      inputVector: "0x",
      outputVector: `0x${raw.slice(8, raw.length - 8)}`,
      locktime: `0x${raw.slice(raw.length - 8)}`,
      strippedHex: raw,
      txidRPC: txid,
    })
  )
})
