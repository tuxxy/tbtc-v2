// ADAPTER (labelled, observation only; see fresh-checkout.sh): loaded with
// NODE_OPTIONS=--require, it records every Mocha test and hook outcome as
// JSON in PORTABILITY_RESULTS. It changes nothing in the run, except that
// PORTABILITY_DRY_RUN=1 lists the tests without running them (used to
// regenerate expected-cases.json).
const fs = require("fs")
const Module = require("module")

const out = process.env.PORTABILITY_RESULTS
if (out) {
  const load = Module._load
  let patched = false
  Module._load = function patchedLoad(request, ...rest) {
    const exported = load.call(this, request, ...rest)
    if (patched || request !== "mocha") return exported
    const Mocha = exported && (exported.default || exported)
    if (Mocha && Mocha.prototype && typeof Mocha.prototype.run === "function") {
      patched = true
      const run = Mocha.prototype.run
      Mocha.prototype.run = function collect(fn) {
        if (process.env.PORTABILITY_DRY_RUN === "1") this.options.dryRun = true
        const records = []
        let ended = false
        const write = () =>
          fs.writeFileSync(
            out,
            `${JSON.stringify({ ended, tests: records }, null, 1)}\n`
          )
        const record = (state) => (test, error) =>
          records.push({
            file: test.file || (test.parent && test.parent.file) || null,
            type: test.type,
            fullTitle: test.fullTitle(),
            state,
            error: error ? String(error.message || error).slice(0, 300) : null,
          })
        const runner = run.call(this, fn)
        runner.on("pass", record("passed"))
        runner.on("fail", record("failed"))
        runner.on("pending", record("pending"))
        runner.on("end", () => {
          ended = true
          write()
        })
        process.on("exit", () => {
          if (!ended) write()
        })
        return runner
      }
    }
    return exported
  }
}
