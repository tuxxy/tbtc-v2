/* eslint-disable no-await-in-loop, no-restricted-syntax, no-bitwise */
// Single-input public-key-3 regtest component only; no threshold/key ceremony claim.
// Each call forks the stopped base datadir, so payment/cancellation can spend the
// same proven origin on separate Core branches matching separate EVM snapshots.
import { execFileSync, spawn } from "child_process"
import { createHash } from "crypto"
import fs from "fs"
import path from "path"
import assert from "assert"
import * as secp from "@noble/secp256k1"
import { digestBinaryForRun } from "./frost-digest-builder"
import {
  prepareEvidenceDirectory,
  reserveCorePort,
  trackCore,
  reapCore,
  copyStoppedCoreTemplate,
} from "./frost-test-isolation"
import { CORE, CORE_SHA } from "./frost-core-binary"

export type TransactionInfo = {
  version: string
  inputVector: string
  outputVector: string
  locktime: string
}
export type SettlementUTXO = {
  txHash: string
  txOutputIndex: number
  txOutputValue: number | string
}
export type CoreSettlementOptions = {
  coreWitness: {
    dataDirectory: string
    walletKey: string
    sweep: { txid: string; blockHash: string }
  }
  transaction: TransactionInfo
  input: SettlementUTXO
  outputDirectory: string
  digestBinary?: string
  competingRaw?: string
  replaceRaw?: string
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest()
const hash256 = (b: Buffer) => sha(sha(b))
const reverse = (s: string) => Buffer.from(s, "hex").reverse()
const toHex = (b: Buffer) => `0x${b.toString("hex")}`
const unhex = (s: string) => s.replace(/^0x/, "")
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function runCoreSettlement(options: CoreSettlementOptions) {
  const { coreWitness, transaction, input, outputDirectory } = options
  const digestBinary = digestBinaryForRun(
    options.digestBinary || process.env.FROST_C04_DIGEST_BINARY
  )
  assert.equal(
    sha(fs.readFileSync(path.join(CORE, "bitcoind"))).toString("hex"),
    CORE_SHA
  )
  const secret = "3".padStart(64, "0")
  const key = Buffer.from(secp.schnorr.getPublicKey(secret)).toString("hex")
  assert.equal(
    unhex(coreWitness.walletKey),
    key,
    "only controlled scalar-3 output supported; no second tweak"
  )
  const inputValue = Number(input.txOutputValue)
  assert(
    Number.isSafeInteger(inputValue) && inputValue > 0,
    "positive safe input value required"
  )
  assert(
    /^0x[0-9a-fA-F]{64}$/.test(input.txHash),
    "raw little-endian txHash required"
  )
  assert(
    Number.isInteger(input.txOutputIndex) &&
      input.txOutputIndex >= 0 &&
      input.txOutputIndex <= 0xffffffff,
    "output index width"
  )
  const inputTxid = reverse(unhex(input.txHash)).toString("hex")
  // This helper deliberately accepts only the custody output returned by the
  // original Core funding fixture, not synthetic inputs or separately funded keys.
  assert.equal(
    inputTxid,
    coreWitness.sweep.txid,
    "input must originate in the supplied real sweep"
  )
  assert.equal(input.txOutputIndex, 0, "single sweep output only")
  prepareEvidenceDirectory(outputDirectory)
  const dataDirectory = copyStoppedCoreTemplate(
    coreWitness.dataDirectory,
    "c04-core-settlement-"
  )
  const portLease = await reserveCorePort()
  const { port } = portLease
  const fd = fs.openSync(path.join(outputDirectory, "bitcoin-core.log"), "w")
  const node = spawn(
    path.join(CORE, "bitcoind"),
    [
      "-regtest",
      "-nosettings",
      `-datadir=${dataDirectory}`,
      "-server=1",
      "-listen=0",
      "-networkactive=0",
      "-dnsseed=0",
      "-discover=0",
      "-txindex=1",
      "-fallbackfee=0.0002",
      "-rpcbind=127.0.0.1",
      "-rpcallowip=127.0.0.1",
      `-rpcport=${port}`,
    ],
    { stdio: ["ignore", fd, fd] }
  )
  let spawnError: Error | undefined
  node.once("error", (error) => {
    spawnError = error
  })
  trackCore(node)
  const nodeDeadline = setTimeout(() => node.kill("SIGTERM"), 180000)
  const commands: { method: string; seconds: number; exit: number }[] = []
  const rpc = (method: string, args: unknown[] = []): any => {
    const start = Date.now()
    try {
      const text = execFileSync(
        path.join(CORE, "bitcoin-cli"),
        [
          "-regtest",
          `-datadir=${dataDirectory}`,
          `-rpcport=${port}`,
          "-rpcclienttimeout=30",
          method,
          ...args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))),
        ],
        {
          timeout: 45000,
          maxBuffer: 8 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        }
      )
        .toString()
        .trim()
      commands.push({ method, seconds: (Date.now() - start) / 1000, exit: 0 })
      if (text === "") return null
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    } catch (error) {
      commands.push({ method, seconds: (Date.now() - start) / 1000, exit: 1 })
      throw error
    }
  }
  const digest = (
    rawTransaction: string,
    prevScript?: Buffer,
    previousValue?: number
  ) =>
    JSON.parse(
      execFileSync(digestBinary, [], {
        input: JSON.stringify({
          rawTransaction,
          prevScript: prevScript?.toString("hex"),
          value: previousValue,
        }),
        timeout: 10000,
      }).toString()
    )
  const proofFor = (txid: string, blockHash: string) => {
    const block = rpc("getblock", [blockHash, 1])
    const index = block.tx.indexOf(txid)
    assert(
      index > 0,
      "real non-coinbase transaction must be in the mined block"
    )
    const leaves = block.tx.map((id: string) => reverse(id)) as Buffer[]
    const branch = (at: number) => {
      let position = at
      let nodes = leaves.slice()
      const siblings: Buffer[] = []
      while (nodes.length > 1) {
        siblings.push(
          nodes[(position ^ 1) < nodes.length ? position ^ 1 : position]
        )
        const next: Buffer[] = []
        for (let i = 0; i < nodes.length; i += 2)
          next.push(
            hash256(Buffer.concat([nodes[i], nodes[i + 1] || nodes[i]]))
          )
        nodes = next
        position = Math.floor(position / 2)
      }
      return { bytes: Buffer.concat(siblings), root: nodes[0] }
    }
    const inclusion = branch(index)
    const header = Buffer.from(rpc("getblockheader", [blockHash, false]), "hex")
    assert(
      header.subarray(36, 68).equals(inclusion.root),
      "computed branches must match the actual Core header"
    )
    const bits = header.readUInt32LE(72)
    const target = BigInt(bits & 0x007fffff) << BigInt(8 * ((bits >>> 24) - 3))
    assert(
      BigInt(`0x${Buffer.from(hash256(header)).reverse().toString("hex")}`) <=
        target,
      "actual header must satisfy PoW"
    )
    const coinbase = digest(
      rpc("getrawtransaction", [block.tx[0], false, blockHash])
    )
    assert.equal(coinbase.txidRPC, block.tx[0])
    return {
      merkleProof: toHex(inclusion.bytes),
      txIndexInBlock: index,
      bitcoinHeaders: toHex(header),
      coinbasePreimage: toHex(sha(Buffer.from(coinbase.strippedHex, "hex"))),
      coinbaseProof: toHex(branch(0).bytes),
      coreMerkleBlock: rpc("gettxoutproof", [[txid, block.tx[0]], blockHash]),
      relayQualification:
        "Actual Core regtest proofs; integer relay difficulty zero, not production confirmation-work evidence",
    }
  }
  try {
    let ready = false
    for (let i = 0; i < 40; i++) {
      if (spawnError) throw spawnError
      if (node.exitCode !== null)
        throw Error(`Core exited before readiness: ${node.exitCode}`)
      try {
        rpc("getblockchaininfo")
        ready = true
        break
      } catch {
        await sleep(250)
      }
    }
    assert(ready, "Core RPC readiness cap")
    const baseTip = rpc("getbestblockhash")
    const prev = rpc("gettxout", [inputTxid, input.txOutputIndex])
    assert(prev, "copied branch must retain unspent custody origin")
    const prevScript = Buffer.from(`5120${key}`, "hex")
    assert.equal(prev.scriptPubKey.hex, prevScript.toString("hex"))
    assert.equal(
      Math.round(prev.value * 1e8),
      inputValue,
      "actual Core input value must match frozen UTXO"
    )
    for (const field of [
      "version",
      "inputVector",
      "outputVector",
      "locktime",
    ] as const)
      assert(
        /^0x(?:[0-9a-fA-F]{2})+$/.test(transaction[field]),
        `invalid ${field}`
      )
    const unsignedRaw = [
      transaction.version,
      transaction.inputVector,
      transaction.outputVector,
      transaction.locktime,
    ]
      .map(unhex)
      .join("")
    const parsed = rpc("decoderawtransaction", [unsignedRaw])
    assert.equal(parsed.vin.length, 1, "single-input settlement only")
    assert.equal(parsed.vin[0].txid, inputTxid)
    assert.equal(parsed.vin[0].vout, input.txOutputIndex)
    assert.equal(parsed.vin[0].scriptSig.hex, "")
    assert(!parsed.vin[0].txinwitness, "frozen transaction must be unsigned")
    const computed = digest(unsignedRaw, prevScript, inputValue)
    assert.equal(
      computed.strippedHex,
      unsignedRaw.toLowerCase(),
      "exact frozen serialization"
    )
    assert.equal(computed.spendType, "key-path")
    const signature = Buffer.from(
      await secp.schnorr.sign(
        Buffer.from(computed.digest, "hex"),
        secret,
        new Uint8Array(32)
      )
    )
    assert.equal(signature.length, 64)
    assert(await secp.schnorr.verify(signature, computed.digest, key))
    // Marker/flag, exactly one 64-byte key-path witness; no annex or second tweak.
    const raw = `${unhex(transaction.version)}0001${unhex(
      transaction.inputVector
    )}${unhex(transaction.outputVector)}0140${signature.toString("hex")}${unhex(
      transaction.locktime
    )}`
    let replacement:
      | {
          previousTxid: string
          replacementTxid: string
          previousAdmission: any
          previousRemoved: boolean
        }
      | undefined
    if (options.replaceRaw) {
      const previous = rpc("decoderawtransaction", [options.replaceRaw])
      assert(
        previous.vin.some(
          (vin: any) =>
            vin.txid === inputTxid && vin.vout === input.txOutputIndex
        ),
        "replacement must conflict on captured custody"
      )
      assert.notEqual(previous.txid, computed.txidRPC)
      const previousAdmission = rpc("testmempoolaccept", [
        [options.replaceRaw],
      ])[0]
      assert.equal(
        previousAdmission.allowed,
        true,
        JSON.stringify(previousAdmission)
      )
      rpc("sendrawtransaction", [options.replaceRaw])
      assert(rpc("getrawmempool").includes(previous.txid))
      replacement = {
        previousTxid: previous.txid,
        replacementTxid: computed.txidRPC,
        previousAdmission,
        previousRemoved: false,
      }
    }
    const mempool = rpc("testmempoolaccept", [[raw]])[0]
    assert.equal(mempool.allowed, true, JSON.stringify(mempool))
    const settlementTxid = rpc("sendrawtransaction", [raw])
    if (replacement) {
      const entries = rpc("getrawmempool")
      assert(
        !entries.includes(replacement.previousTxid),
        "higher-fee replacement must remove old mempool transaction"
      )
      assert(entries.includes(settlementTxid))
      replacement.previousRemoved = true
    }
    assert.equal(
      settlementTxid,
      computed.txidRPC,
      "witness must preserve frozen txid"
    )
    const tip = rpc("getblock", [baseTip, 1])
    rpc("setmocktime", [tip.time + 600])
    const descriptor = rpc("getdescriptorinfo", [`rawtr(${key})`])
    const miner = rpc("deriveaddresses", [descriptor.descriptor])[0]
    const blockHash = rpc("generatetoaddress", [1, miner])[0]
    assert.equal(
      rpc("gettxout", [inputTxid, 0]),
      null,
      "actual custody input must be spent"
    )
    const proof = proofFor(settlementTxid, blockHash)
    let conflictRejection:
      | { allowed: boolean; [key: string]: unknown }
      | undefined
    if (options.competingRaw !== undefined) {
      const competing = rpc("decoderawtransaction", [options.competingRaw])
      assert(
        competing.vin.some(
          (vin: { txid?: string; vout?: number }) =>
            vin.txid === inputTxid && vin.vout === input.txOutputIndex
        ),
        "competing transaction must spend the same custody input"
      )
      assert.notEqual(
        competing.txid,
        settlementTxid,
        "distinct competing spend required"
      )
      const rejection = rpc("testmempoolaccept", [[options.competingRaw]])[0]
      assert.equal(rejection.allowed, false, JSON.stringify(rejection))
      conflictRejection = rejection
    }
    const result = {
      scope:
        "Single-input key-path component with known scalar 3, independent copied Core branch and actual Core SPV; no threshold signing or production work qualification",
      baseDataDirectory: coreWitness.dataDirectory,
      dataDirectory,
      baseTip,
      coreExecutableSha256: CORE_SHA,
      input,
      prevScript: toHex(prevScript),
      unsignedRaw,
      transaction,
      raw,
      digest: computed.digest,
      txid: settlementTxid,
      txHash: toHex(reverse(settlementTxid)),
      blockHash,
      mempool,
      proof,
      conflictRejection,
      replacement,
      commands,
      limits: {
        outerSeconds: 180,
        rpcProcessSeconds: 10,
        rpcClientSeconds: 5,
        localOnly: true,
      },
      productionQualification: false,
    }
    fs.writeFileSync(
      path.join(outputDirectory, "core-settlement.json"),
      `${JSON.stringify(result, null, 2)}\n`
    )
    return result
  } finally {
    try {
      rpc("stop")
    } catch {
      node.kill("SIGTERM")
    }
    clearTimeout(nodeDeadline)
    await reapCore(node, dataDirectory)
    portLease.release()
    fs.closeSync(fd)
  }
}
export default runCoreSettlement
