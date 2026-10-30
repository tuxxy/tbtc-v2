#!/usr/bin/env node
/* eslint-disable no-console */
// Provisions the Bitcoin Core release the Core-backed default tests run into
// solidity/.tools/bitcoin-<version>, from the official archive pinned in
// pins.json (archive and bitcoind SHA-256 per platform, from the release
// SHA256SUMS). Idempotent: an installed bitcoind matching its pin is kept.
const { execFileSync } = require("child_process")
const crypto = require("crypto")
const fs = require("fs")
const https = require("https")
const path = require("path")

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

function download(url, file) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          reject(new Error(`${url}: HTTP ${response.statusCode}`))
          return
        }
        const out = fs.createWriteStream(file)
        response.pipe(out)
        out.on("finish", () => out.close(resolve))
        out.on("error", reject)
      })
      .on("error", reject)
  })
}

async function main() {
  const bitcoind = path.join(home, "bin", "bitcoind")
  if (fs.existsSync(bitcoind) && sha256(bitcoind) === pin.bitcoindSha256) {
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
  if (sha256(bitcoind) !== pin.bitcoindSha256)
    throw new Error(`${bitcoind} does not match its pinned SHA-256`)
  console.log(`Bitcoin Core ${pins.version} provisioned in ${home}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
