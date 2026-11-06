#!/usr/bin/env node
// Runs every test file in its own `hardhat test` process, several at a time.
//
// One process for the whole suite is not sound here: smock fakes are hooks on
// the Hardhat VM, not chain state, so they survive `evm_revert` and leak into
// later files. The legacy bridge fixture fakes IWalletRegistry at the real
// registry's address, and every later file that uses the real registry (the
// K-09 and B8 worlds) then fails. A process per file has no such leak.
//
// Each process also gets its own working directory (HARDHAT_TEST_WORKDIR, see
// hardhat.config.ts): OpenZeppelin upgrades keeps the dev-chain manifest in
// `.openzeppelin/unknown-31337.json` relative to the working directory, and
// processes sharing it reuse each other's ProxyAdmin addresses (every
// process is chain 31337).
//
// usage: node scripts/test-isolated.cjs [--suite unit|e2e] [test files...]
//   --suite    unit: every test file not in test/suites/e2e.txt;
//              e2e: the files in test/suites/e2e.txt (see that file)
//   TEST_JOBS  parallel processes (default: half the CPUs, at most one per
//              2.5 GB; on CI's 4 vCPUs, 4 jobs pushed tests past mocha's 60 s)
const { spawn, spawnSync } = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")

const root = path.resolve(__dirname, "..")
const hardhat = path.join(root, "node_modules", ".bin", "hardhat")

function testFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...testFiles(file))
    else if (/\.(ts|js|cjs|mjs)$/.test(entry.name)) {
      // Hardhat loads every script under test/; only files that declare
      // suites or tests need a process of their own.
      if (/\b(describe|it)\s*\(/.test(fs.readFileSync(file, "utf8")))
        out.push(path.relative(root, file))
    }
  }
  return out
}

const args = process.argv.slice(2)
let suite = "all"
if (args[0] === "--suite") {
  suite = args[1]
  args.splice(0, 2)
}
if (!["all", "unit", "e2e"].includes(suite)) {
  console.error(`unknown suite ${suite}: use unit or e2e`)
  process.exit(2)
}
const e2e = new Set(
  fs
    .readFileSync(path.join(root, "test", "suites", "e2e.txt"), "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean)
)
const all = testFiles(path.join(root, "test"))
const missing = [...e2e].filter((file) => !all.includes(file))
if (missing.length) {
  console.error(
    `test/suites/e2e.txt names no such test file:\n  ${missing.join("\n  ")}`
  )
  process.exit(2)
}
const files =
  args.length > 0
    ? args
    : all.filter((file) =>
        suite === "all" ? true : (suite === "e2e") === e2e.has(file)
      )
// Largest files first, so the slow suites do not start last.
files.sort(
  (a, b) =>
    fs.statSync(path.join(root, b)).size - fs.statSync(path.join(root, a)).size
)
const jobs = Math.max(
  1,
  Number(process.env.TEST_JOBS) ||
    Math.min(
      Math.floor(os.cpus().length / 2),
      Math.floor(os.totalmem() / 2.5e9)
    )
)

const compile = spawnSync(hardhat, ["compile"], { cwd: root, stdio: "inherit" })
if (compile.status !== 0) process.exit(compile.status || 1)

const totals = { passing: 0, failing: 0, pending: 0 }
const failed = []
let next = 0
const started = Date.now()

function count(text, word) {
  const m = text.match(new RegExp(`^\\s*(\\d+) ${word}`, "m"))
  return m ? Number(m[1]) : 0
}

function run(file) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hardhat-test-"))
    // Absolute: Hardhat resolves the file after switching directories.
    const child = spawn(
      hardhat,
      ["test", "--no-compile", path.resolve(root, file)],
      {
        cwd: root,
        env: { ...process.env, HARDHAT_TEST_WORKDIR: cwd },
      }
    )
    let output = ""
    child.stdout.on("data", (d) => (output += d))
    child.stderr.on("data", (d) => (output += d))
    child.on("close", (code) => {
      fs.rmSync(cwd, { recursive: true, force: true })
      const seconds = ((Date.now() - t0) / 1000).toFixed(1)
      for (const k of Object.keys(totals)) totals[k] += count(output, k)
      const ok = code === 0
      if (!ok) failed.push(file)
      process.stdout.write(
        `\n== ${ok ? "PASS" : "FAIL"} ${file} (${seconds} s)\n${output}`
      )
      resolve()
    })
  })
}

async function worker() {
  while (next < files.length) await run(files[next++])
}

Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker)).then(
  () => {
    const minutes = ((Date.now() - started) / 60000).toFixed(1)
    console.log(
      `\n${files.length} files, ${jobs} at a time, ${minutes} min: ${totals.passing} passing, ${totals.failing} failing, ${totals.pending} pending`
    )
    if (failed.length) {
      console.log(`failed files:\n  ${failed.join("\n  ")}`)
      process.exit(1)
    }
  }
)
