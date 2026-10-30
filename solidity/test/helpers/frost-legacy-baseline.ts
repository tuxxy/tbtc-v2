/* eslint-disable no-restricted-syntax */
// The pre-FROST legacy baseline (owner decision D1: tbtc-v2 main 40a11d1d),
// built from git for the legacy reconciliation tests. Bridge's import closure
// (Bank and every library Bridge links included) is compiled from that
// commit's sources, read with `git show`, with the current Bridge build's
// compiler input settings; package files keep their built content (the lock
// is unchanged since 40a11d1d). The result is a Hardhat-shaped build
// (artifacts, debug files, one build-info) in a fresh temporary directory,
// built once per process. Nothing prebuilt is read.
import assert from "assert"
import { execFileSync } from "child_process"
import { createHash } from "crypto"
import fs from "fs"
import os from "os"
import path from "path"

export const LEGACY_BASELINE = "40a11d1dcdcf82d3962e430067cfe3f97be81483"

let built: Promise<string> | undefined

async function build(repository: string): Promise<string> {
  const { artifacts, run } = await import("hardhat")
  const info = await artifacts.getBuildInfo(
    "contracts/bridge/Bridge.sol:Bridge"
  )
  assert(info, "current Bridge build-info")
  const input = JSON.parse(JSON.stringify(info.input))
  input.sources = {}
  const pending = ["contracts/bridge/Bridge.sol"]
  while (pending.length > 0) {
    const key = pending.pop()!
    if (!input.sources[key]) {
      let content: string
      if (key.startsWith("contracts/")) {
        content = execFileSync(
          "git",
          ["show", `${LEGACY_BASELINE}:solidity/${key}`],
          { cwd: repository, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
        )
      } else {
        assert(info.input.sources[key], `package source ${key}`)
        content = info.input.sources[key].content
      }
      input.sources[key] = { content }
      for (const [, spec] of content.matchAll(
        /import\s+(?:[^"';]*\s+from\s+)?["']([^"']+)["']/g
      ))
        pending.push(
          spec.startsWith(".")
            ? path.posix.join(path.posix.dirname(key), spec)
            : spec
        )
    }
  }
  const compiler = await run("compile:solidity:solc:get-build", {
    quiet: true,
    solcVersion: info.solcVersion,
  })
  const output = await run(
    compiler.isSolcJs
      ? "compile:solidity:solcjs:run"
      : "compile:solidity:solc:run",
    compiler.isSolcJs
      ? { input, solcJsPath: compiler.compilerPath }
      : { input, solcPath: compiler.compilerPath }
  )
  const errors = (output.errors || []).filter(
    (e: { severity: string }) => e.severity === "error"
  )
  assert.deepEqual(errors, [], "the 40a11d1d baseline compiles")

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-baseline-"))
  const id = createHash("sha256").update(JSON.stringify(input)).digest("hex")
  const buildInfo = path.join(directory, "build-info", `${id}.json`)
  fs.mkdirSync(path.dirname(buildInfo))
  fs.writeFileSync(
    buildInfo,
    JSON.stringify({
      _format: "hh-sol-build-info-1",
      id,
      solcVersion: info.solcVersion,
      solcLongVersion: info.solcLongVersion,
      input,
      output,
    })
  )
  for (const [source, contracts] of Object.entries(
    output.contracts as Record<string, Record<string, any>>
  )) {
    for (const [name, contract] of Object.entries(contracts)) {
      const artifact = path.join(directory, source, `${name}.json`)
      fs.mkdirSync(path.dirname(artifact), { recursive: true })
      fs.writeFileSync(
        artifact,
        JSON.stringify({
          _format: "hh-sol-artifact-1",
          contractName: name,
          sourceName: source,
          abi: contract.abi,
          bytecode: `0x${contract.evm.bytecode.object}`,
          deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
          linkReferences: contract.evm.bytecode.linkReferences,
          deployedLinkReferences: contract.evm.deployedBytecode.linkReferences,
        })
      )
      fs.writeFileSync(
        artifact.replace(/\.json$/, ".dbg.json"),
        JSON.stringify({
          _format: "hh-sol-dbg-1",
          buildInfo: path.relative(path.dirname(artifact), buildInfo),
        })
      )
    }
  }
  return directory
}

export function legacyBaselineBuild(repository: string): Promise<string> {
  if (!built) built = build(repository)
  return built
}
