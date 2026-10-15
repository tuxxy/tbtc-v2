/* eslint-disable no-await-in-loop */
// Test-only isolation. Evidence defaults are disposable; templates become
// readable only after their owning Core child has been fully reaped.
import fs from "fs"
import os from "os"
import path from "path"
import net from "net"
import assert from "assert"
import { ChildProcess } from "child_process"

function canonicalDirectory(directory: string): string {
  const target = path.resolve(directory)
  let ancestor = target
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor)
  return path.resolve(
    fs.realpathSync(ancestor),
    path.relative(ancestor, target)
  )
}
function within(directory: string, root: string): boolean {
  const relative = path.relative(root, directory)
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
}
export function prepareEvidenceDirectory(directory: string): string {
  const target = canonicalDirectory(directory)
  const temporary = [os.tmpdir(), "/tmp"].some((root) =>
    within(target, canonicalDirectory(root))
  )
  const retained = Object.entries(process.env).some(
    ([name, root]) =>
      name.startsWith("FROST_C05_") &&
      name.endsWith("_EVIDENCE") &&
      !!root &&
      within(target, canonicalDirectory(root))
  )
  assert(
    temporary || retained,
    "retained evidence requires an explicit FROST_C05_*_EVIDENCE environment root"
  )
  fs.mkdirSync(directory, { recursive: true })
  return directory
}

export function evidenceDirectory(label: string, retained?: string): string {
  if (retained) {
    return prepareEvidenceDirectory(retained)
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), `c05-${label}-`))
}

export async function reserveCorePort(): Promise<{
  port: number
  release: () => void
}> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const server = net.createServer()
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    assert(address && typeof address !== "string")
    const { port } = address
    const lease = path.join(
      os.tmpdir(),
      `threshold-frost-core-port-${port}.lease`
    )
    let acquired = false
    try {
      const fd = fs.openSync(lease, "wx")
      fs.writeFileSync(fd, String(process.pid))
      fs.closeSync(fd)
      acquired = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
    if (acquired)
      return {
        port,
        release: () => {
          fs.rmSync(lease, { force: true })
        },
      }
  }
  throw Error("Core port lease attempts exhausted")
}

const closed = new WeakMap<ChildProcess, Promise<void>>()
export function trackCore(node: ChildProcess): void {
  node.on("error", () => {}) // Failed spawns still emit close; callers inspect readiness.
  closed.set(node, new Promise((resolve) => node.once("close", resolve)))
}
async function waitClosed(
  node: ChildProcess,
  milliseconds: number
): Promise<boolean> {
  const completion = closed.get(node)
  assert(completion, "Core must be tracked immediately after spawn")
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      completion.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
export async function reapCore(
  node: ChildProcess,
  dataDirectory: string
): Promise<void> {
  if (!(await waitClosed(node, 3000))) {
    node.kill("SIGTERM")
    if (!(await waitClosed(node, 3000))) {
      node.kill("SIGKILL")
      assert(
        await waitClosed(node, 3000),
        "Core child did not close after kill"
      )
    }
  }
  fs.writeFileSync(
    path.join(dataDirectory, ".frost-core-stopped.json"),
    JSON.stringify({
      pid: node.pid,
      exitCode: node.exitCode,
      signalCode: node.signalCode,
      clean: node.exitCode === 0 && node.signalCode === null,
    })
  )
}

export function copyStoppedCoreTemplate(base: string, prefix: string): string {
  const marker = path.join(base, ".frost-core-stopped.json")
  const pidFile = path.join(base, "regtest", "bitcoind.pid")
  if (fs.existsSync(marker))
    assert(
      JSON.parse(fs.readFileSync(marker, "utf8")).clean === true,
      "Core template did not stop cleanly"
    )
  // Old retained templates without a marker remain usable only when no pid file
  // exists. New helpers return only after close, eliminating the former race.
  assert(!fs.existsSync(pidFile), "base Core must be stopped before copying")
  const target = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const controls = new Set([
    "bitcoind.pid",
    ".cookie",
    ".lock",
    "LOCK",
    ".frost-core-stopped.json",
  ])
  fs.cpSync(base, target, {
    recursive: true,
    filter: (source) => !controls.has(path.basename(source)),
  })
  return target
}
