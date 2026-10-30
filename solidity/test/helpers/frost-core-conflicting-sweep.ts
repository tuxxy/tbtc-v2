/* eslint-disable no-await-in-loop, no-restricted-syntax, no-bitwise */
// Two-phase actual main+deposit conflict component; known scalar 3 only.
// Preparation signs and archives without broadcasting; the mine phase forks its
// stopped datadir and mines identical bytes after the EVM reservation exists.
import { execFileSync, spawn } from "child_process"
import { createHash } from "crypto"
import fs from "fs"
import path from "path"
import assert from "assert"
import * as secp from "@noble/secp256k1"
import { digestBinaryForRun } from "./frost-digest-builder"
import {
  encodeProfile,
  NUMS,
  tagged,
  compact,
  unsigned,
  fromHex,
} from "../data/frost/deposit-profile"
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
export type CoreConflictingSweepOptions = {
  coreWitness: any
  input: SettlementUTXO
  outputDirectory: string
  prepared?: any
  competingRaw?: string
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest()
const hash256 = (b: Buffer) => sha(sha(b))
const reverse = (s: string) => Buffer.from(s, "hex").reverse()
const toHex = (b: Buffer) => `0x${b.toString("hex")}`
const unhex = (s: string) => s.replace(/^0x/, "")
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function runCoreConflictingSweep(
  options: CoreConflictingSweepOptions
) {
  const { coreWitness, input, outputDirectory, prepared } = options
  const digestBinary = digestBinaryForRun(process.env.FROST_C04_DIGEST_BINARY)
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
    prepared?.dataDirectory || coreWitness.dataDirectory,
    "c04-core-conflicting-sweep-"
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
          "-rpcclienttimeout=5",
          method,
          ...args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))),
        ],
        {
          timeout: 10000,
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
  const digest = (rawTransaction: string, fields: any = {}) =>
    JSON.parse(
      execFileSync(digestBinary, [], {
        input: JSON.stringify({ rawTransaction, ...fields }),
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
    let raw: string
    let computed: any
    let funding: any
    let terms: any
    let profile: any
    if (!prepared) {
      if (!rpc("listwallets").includes("c05fixture"))
        rpc("loadwallet", ["c05fixture"])
      terms = {
        ...coreWitness.terms,
        amount: "100000",
        blinding: "0x434f4e464c494354",
        refundLocktime:
          Math.max(
            rpc("getblock", [baseTip, 1]).time,
            Math.floor(Date.now() / 1000)
          ) + 3600,
      }
      profile = encodeProfile(terms, `0x${key}`)
      const tweak = BigInt(
        toHex(
          tagged(
            "TapTweak",
            Buffer.concat([fromHex(NUMS), fromHex(profile.root)])
          )
        )
      )
      assert(tweak < secp.CURVE.n)
      const internal = secp.Point.fromHex(`02${unhex(NUMS)}`)
      const output =
        tweak === 0n ? internal : internal.add(secp.Point.BASE.multiply(tweak))
      assert(!output.equals(secp.Point.ZERO))
      const parity = Number(output.y & 1n)
      const depositKey = output.toHex(true).slice(2)
      const descriptor = rpc("getdescriptorinfo", [`rawtr(${depositKey})`])
      const address = rpc("deriveaddresses", [descriptor.descriptor])[0]
      const fundingId = rpc("sendtoaddress", [address, 0.001])
      const minerDescriptor = rpc("getdescriptorinfo", [`rawtr(${key})`])
      const miner = rpc("deriveaddresses", [minerDescriptor.descriptor])[0]
      rpc("setmocktime", [rpc("getblock", [baseTip, 1]).time + 600])
      const fundingBlock = rpc("generatetoaddress", [1, miner])[0]
      const fundingRaw = rpc("getrawtransaction", [
        fundingId,
        false,
        fundingBlock,
      ])
      const decoded = rpc("decoderawtransaction", [fundingRaw])
      const depositScript = `5120${depositKey}`
      const depositOutput = decoded.vout.find(
        (o: any) => o.scriptPubKey.hex === depositScript
      )
      assert(depositOutput && Math.round(depositOutput.value * 1e8) === 100000)
      funding = {
        txid: fundingId,
        txHash: toHex(reverse(fundingId)),
        index: depositOutput.n,
        raw: fundingRaw,
        transaction: digest(fundingRaw),
        proof: proofFor(fundingId, fundingBlock),
      }
      const wireInput = (hash: string, index: number) =>
        Buffer.concat([
          Buffer.from(unhex(hash), "hex"),
          unsigned(index, 4, true),
          Buffer.from([0]),
          unsigned(0xfffffffd, 4, true),
        ])
      const inputVector = Buffer.concat([
        compact(2),
        wireInput(input.txHash, input.txOutputIndex),
        wireInput(funding.txHash, funding.index),
      ])
      const outputVector = Buffer.concat([
        compact(1),
        unsigned(inputValue + 99000, 8, true),
        compact(34),
        prevScript,
      ])
      const unsignedRaw = Buffer.concat([
        Buffer.from("02000000", "hex"),
        inputVector,
        outputVector,
        Buffer.alloc(4),
      ]).toString("hex")
      const prevouts = [
        { value: inputValue, script: prevScript.toString("hex") },
        { value: 100000, script: depositScript },
      ]
      const mainDigest = digest(unsignedRaw, { prevouts, inputIndex: 0 })
      const depositDigest = digest(unsignedRaw, {
        prevouts,
        inputIndex: 1,
        leaf: unhex(profile.walletLeaf),
      })
      assert.equal(mainDigest.spendType, "key-path")
      assert.equal(depositDigest.spendType, "script-path")
      const mainSignature = Buffer.from(
        await secp.schnorr.sign(mainDigest.digest, secret, new Uint8Array(32))
      )
      const depositSignature = Buffer.from(
        await secp.schnorr.sign(
          depositDigest.digest,
          secret,
          new Uint8Array(32)
        )
      )
      assert(await secp.schnorr.verify(mainSignature, mainDigest.digest, key))
      assert(
        await secp.schnorr.verify(depositSignature, depositDigest.digest, key)
      )
      const control = fromHex(
        parity === 0 ? profile.walletControlEven : profile.walletControlOdd
      )
      const witness = (items: Buffer[]) =>
        Buffer.concat([
          compact(items.length),
          ...items.map((x) => Buffer.concat([compact(x.length), x])),
        ])
      raw = Buffer.concat([
        Buffer.from("020000000001", "hex"),
        inputVector,
        outputVector,
        witness([mainSignature]),
        witness([depositSignature, fromHex(profile.walletLeaf), control]),
        Buffer.alloc(4),
      ]).toString("hex")
      computed = digest(raw)
      assert.equal(computed.strippedHex, unsignedRaw)
    } else {
      raw = prepared.raw
      computed = digest(raw)
      funding = prepared.funding
      terms = prepared.terms
      profile = prepared.profile
      assert.equal(
        computed.txidRPC,
        prepared.txid,
        "mine the exact pre-reservation signed transaction"
      )
      const decoded = rpc("decoderawtransaction", [raw])
      assert.equal(decoded.vin.length, 2)
      assert.equal(decoded.vin[0].txid, inputTxid)
      assert.equal(decoded.vin[1].txid, funding.txid)
      assert.equal(decoded.vin[1].vout, funding.index)
    }
    const mempool = rpc("testmempoolaccept", [[raw]])[0]
    assert.equal(mempool.allowed, true, JSON.stringify(mempool))
    if (!prepared) {
      const result = {
        scope:
          "Actual Core main key-path plus deposit wallet-leaf; known scalar3, no threshold qualification",
        raw,
        txid: computed.txidRPC,
        txHash: toHex(reverse(computed.txidRPC)),
        transaction: computed,
        dataDirectory,
        terms,
        profile,
        funding,
        mempool,
        commands,
        productionQualification: false,
      }
      fs.writeFileSync(
        path.join(outputDirectory, "prepared-sweep.json"),
        JSON.stringify(result, null, 2)
      )
      return result
    }
    const settlementTxid = rpc("sendrawtransaction", [raw])
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
    if (options.competingRaw) {
      const competing = rpc("decoderawtransaction", [options.competingRaw])
      assert(
        competing.vin.some(
          (vin: any) =>
            vin.txid === inputTxid && vin.vout === input.txOutputIndex
        )
      )
      const rejection = rpc("testmempoolaccept", [[options.competingRaw]])[0]
      assert.equal(rejection.allowed, false, JSON.stringify(rejection))
    }
    const result = {
      scope:
        "Identical pre-reservation Core-admitted sweep mined after EVM reservation; known scalar3/regtest only",
      raw,
      txid: settlementTxid,
      txHash: toHex(reverse(settlementTxid)),
      transaction: computed,
      dataDirectory,
      terms,
      profile,
      funding,
      mempool,
      blockHash,
      proof,
      commands,
      productionQualification: false,
    }
    fs.writeFileSync(
      path.join(outputDirectory, "core-conflicting-sweep.json"),
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
export default runCoreConflictingSweep
