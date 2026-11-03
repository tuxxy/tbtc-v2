#!/usr/bin/env node
/* eslint-disable no-console */
// Provisions the Bitcoin Core release the Core-backed default tests run into
// solidity/.tools/bitcoin-<version>, from the official archive pinned in
// pins.json (archive SHA-256 per platform from the release SHA256SUMS, and the
// bitcoind and bitcoin-cli SHA-256 inside it). Idempotent: an install whose
// binaries both match their pins is kept.
const { execFileSync } = require("child_process")
const crypto = require("crypto")
const fs = require("fs")
const https = require("https")
const path = require("path")
const { pipeline } = require("stream")

const pins = require("./pins.json")

const platform = `${process.platform}-${process.arch}`
const pin = pins.platforms[platform]
if (!pin) {
  console.error(`no pinned Bitcoin Core ${pins.version} for ${platform}`)
  process.exit(1)
}
const tools = path.resolve(__dirname, "../../../.tools")
const home = path.join(tools, `bitcoin-${pins.version}`)
const sha256 = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")

// A dropped connection or a stalled transfer rejects; it never leaves the
// promise pending, which would let Node exit 0 with nothing installed.
function download(url, file) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`${url}: HTTP ${response.statusCode}`))
        return
      }
      pipeline(response, fs.createWriteStream(file), (error) =>
        error ? reject(error) : resolve()
      )
    })
    request.setTimeout(60000, () =>
      request.destroy(new Error(`${url}: no data for 60 s`))
    )
    request.on("error", reject)
  })
}

const installed = (bitcoind, cli) =>
  fs.existsSync(bitcoind) &&
  fs.existsSync(cli) &&
  sha256(bitcoind) === pin.bitcoindSha256 &&
  sha256(cli) === pin.bitcoinCliSha256

async function main() {
  const bitcoind = path.join(home, "bin", "bitcoind")
  const cli = path.join(home, "bin", "bitcoin-cli")
  if (installed(bitcoind, cli)) {
    console.log(`Bitcoin Core ${pins.version} already provisioned in ${home}`)
    return
  }
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(tools, { recursive: true })
  const archive = path.join(tools, pin.archive)
  await download(`${pins.source}${pin.archive}`, archive)
  if (sha256(archive) !== pin.archiveSha256)
    throw new Error(`${pin.archive} does not match its pinned SHA-256`)
  execFileSync("tar", ["-xzf", archive, "-C", tools])
  fs.rmSync(archive)
  if (!installed(bitcoind, cli))
    throw new Error(`${home}/bin does not match its pinned SHA-256s`)
  console.log(`Bitcoin Core ${pins.version} provisioned in ${home}`)
}

// Exit 1 unless main finishes: a promise that never settles must fail the step.
process.exitCode = 1
main().then(
  () => {
    process.exitCode = 0
  },
  (error) => {
    console.error(error.message)
    process.exit(1)
  }
)
