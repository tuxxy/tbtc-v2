// Harness side of fresh-checkout.sh (runs outside the sandbox). Two modes:
//
//   d1 <fresh root> <since ms> <D1 git dir> <D1 commit> <out.json>
//     tuxxy/tbtc-v2#28 and owner decision D1: the legacy baseline the
//     LegacyReconciliation run used must be tbtc-v2 main 40a11d1d. Every
//     public-legacy-origin.json the run wrote under the fresh root names its
//     baseline build. The harness reads that build itself and requires:
//       - every contracts/ source in the Bridge build-info (except Hardhat's
//         generated dependency re-exports) equals the D1
//         commit's solidity/<path>, read from the D1 git dir (fetched by the
//         harness, not by the candidate), and Bridge.sol is among them;
//       - the Bridge artifact's bytecode equals that build-info's output;
//       - the run's own baselineSourceHashes equal the D1 sources' SHA-256,
//         path for path (so the run used this build, not another).
//
//   manifest <fresh root> <evidence dir> <expected-cases.json> <plan.json>
//     Writes manifest-<case>.json for each requested case. A file passes only
//     if its run exited 0, Mocha finished, nothing failed or was pending, and
//     the passed tests are exactly the expected case identities and counts
//     (expected-cases.json; a renamed, moved, skipped or extra test needs a
//     reviewed amendment there).
const fs = require("fs")
const path = require("path")
const crypto = require("crypto")
const { execFileSync } = require("child_process")

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex")
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"))

function findFiles(root, name, since, found = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name)
    // Symbolic links (the linked node_modules) are not followed.
    if (entry.isDirectory() && entry.name !== ".git")
      findFiles(p, name, since, found)
    else if (
      entry.isFile() &&
      entry.name === name &&
      fs.statSync(p).mtimeMs >= since
    )
      found.push(p)
  }
  return found
}

function d1([root, since, gitDir, commit, out]) {
  const problems = []
  const checked = []
  const origins = findFiles(root, "public-legacy-origin.json", Number(since))
  if (origins.length === 0)
    problems.push(
      "the run wrote no public-legacy-origin.json under the fresh root"
    )
  for (const origin of origins) {
    const manifest = readJson(origin)
    const build = manifest.baselineBuild
    const where = path.relative(root, origin)
    if (typeof build !== "string" || !build) {
      problems.push(`${where}: no baselineBuild`)
      continue
    }
    try {
      const artifact = path.resolve(
        path.dirname(origin),
        build,
        "contracts/bridge/Bridge.sol/Bridge.json"
      )
      const debug = readJson(artifact.replace(/\.json$/, ".dbg.json"))
      const info = readJson(
        path.resolve(path.dirname(artifact), debug.buildInfo)
      )
      // Generated, gitignored re-exports of dependencies are not repository
      // sources.
      const generated = (n) =>
        n.startsWith("contracts/hardhat-dependency-compiler/")
      const names = Object.keys(info.input.sources).filter(
        (n) => n.startsWith("contracts/") && !generated(n)
      )
      if (!names.includes("contracts/bridge/Bridge.sol"))
        problems.push(
          `${where}: the baseline build-info has no contracts/bridge/Bridge.sol`
        )
      const expected = {}
      for (const name of names) {
        let pinned
        try {
          pinned = execFileSync(
            "git",
            ["--git-dir", gitDir, "show", `${commit}:solidity/${name}`],
            {
              maxBuffer: 64 * 1024 * 1024,
              stdio: ["ignore", "pipe", "ignore"],
            }
          ).toString()
        } catch (error) {
          problems.push(
            `${where}: ${name} does not exist at D1 ${commit.slice(0, 8)}`
          )
          continue
        }
        if (info.input.sources[name].content !== pinned)
          problems.push(
            `${where}: baseline source ${name} differs from D1 ${commit.slice(
              0,
              8
            )}`
          )
        expected[name] = sha(Buffer.from(pinned))
      }
      const compiled =
        info.output.contracts["contracts/bridge/Bridge.sol"].Bridge.evm
      const bridge = readJson(artifact)
      if (
        bridge.bytecode.replace(/^0x/, "") !== compiled.bytecode.object ||
        bridge.deployedBytecode.replace(/^0x/, "") !==
          compiled.deployedBytecode.object
      )
        problems.push(
          `${where}: the baseline Bridge artifact differs from its build-info output`
        )
      const reported = {}
      for (const h of manifest.baselineSourceHashes || [])
        if (!generated(h.path)) reported[h.path] = h.sha256
      if (
        JSON.stringify(Object.entries(reported).sort()) !==
        JSON.stringify(Object.entries(expected).sort())
      )
        problems.push(
          `${where}: the run's baselineSourceHashes are not the D1 ${commit.slice(
            0,
            8
          )} sources of its baseline build`
        )
      checked.push({
        origin: where,
        baselineBuild: build,
        sources: names.length,
      })
    } catch (error) {
      problems.push(
        `${where}: cannot read the baseline build ${build}: ${String(
          error.message
        ).slice(0, 200)}`
      )
    }
  }
  fs.writeFileSync(
    out,
    `${JSON.stringify(
      { d1: commit, ok: problems.length === 0, checked, problems },
      null,
      2
    )}\n`
  )
}

function counts(titles) {
  const m = new Map()
  for (const t of titles) m.set(t, (m.get(t) || 0) + 1)
  return m
}

function evaluateFile(root, evidence, expected, env, file) {
  const base = path.basename(file, ".test.ts")
  const dir = path.join(root, `job-${env}-${base}`)
  const result = { file, env, log: `run-${env}-${base}.log` }
  if (!fs.existsSync(path.join(root, "repo/solidity", file))) {
    return {
      ...result,
      status: "missing",
      reason:
        "not at this path in the candidate (moved or removed; amend the case list only with review)",
    }
  }
  const rc = Number(fs.readFileSync(path.join(dir, "rc"), "utf8"))
  const resultsPath = path.join(dir, "results.json")
  const results = fs.existsSync(resultsPath) ? readJson(resultsPath) : null
  const tests = results ? results.tests : []
  const failed = tests.filter((t) => t.state === "failed")
  const pending = tests.filter((t) => t.state === "pending")
  const passed = tests.filter((t) => t.state === "passed" && t.type === "test")
  const want = counts(expected[file] || [])
  const got = counts(passed.map((t) => t.fullTitle))
  const missing = []
  const unexpected = []
  for (const [t, n] of want)
    for (let i = got.get(t) || 0; i < n; i++) missing.push(t)
  for (const [t, n] of got)
    for (let i = want.get(t) || 0; i < n; i++) unexpected.push(t)
  Object.assign(result, {
    exit: rc,
    mochaEnded: Boolean(results && results.ended),
    expected: (expected[file] || []).length,
    passing: passed.length,
    failing: failed.length,
    pending: pending.length,
  })
  const reasons = []
  if (!expected[file]) reasons.push("no expected case identities for this file")
  if (!results) reasons.push("no Mocha results were recorded")
  else if (!results.ended) reasons.push("Mocha did not finish")
  if (rc !== 0) reasons.push(`exit ${rc}`)
  if (failed.length)
    reasons.push(`failed: ${failed[0].fullTitle}: ${failed[0].error}`)
  if (pending.length)
    reasons.push(
      `pending/skipped: ${pending.map((t) => t.fullTitle).join("; ")}`
    )
  if (missing.length)
    reasons.push(
      `expected cases that did not pass: ${missing.length} (first: ${missing[0]})`
    )
  if (unexpected.length)
    reasons.push(`unexpected cases: ${unexpected.join("; ")}`)
  const d1Path = path.join(dir, "d1.json")
  if (fs.existsSync(d1Path)) {
    const d1Result = readJson(d1Path)
    result.d1 = d1Result
    if (reasons.length === 0 && !d1Result.ok)
      reasons.push(
        `legacy baseline is not D1 ${d1Result.d1.slice(0, 8)}: ${
          d1Result.problems[0]
        }`
      )
  }
  if (missing.length) result.notPassed = missing
  return {
    ...result,
    status: reasons.length ? "fail" : "pass",
    reason: reasons.join(" | ") || undefined,
  }
}

function manifest([root, evidence, expectedPath, planPath]) {
  const expected = readJson(expectedPath)
  const plan = readJson(planPath)
  let all = true
  for (const c of plan.cases) {
    const files = c.files.map((f) =>
      evaluateFile(root, evidence, expected, c.env, f)
    )
    const accepted = files.every((f) => f.status === "pass")
    all = all && accepted
    const m = {
      case: c.id,
      candidate: plan.candidate,
      shallow: c.env !== "full-history" && plan.shallow,
      environment: c.env,
      providedGoModules: c.env === "gomods" || c.env === "gomods-core",
      providedCore: c.env === "gomods-core",
      workflowSteps: plan.workflowSteps,
      provisionSeconds: plan.provisionSeconds,
      measuredSeconds: plan.measuredSeconds,
      jobs: plan.jobs,
      files,
      accepted,
    }
    fs.writeFileSync(
      path.join(evidence, `manifest-${c.id}.json`),
      `${JSON.stringify(m, null, 2)}\n`
    )
    for (const f of files)
      console.log(
        `${f.status.toUpperCase()} [${c.id}] ${f.file}${
          f.reason
            ? `: ${f.reason.slice(0, 400)}`
            : ` (${f.passing}/${f.expected})`
        }`
      )
    console.log(
      `manifest: ${path.join(
        evidence,
        `manifest-${c.id}.json`
      )} accepted=${accepted}`
    )
  }
  process.exit(all ? 0 : 1)
}

const [mode, ...args] = process.argv.slice(2)
if (mode === "d1") d1(args)
else if (mode === "manifest") manifest(args)
else throw Error(`unknown mode ${mode}`)
