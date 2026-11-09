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

// An override (FROST_C04_DIGEST_BINARY, FROST_C05_DIGEST_BINARY or an
// explicit option) is used only when FROST_C04_DIGEST_BINARY_SHA256 pins its
// exact bytes; the schema probe alone does not identify the parser (K09-14).
// The override is copied into a private directory first, and the copy is
// hashed and returned, so the bytes checked are the bytes later run.
export function digestBinaryForRun(override?: string): string {
  if (override) {
    const pin = process.env.FROST_C04_DIGEST_BINARY_SHA256
    const copy = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "frost-digest-override-")),
      path.basename(override)
    )
    fs.copyFileSync(override, copy)
    fs.chmodSync(copy, 0o500)
    assert(
      pin !== undefined && sha(fs.readFileSync(copy)) === pin.toLowerCase(),
      `digest binary override ${override} is not pinned: FROST_C04_DIGEST_BINARY / FROST_C05_DIGEST_BINARY overrides need a matching FROST_C04_DIGEST_BINARY_SHA256`
    )
    checkSchema(copy)
    return copy
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
