/* eslint-disable no-restricted-syntax */
// Test-only source-matched build. No fixed binary/cache checkout is a prerequisite.
import fs from "fs"
import os from "os"
import path from "path"
import assert from "assert"
import { execFileSync } from "child_process"
import { createHash } from "crypto"

const sha = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex")
const built = new Map<string, string>()
function checkSchema(binary: string): void {
  const raw = `0200000001${"11".repeat(
    32
  )}0000000000ffffffff01e803000000000000160014${"22".repeat(20)}00000000`
  const result = JSON.parse(
    execFileSync(binary, [], {
      input: JSON.stringify({ rawTransaction: raw }),
      timeout: 10000,
    }).toString()
  )
  for (const field of [
    "version",
    "inputVector",
    "outputVector",
    "locktime",
    "strippedHex",
    "txidRPC",
  ])
    assert(
      typeof result[field] === "string",
      `Digest binary missing ${field}; rebuild from committed fixture source`
    )
  assert.equal(result.strippedHex, raw)
  assert.equal(
    [result.version, result.inputVector, result.outputVector, result.locktime]
      .map((x: string) => x.replace(/^0x/, ""))
      .join(""),
    raw
  )
  const hash = createHash("sha256")
    .update(createHash("sha256").update(Buffer.from(raw, "hex")).digest())
    .digest()
  assert.equal(result.txidRPC, hash.reverse().toString("hex"))
}

export function digestBinaryForRun(override?: string): string {
  if (override) {
    checkSchema(override)
    return override
  }
  const source = fs.readFileSync(
    path.join(__dirname, "frost-tapscript-digest.go")
  )
  const module = fs.readFileSync(path.join(__dirname, "frost-digest/go.mod"))
  const sums = fs.readFileSync(path.join(__dirname, "frost-digest/go.sum"))
  const key = [source, module, sums].map(sha).join(":")
  const existing = built.get(key)
  if (existing) return existing
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "frost-digest-build-")
  )
  fs.writeFileSync(path.join(directory, "main.go"), source)
  fs.writeFileSync(path.join(directory, "go.mod"), module)
  fs.writeFileSync(path.join(directory, "go.sum"), sums)
  const binary = path.join(
    directory,
    process.platform === "win32" ? "frost-digest.exe" : "frost-digest"
  )
  const version = execFileSync("go", ["version"], { timeout: 10000 })
    .toString()
    .trim()
  // Dependencies are pinned at the already-used versions. Cache population is
  // a normal prerequisite; tests never resolve upgrades or download a toolchain.
  execFileSync("go", ["build", "-mod=readonly", "-o", binary, "main.go"], {
    cwd: directory,
    env: {
      ...process.env,
      GOTOOLCHAIN: "local",
      GOWORK: "off",
      GOFLAGS: "",
      GOPROXY: "off",
      GOSUMDB: "off",
    },
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024,
  })
  assert.equal(
    fs.readFileSync(path.join(directory, "go.mod")).toString(),
    module.toString()
  )
  assert.equal(
    fs.readFileSync(path.join(directory, "go.sum")).toString(),
    sums.toString()
  )
  checkSchema(binary)
  fs.writeFileSync(
    path.join(directory, "source-binding.json"),
    `${JSON.stringify(
      {
        sourcePath: path.join(__dirname, "frost-tapscript-digest.go"),
        sourceSHA256: sha(source),
        moduleSHA256: sha(module),
        goSumSHA256: sha(sums),
        binarySHA256: sha(fs.readFileSync(binary)),
        goVersion: version,
        command: ["go", "build", "-mod=readonly", "-o", binary, "main.go"],
        capSeconds: 180,
        productionQualification: false,
      },
      null,
      2
    )}\n`
  )
  built.set(key, binary)
  return binary
}

export default digestBinaryForRun
