/* eslint-disable no-await-in-loop, no-restricted-syntax, no-bitwise */
import { artifacts, ethers } from "hardhat"
import { expect } from "chai"
import fs from "fs"
import path from "path"
import { createHash } from "crypto"
import * as secp from "@noble/secp256k1"
import provenance from "../data/frost/bip340/provenance.json"

const DATA = path.join(__dirname, "../data/frost/bip340")
const hex = (value: Uint8Array) => `0x${Buffer.from(value).toString("hex")}`
const bytes = (value: string) => Buffer.from(value.replace(/^0x/, ""), "hex")
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest()
const { P } = secp.CURVE
const N = secp.CURVE.n
const G = { x: word(secp.CURVE.Gx), y: word(secp.CURVE.Gy), z: 1 }
const infinity = { x: 0, y: 0, z: 0 }
// Full upstream CSV is retained. Parsing supports quoted commas and escaped quotes.
function csvRow(line: string): string[] {
  const columns: string[] = []
  let value = ""
  let quoted = false
  const quote = String.fromCharCode(34)
  for (let i = 0; i < line.length; i++) {
    if (line[i] === quote) {
      if (quoted && line[i + 1] === quote) {
        value += quote
        i += 1
      } else quoted = !quoted
    } else if (line[i] === "," && !quoted) {
      columns.push(value)
      value = ""
    } else value += line[i]
  }
  columns.push(value)
  return columns
}
const vectors = fs
  .readFileSync(path.join(DATA, "test-vectors.csv"), "utf8")
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map(csvRow)
  .map(
    ([
      index,
      secret,
      key,
      auxiliary,
      message,
      signature,
      expected,
      comment,
    ]) => ({
      index: Number(index),
      secret,
      key: `0x${key}`,
      auxiliary,
      message: `0x${message}`,
      signature: `0x${signature}`,
      expected: expected === "TRUE",
      comment,
    })
  )
const fixed = vectors.filter((vector) => bytes(vector.message).length === 32)

async function verifier() {
  const contract = await (
    await ethers.getContractFactory("FrostVerifier")
  ).deploy()
  await contract.deployed()
  expect(
    (await ethers.provider.getCode(contract.address)).length / 2 - 1
  ).to.be.at.most(24576)
  return contract
}
async function arithmetic() {
  return (await ethers.getContractFactory("FrostSecp256k1Fixture")).deploy()
}

function independentTweak(key: string, root: string) {
  // BIP341: this API takes an explicit 32-byte Merkle root. A zero root is
  // 32 zero bytes, not the omitted-root (key-only) tweak domain.
  const tag = hash(Buffer.from("TapTweak"))
  const t = BigInt(
    hex(hash(Buffer.concat([tag, tag, bytes(key), bytes(root)])))
  )
  if (t >= N) return undefined
  const p = secp.Point.fromHex(`02${key.slice(2)}`)
  const q = t === 0n ? p : p.add(secp.Point.BASE.multiply(t))
  if (q.equals(secp.Point.ZERO)) return undefined
  return { key: word(q.x), parity: Number(q.y & 1n) }
}

describe("C-07 strict bytes32 BIP340 and explicit-root TapTweak", () => {
  it("retains exact pinned official CSV/license and existing pinned independent oracle", () => {
    for (const record of provenance.files) {
      const name = record.path.endsWith("LICENSE")
        ? "LICENSE"
        : "test-vectors.csv"
      const data = fs.readFileSync(path.join(DATA, name))
      expect(hash(data).toString("hex")).to.equal(record.sha256)
      expect(
        createHash("sha1")
          .update(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data]))
          .digest("hex")
      ).to.equal(record.git_blob_sha1)
    }
    expect(fixed.map((v) => v.index)).to.deep.equal(
      Array.from({ length: 15 }, (_, i) => i)
    )
    const packageFile = path.join(
      path.dirname(require.resolve("@noble/secp256k1")),
      "../package.json"
    )
    expect(JSON.parse(fs.readFileSync(packageFile, "utf8")).version).to.equal(
      "1.6.3"
    )
  })

  for (const vector of fixed) {
    it(`matches official BIP340 vector ${vector.index}: ${
      vector.comment || "valid signature"
    }`, async () => {
      const v = await verifier()
      expect(
        await v.verify(vector.key, vector.message, vector.signature)
      ).to.equal(vector.expected)
      expect(
        await secp.schnorr.verify(
          bytes(vector.signature),
          bytes(vector.message),
          bytes(vector.key)
        )
      ).to.equal(vector.expected)
    })
  }

  it("rejects the official arbitrary-message extension at ABI encoding instead of changing the message", async () => {
    const v = await verifier()
    const extension = vectors.filter(
      (vector) => bytes(vector.message).length !== 32
    )
    expect(extension.map((vector) => vector.index)).to.deep.equal([
      15, 16, 17, 18,
    ])
    for (const vector of extension) {
      expect(() =>
        v.interface.encodeFunctionData("verify", [
          vector.key,
          vector.message,
          vector.signature,
        ])
      ).to.throw()
    }
  })

  it("refuses signature lengths other than 64 including an appended sighash byte", async () => {
    const v = await verifier()
    const vector = fixed[0]
    for (const signature of [
      "0x",
      "0x00",
      hex(bytes(vector.signature).subarray(0, 63)),
      `${vector.signature}00`,
      `${vector.signature}${vector.signature.slice(2)}`,
    ]) {
      expect(await v.verify(vector.key, vector.message, signature)).to.equal(
        false
      )
    }
  })

  it("treats arbitrary 32-byte digests as bytes without scalar or field reduction", async () => {
    const v = await verifier()
    const secret = word(3n)
    const key = hex(secp.schnorr.getPublicKey(secret.slice(2)))
    for (const message of [
      word(0n),
      word(P),
      word(N),
      `0x${"ff".repeat(32)}`,
    ]) {
      const signature = hex(
        await secp.schnorr.sign(
          bytes(message),
          secret.slice(2),
          new Uint8Array(32)
        )
      )
      expect(await v.verify(key, message, signature)).to.equal(true)
      const changed = hex(
        Buffer.from(
          bytes(message).map((byte, i) => (i === 0 ? byte ^ 1 : byte))
        )
      )
      expect(await v.verify(key, changed, signature)).to.equal(false)
    }
  })

  it("matches deterministic TapTweak outputs and parity against noble with explicit 32-byte roots", async () => {
    const v = await verifier()
    const parity = new Set<number>()
    for (const scalar of [1n, 2n, 3n, 17n]) {
      const key = hex(secp.schnorr.getPublicKey(word(scalar).slice(2)))
      for (const root of [word(0n), ethers.utils.id(`fixed-root-${scalar}`)]) {
        const expected = independentTweak(key, root)
        if (!expected) throw new Error("Unexpected invalid independent tweak")
        const result = await v.tapTweak(key, root)
        expect(result.valid).to.equal(true)
        expect(result.outputKey).to.equal(expected.key)
        expect(result.parity).to.equal(expected.parity)
        parity.add(result.parity)
      }
    }
    expect([...parity].sort()).to.deep.equal([0, 1])
    for (const key of [word(P), word(P + 1n), fixed[5].key]) {
      expect((await v.tapTweak(key, word(0n))).valid).to.equal(false)
    }
  })

  it("names raw e=0, s=0, t=0 and infinity exceptions without claiming hash preimages", async () => {
    const curve = await arithmetic()
    const constants = await curve.constants()
    expect(constants.p).to.equal(word(P))
    expect(constants.n).to.equal(word(N))
    expect(constants.gx).to.equal(G.x)
    expect(constants.gy).to.equal(G.y)
    const zeroProduct = await curve.multiply(G, 0)
    expect(
      (await curve.affine(zeroProduct))[0],
      "s=0/e=0 multiplication is infinity"
    ).to.equal(false)
    const unchanged = await curve.add(G, zeroProduct)
    const affine = await curve.affine(unchanged)
    expect(
      affine[0],
      "t=0: P + 0G is P, not a constructed TapTweak hash preimage"
    ).to.equal(true)
    expect(affine[1]).to.equal(G.x)
    expect(affine[2]).to.equal(G.y)
    expect(
      (await curve.affine(await curve.multiply(G, word(N))))[0],
      "nG is infinity"
    ).to.equal(false)
    expect((await curve.affine(infinity))[0]).to.equal(false)
    expect((await curve.affine(await curve.doublePoint(infinity)))[0]).to.equal(
      false
    )
    const inverse = { x: G.x, y: word(P - secp.CURVE.Gy), z: 1 }
    expect(
      (await curve.affine(await curve.add(G, inverse)))[0],
      "P + (-P) is infinity"
    ).to.equal(false)
    const doubled = await curve.affine(await curve.doublePoint(G))
    const sum = await curve.affine(await curve.add(G, G))
    expect(sum).to.deep.equal(doubled)
    expect(doubled[1]).to.equal(word(secp.Point.BASE.multiply(2n).x))
    expect(doubled[2]).to.equal(word(secp.Point.BASE.multiply(2n).y))
  })

  it("lifts only canonical curve x coordinates to even Y", async () => {
    const curve = await arithmetic()
    for (const vector of fixed.filter((entry) => entry.expected)) {
      const lifted = await curve.lift(vector.key)
      expect(lifted[0]).to.equal(true)
      const affine = await curve.affine(lifted[1])
      expect(affine[0]).to.equal(true)
      expect(affine[1]).to.equal(vector.key)
      expect(affine[2].mod(2)).to.equal(0)
    }
    for (const key of [word(P), word(P + 1n), fixed[5].key])
      expect((await curve.lift(key))[0]).to.equal(false)
  })

  it("exposes exact isValidKey lift validity at canonical field boundaries", async () => {
    const v = await verifier()
    const api = await ethers.getContractAt("IFrostVerifier", v.address)
    const curve = await arithmetic()
    const keys = new Set([
      ...fixed.map((vector) => vector.key),
      word(0n),
      word(1n),
      word(P - 1n),
      word(P),
      word(P + 1n),
      `0x${"ff".repeat(32)}`,
      G.x,
    ])
    for (const key of keys) {
      let expected = false
      try {
        secp.Point.fromHex(`02${key.slice(2)}`)
        expected = true
      } catch {
        // Invalid field encodings/nonresidues are refused by the independent oracle.
      }
      expect(await api.isValidKey(key), key).to.equal(expected)
      expect((await curve.lift(key))[0], key).to.equal(expected)
    }
    expect(await api.isValidKey(G.x)).to.equal(true)
    for (const key of [word(P), word(P + 1n), fixed[5].key, fixed[14].key])
      expect(await api.isValidKey(key)).to.equal(false)
    for (const shortOrLong of ["0x", "0x01", `${G.x}00`])
      expect(() =>
        api.interface.encodeFunctionData("isValidKey", [shortOrLong])
      ).to.throw()
  })

  it("records sampled verification/TapTweak gas with a finite local regression ceiling", async () => {
    const v = await verifier()
    let worst = ethers.BigNumber.from(0)
    for (const vector of fixed.filter((entry) => entry.expected)) {
      const gas = await v.estimateGas.verify(
        vector.key,
        vector.message,
        vector.signature
      )
      if (gas.gt(worst)) worst = gas
    }
    const tapGas = await v.estimateGas.tapTweak(G.x, word(0n))
    // An invalid signature still executes both full-width multiplications.
    // This finite dense-scalar probe is not a universal maximum-gas proof.
    const denseInvalidGas = await v.estimateGas.verify(
      G.x,
      `0x${"ff".repeat(32)}`,
      `${G.x}${word(N - 1n).slice(2)}`
    )
    const runtime =
      ((await artifacts.readArtifact("FrostVerifier")).deployedBytecode.length -
        2) /
      2
    // Local test stop/regression bound only; not a proven worst-case bound or release gate.
    expect(worst.toNumber()).to.be.lessThan(8000000)
    expect(tapGas.toNumber()).to.be.lessThan(8000000)
    expect(denseInvalidGas.toNumber()).to.be.lessThan(8000000)
    process.stdout.write(
      `C07_SAMPLED_GAS ${JSON.stringify({
        verify: worst.toString(),
        tapTweak: tapGas.toString(),
        denseInvalid: denseInvalidGas.toString(),
        runtimeBytes: runtime,
        localCeiling: 8000000,
        qualification: false,
      })}\n`
    )
  })
})
