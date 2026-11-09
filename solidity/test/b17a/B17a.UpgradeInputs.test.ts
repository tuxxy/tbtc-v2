/* eslint-disable no-restricted-syntax */
// Remediation batch 17a: the K-09 P3 findings on the upgrade stage's inputs.
// Refs tuxxy/tbtc-v2#17 (K09-14, digest half) and tuxxy/tbtc-v2#19 (K09-19,
// source-root half). The replay half of #17 is in
// test/bridge/Frost.LegacyReconciliation.test.ts (piece 2b).
//
// Invariant: an upgrade-stage input the run did not build itself and does not
// pin is never used silently. Concretely:
// - [17] the legacy transaction parser (`frost-digest`) is the binary built
//   from the committed frost-tapscript-digest.go, or an override pinned by
//   hash; an unpinned override is refused (the refusal names the variable or
//   says the override is unpinned) or ignored, never used on a schema check
//   alone (K09-14: "pin and record the binary as the runner does for the
//   worker"). That holds whether the override comes from
//   FROST_C04_DIGEST_BINARY, with no pin or a wrong pin, or is passed
//   directly (options.digestBinary, or FROST_C05_DIGEST_BINARY as
//   frost-bitcoin.ts and the Frost.Fraud tests pass it).
// - [19] the "upgraded runtime equals HEAD" binding of the legacy origin
//   fixture is this checkout's HEAD; FROST_C04_LEGACY_SOURCE_ROOT cannot
//   redirect it to another repository (K09-19: it "silently redirects the
//   repository behind the current runtime equals HEAD binding").
//
// Kinds (tuxxy/keep-core#134's rule): all cases are e2e. [17] runs `go build`
// and child processes, with no chain. [19] uses the Hardhat network and the
// pinned Bitcoin Core through the legacy origin fixture. A refusal design
// keeps [19] under a second. A design that ignores the variable runs the
// whole fixture once, about 8 s with the baseline warmed in `before`.
import { expect } from "chai"
import { execFileSync } from "child_process"
import { createHash } from "crypto"
import fs from "fs"
import os from "os"
import path from "path"

import { digestBinaryForRun } from "../helpers/frost-digest-builder"
import { legacyBaselineBuild } from "../helpers/frost-legacy-baseline"
import { publicLegacyOriginFixture } from "../helpers/frost-legacy-bitcoin"

const checkout = path.resolve(__dirname, "../../..")
const foreign = path.join(__dirname, "fixtures/foreign-digest.js")
const LEGACY_BASELINE = "40a11d1dcdcf82d3962e430067cfe3f97be81483"

function scratch(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, timeout: 30000 }).toString().trim()
}

// Runs `call` with the environment variable set (or removed) and restores it.
async function withEnv<T>(
  name: string,
  value: string | undefined,
  call: () => Promise<T> | T
): Promise<T> {
  const saved = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    return await call()
  } finally {
    if (saved === undefined) delete process.env[name]
    else process.env[name] = saved
  }
}

describe("B17a upgrade-stage inputs (K09-14, K09-19)", () => {
  describe("[17] digest parser pin (e2e)", () => {
    // Runs the builder with the given override source and pin, and checks
    // that the unpinned FIXTURE parser is refused or not used. The FIXTURE
    // parser passes the builder's schema probe; it is executable and lives in
    // the checkout, not in a temporary directory.
    async function expectUnpinnedOverrideNotUsed(
      what: string,
      envOverride: string | undefined,
      pin: string | undefined,
      call: () => string
    ): Promise<void> {
      const foreignBytes = fs.readFileSync(foreign)
      let selected: string | undefined
      let refusal: Error | undefined
      await withEnv("FROST_C04_DIGEST_BINARY", envOverride, () =>
        withEnv("FROST_C04_DIGEST_BINARY_SHA256", pin, () => {
          try {
            selected = call()
          } catch (error) {
            refusal = error as Error
          }
        })
      )
      if (refusal) {
        expect(
          refusal.message,
          `K09-14: digestBinaryForRun refused the override (${what}), but not as an unpinned override (${refusal.message})`
        ).to.match(/FROST_C0[45]_DIGEST_BINARY|unpinned|not pinned/i)
        return
      }
      expect(
        path.resolve(selected as string),
        `K09-14: digestBinaryForRun used the unpinned FROST_C04_DIGEST_BINARY override (accepted on the schema probe alone; ${what})`
      ).to.not.equal(path.resolve(foreign))
      expect(
        fs.readFileSync(selected as string).equals(foreignBytes),
        `K09-14: digestBinaryForRun returned a byte copy of the unpinned override (${what})`
      ).to.equal(false)
    }

    // Most callers pass `options.digestBinary ||
    // process.env.FROST_C04_DIGEST_BINARY` (frost-legacy-bitcoin,
    // frost-core-settlement, frost-core-conflicting-sweep,
    // frost-public-vault-callback). frost-bitcoin also falls back to
    // FROST_C05_DIGEST_BINARY, and the Frost.Fraud tests set only that one.
    it("never uses an unpinned FROST_C04_DIGEST_BINARY override", () =>
      expectUnpinnedOverrideNotUsed(
        "environment, no pin",
        foreign,
        undefined,
        () => digestBinaryForRun(process.env.FROST_C04_DIGEST_BINARY)
      ))

    it("never uses a FROST_C04_DIGEST_BINARY override whose pin is wrong", () =>
      expectUnpinnedOverrideNotUsed(
        "environment, FROST_C04_DIGEST_BINARY_SHA256 set to another binary's hash",
        foreign,
        createHash("sha256")
          .update(
            fs.readFileSync(
              path.join(__dirname, "../helpers/frost-tapscript-digest.go")
            )
          )
          .digest("hex"),
        () => digestBinaryForRun(process.env.FROST_C04_DIGEST_BINARY)
      ))

    it("never uses an unpinned override passed directly (options.digestBinary, FROST_C05_DIGEST_BINARY)", () =>
      expectUnpinnedOverrideNotUsed(
        "passed directly, FROST_C04_DIGEST_BINARY unset",
        undefined,
        undefined,
        () => digestBinaryForRun(foreign)
      ))

    it("builds the default parser from the committed source and records it (guard)", () => {
      const selected = withEnv("FROST_C04_DIGEST_BINARY", undefined, () =>
        digestBinaryForRun(undefined)
      )
      return selected.then((binary) => {
        const binding = JSON.parse(
          fs.readFileSync(
            path.join(path.dirname(binary), "source-binding.json"),
            "utf8"
          )
        )
        const committed = execFileSync(
          "git",
          ["show", "HEAD:solidity/test/helpers/frost-tapscript-digest.go"],
          { cwd: checkout, timeout: 30000 }
        )
        expect(
          binding.sourceSHA256,
          "K09-14 guard: the default parser's source binding does not name the committed frost-tapscript-digest.go"
        ).to.equal(createHash("sha256").update(committed).digest("hex"))
        expect(
          binding.binarySHA256,
          "K09-14 guard: the default parser's binding does not hash the binary it returned"
        ).to.equal(
          createHash("sha256").update(fs.readFileSync(binary)).digest("hex")
        )
      })
    })
  })

  describe("[19] legacy origin source root (e2e)", () => {
    // The baseline build is cached per repository path, so warming it for
    // this checkout changes nothing a fix can observe. A fix that ignores the
    // redirect reuses it, and one that follows it builds under the redirect.
    before(async function warmBaseline() {
      this.timeout(120000)
      await legacyBaselineBuild(checkout)
    })

    it("binds the upgraded runtime to this checkout, never to FROST_C04_LEGACY_SOURCE_ROOT", async function sourceRoot() {
      this.timeout(300000)
      const head = git(checkout, "rev-parse", "HEAD")
      // FIXTURE redirect target: a shared clone of this repository whose HEAD
      // is the D1 baseline 40a11d1d. It holds every object the fixture reads
      // (so a check for 40a11d1d's presence does not refuse it), and its HEAD
      // differs from this checkout's.
      const common = path.resolve(
        checkout,
        git(checkout, "rev-parse", "--git-common-dir")
      )
      const redirectRoot = scratch("b17a-source-root-")
      const redirect = path.join(redirectRoot, "repo")
      execFileSync(
        "git",
        ["clone", "--quiet", "--shared", "--no-checkout", common, redirect],
        { timeout: 60000 }
      )
      git(redirect, "update-ref", "--no-deref", "HEAD", LEGACY_BASELINE)
      expect(git(redirect, "rev-parse", "HEAD")).to.equal(LEGACY_BASELINE)
      expect(
        head,
        "FIXTURE: the redirect target's HEAD must differ"
      ).to.not.equal(LEGACY_BASELINE)

      const evidenceRoot = scratch("b17a-origin-")
      const evidence = path.join(evidenceRoot, "evidence")
      let origin: { currentRevision: string } | undefined
      let refusal: Error | undefined
      try {
        await withEnv("FROST_C04_LEGACY_SOURCE_ROOT", redirect, () =>
          withEnv("FROST_C04_LEGACY_BASELINE_BUILD", undefined, async () => {
            try {
              origin = await publicLegacyOriginFixture(evidence)
            } catch (error) {
              refusal = error as Error
            }
          })
        )
      } finally {
        // The FIXTURE clone and this case's evidence are scratch.
        fs.rmSync(redirectRoot, { recursive: true, force: true })
        fs.rmSync(evidenceRoot, { recursive: true, force: true })
      }
      if (refusal) {
        expect(
          refusal.message,
          `K09-19: the legacy origin fixture followed FROST_C04_LEGACY_SOURCE_ROOT to another repository and failed there (${
            refusal.message.split("\n")[0]
          })`
        ).to.match(/FROST_C04_LEGACY_SOURCE_ROOT/)
        return
      }
      expect(
        origin?.currentRevision,
        `K09-19: the legacy origin fixture bound the upgraded runtime to FROST_C04_LEGACY_SOURCE_ROOT's HEAD, not this checkout's ${head}`
      ).to.equal(head)
    })
  })
})
