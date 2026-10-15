/* eslint-disable no-await-in-loop, no-restricted-syntax, no-bitwise */
// Bounded isolated Bitcoin Core regtest helper. Controlled keys are public test
// scalars; these spends establish neither threshold signing nor production funding.
import { execFileSync, spawn } from "child_process"
import { createHash } from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import assert from "assert"
import * as secp from "@noble/secp256k1"
import { utils } from "ethers"
import {
  evidenceDirectory,
  prepareEvidenceDirectory,
  reserveCorePort,
  trackCore,
  reapCore,
} from "./frost-test-isolation"
import { digestBinaryForRun } from "./frost-digest-builder"
import {
  baseTerms,
  encodeProfile,
  NUMS,
  tagged,
  fromHex,
  toHex,
  unsigned,
  compact,
  Terms,
} from "../data/frost/deposit-profile"

const CORE = "/private/tmp/k04-tools/bitcoin-29.0/bin"
const CORE_SHA =
  "f4b9d78a74643c726d022840ca506dc317d41f8825aaef80b7bb705e12c5fda8"
const sha = (b: Buffer) => createHash("sha256").update(b).digest()
const hash256 = (b: Buffer) => sha(sha(b))
const rawHex = (s: string) => s.replace(/^0x/, "")
const reverse = (s: string) => Buffer.from(s, "hex").reverse()
const word = (n: bigint) => n.toString(16).padStart(64, "0")
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Input = { txid: string; index: number; value: number }
function spend(
  input: Input,
  destination: Buffer,
  amount: number,
  locktime = 0,
  witness?: Buffer[]
) {
  const vin = Buffer.concat([
    compact(1),
    reverse(input.txid),
    unsigned(input.index, 4, true),
    Buffer.from([0]),
    unsigned(0xfffffffd, 4, true),
  ])
  const vout = Buffer.concat([
    compact(1),
    unsigned(amount, 8, true),
    compact(destination.length),
    destination,
  ])
  return Buffer.concat([
    unsigned(2, 4, true),
    ...(witness ? [Buffer.from([0, 1])] : []),
    vin,
    vout,
    ...(witness
      ? [
          compact(witness.length),
          ...witness.flatMap((item) => [compact(item.length), item]),
        ]
      : []),
    unsigned(locktime, 4, true),
  ]).toString("hex")
}

export type CoreTermsOverrides = Partial<
  Pick<
    Terms,
    | "chainId"
    | "bridge"
    | "depositor"
    | "vault"
    | "descriptorHash"
    | "refundLocktime"
  >
>

export default async function runCoreWitnessCheck(
  outputDirectory: string = evidenceDirectory(
    "core",
    process.env.FROST_C05_CORE_EVIDENCE
  ),
  digestBinary?: string,
  overrides: CoreTermsOverrides = {}
) {
  const allowed = [
    "chainId",
    "bridge",
    "depositor",
    "vault",
    "descriptorHash",
    "refundLocktime",
  ]
  for (const key of Object.keys(overrides))
    assert(allowed.includes(key), `Unsupported Terms override: ${key}`)
  prepareEvidenceDirectory(outputDirectory)
  const selectedDigestBinary = digestBinaryForRun(
    digestBinary || process.env.FROST_C05_DIGEST_BINARY
  )
  assert.equal(
    sha(fs.readFileSync(path.join(CORE, "bitcoind"))).toString("hex"),
    CORE_SHA
  )
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c05-core-witness-")
  )
  const portLease = await reserveCorePort()
  const { port } = portLease
  const logFile = path.join(outputDirectory, "bitcoin-core.log")
  const fd = fs.openSync(logFile, "w")
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
  trackCore(node)
  const nodeDeadline = setTimeout(() => node.kill("SIGTERM"), 180000)
  const commands: { method: string; seconds: number; exit: number }[] = []
  const rpc = (method: string, args: unknown[] = [], wallet = false): any => {
    const start = Date.now()
    const parameters = [
      "-regtest",
      `-datadir=${dataDirectory}`,
      `-rpcport=${port}`,
      "-rpcclienttimeout=5",
      ...(wallet ? ["-rpcwallet=c05fixture"] : []),
      method,
      ...args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))),
    ]
    try {
      const text = execFileSync(path.join(CORE, "bitcoin-cli"), parameters, {
        timeout: 10000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      })
        .toString()
        .trim()
      commands.push({ method, seconds: (Date.now() - start) / 1000, exit: 0 })
      // bitcoin-cli renders a JSON null result as empty stdout.
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
    value?: number,
    leaf?: string
  ) =>
    JSON.parse(
      execFileSync(selectedDigestBinary, [], {
        input: JSON.stringify({
          rawTransaction,
          prevScript: prevScript?.toString("hex"),
          value,
          leaf: leaf ? rawHex(leaf) : undefined,
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
    for (let i = 0; i < 40; i += 1) {
      if (node.exitCode !== null)
        throw Error(`Core exited before RPC readiness: ${node.exitCode}`)
      try {
        rpc("getblockchaininfo")
        ready = true
        break
      } catch {
        await sleep(250)
      }
    }
    assert(
      ready,
      "Core startup must complete within the bounded readiness loop"
    )
    rpc("createwallet", ["c05fixture"])
    const miner = rpc("getnewaddress", [], true)
    for (let remaining = 101; remaining > 0; remaining -= 10)
      rpc("generatetoaddress", [Math.min(10, remaining), miner])
    const now = Math.floor(Date.now() / 1000)
    const walletSecret = word(3n)
    const refundSecret = word(1n)
    const q = toHex(Buffer.from(secp.schnorr.getPublicKey(walletSecret)))
    const refundKey = toHex(
      Buffer.from(secp.schnorr.getPublicKey(refundSecret))
    )
    const terms: Terms = {
      ...baseTerms,
      ...overrides,
      bitcoinGenesis: toHex(reverse(rpc("getblockhash", [0]))),
      fullWalletId: utils.keccak256(
        utils.concat([utils.id("tbtc-v2/frost-wallet-id/v1"), q])
      ),
      descriptorHash:
        overrides.descriptorHash ||
        utils.id("controlled-core-test-descriptor-not-registered"),
      refundKey,
      refundLocktime:
        overrides.refundLocktime === undefined
          ? now + 600
          : overrides.refundLocktime,
    }
    const profile = encodeProfile(terms, q)
    const tweak = BigInt(
      toHex(
        tagged(
          "TapTweak",
          Buffer.concat([fromHex(NUMS), fromHex(profile.root)])
        )
      )
    )
    assert(tweak < secp.CURVE.n)
    const internal = secp.Point.fromHex(`02${rawHex(NUMS)}`)
    const output =
      tweak === 0n ? internal : internal.add(secp.Point.BASE.multiply(tweak))
    assert(!output.equals(secp.Point.ZERO))
    const parity = Number(output.y & 1n)
    const depositKey = word(output.x)
    const depositScript = Buffer.from(`5120${depositKey}`, "hex")
    const info = rpc("getdescriptorinfo", [`rawtr(${depositKey})`])
    const address = rpc("deriveaddresses", [info.descriptor])[0]
    const funding = [
      rpc("sendtoaddress", [address, 0.001], true),
      rpc("sendtoaddress", [address, 0.001], true),
    ]
    const fundingBlock = rpc("generatetoaddress", [1, miner])[0]
    const locate = (txid: string): Input => {
      const tx = rpc("getrawtransaction", [txid, true, fundingBlock])
      const vout = tx.vout.find(
        (item: any) => item.scriptPubKey.hex === depositScript.toString("hex")
      )
      assert(
        vout && Math.round(vout.value * 100000000) === Number(terms.amount)
      )
      return { txid, index: vout.n, value: Number(terms.amount) }
    }
    const walletInput = locate(funding[0])
    const refundInput = locate(funding[1])
    const destination = Buffer.from(`5120${rawHex(q)}`, "hex")
    const walletRaw = spend(walletInput, destination, 99000)
    const walletDigest = digest(
      walletRaw,
      depositScript,
      walletInput.value,
      profile.walletLeaf
    )
    let walletSigningEnabled = true
    let walletSignatureCalls = 0
    const signWallet = async (message: Buffer) => {
      assert(walletSigningEnabled, "wallet signing callback is offline")
      walletSignatureCalls += 1
      return Buffer.from(
        await secp.schnorr.sign(message, walletSecret, new Uint8Array(32))
      )
    }
    const walletSignature = await signWallet(
      Buffer.from(walletDigest.digest, "hex")
    )
    assert(
      await secp.schnorr.verify(walletSignature, walletDigest.digest, rawHex(q))
    )
    const walletControl = fromHex(
      parity === 0 ? profile.walletControlEven : profile.walletControlOdd
    )
    const sweep = spend(walletInput, destination, 99000, 0, [
      walletSignature,
      fromHex(profile.walletLeaf),
      walletControl,
    ])
    const walletAdmission = rpc("testmempoolaccept", [[sweep]])[0]
    assert.equal(walletAdmission.allowed, true, JSON.stringify(walletAdmission))
    const sweepId = rpc("sendrawtransaction", [sweep])
    const sweepBlock = rpc("generatetoaddress", [1, miner])[0]
    const swept = rpc("gettxout", [sweepId, 0])
    assert(swept && swept.scriptPubKey.hex === destination.toString("hex"))
    // Archive a valid competing wallet-leaf spend of the SECOND deposit before
    // disabling wallet signing. Admission is checked only; do not broadcast it.
    const walletConflictUnsigned = spend(refundInput, destination, 99000)
    const walletConflictDigest = digest(
      walletConflictUnsigned,
      depositScript,
      refundInput.value,
      profile.walletLeaf
    )
    const walletSigningEnabledAtPresign = walletSigningEnabled
    const walletConflictSignature = await signWallet(
      Buffer.from(walletConflictDigest.digest, "hex")
    )
    assert(
      await secp.schnorr.verify(
        walletConflictSignature,
        walletConflictDigest.digest,
        rawHex(q)
      )
    )
    const walletConflictRaw = spend(refundInput, destination, 99000, 0, [
      walletConflictSignature,
      fromHex(profile.walletLeaf),
      walletControl,
    ])
    const walletConflictAdmission = rpc("testmempoolaccept", [
      [walletConflictRaw],
    ])[0]
    assert.equal(
      walletConflictAdmission.allowed,
      true,
      JSON.stringify(walletConflictAdmission)
    )
    walletSigningEnabled = false
    // Capture AFTER both wallet signatures, so the independent-refund phase
    // must still have exactly zero wallet/operator signing callback invocations.
    const walletCallsBeforeRefund = walletSignatureCalls
    const refundAddress = rpc("getnewaddress", [], true)
    const refundDestination = Buffer.from(
      rpc("getaddressinfo", [refundAddress], true).scriptPubKey,
      "hex"
    )
    // Refund signing accepts only the independent refund scalar. No wallet signer
    // is called in this phase, and the witness has no wallet signature or secret.
    const refundRaw = spend(
      refundInput,
      refundDestination,
      99000,
      terms.refundLocktime
    )
    const refundDigest = digest(
      refundRaw,
      depositScript,
      refundInput.value,
      profile.refundLeaf
    )
    const refundSignature = Buffer.from(
      await secp.schnorr.sign(
        Buffer.from(refundDigest.digest, "hex"),
        refundSecret,
        new Uint8Array(32)
      )
    )
    assert(
      await secp.schnorr.verify(
        refundSignature,
        refundDigest.digest,
        rawHex(refundKey)
      )
    )
    const refundControl = fromHex(
      parity === 0 ? profile.refundControlEven : profile.refundControlOdd
    )
    const refund = spend(
      refundInput,
      refundDestination,
      99000,
      terms.refundLocktime,
      [refundSignature, fromHex(profile.refundLeaf), refundControl]
    )
    const early = rpc("testmempoolaccept", [[refund]])[0]
    assert.equal(early.allowed, false)
    assert(early["reject-reason"] === "non-final", JSON.stringify(early))
    rpc("setmocktime", [terms.refundLocktime + 100])
    rpc("generatetoaddress", [11, miner])
    assert(rpc("getblockchaininfo").mediantime > terms.refundLocktime)
    const refundAdmission = rpc("testmempoolaccept", [[refund]])[0]
    assert.equal(refundAdmission.allowed, true, JSON.stringify(refundAdmission))
    const refundId = rpc("sendrawtransaction", [refund])
    const refundBlock = rpc("generatetoaddress", [1, miner])[0]
    assert(rpc("gettxout", [refundId, 0]))
    assert.equal(rpc("gettxout", [refundInput.txid, refundInput.index]), null)
    assert.equal(walletSigningEnabled, false)
    const walletConflictRefusal = rpc("testmempoolaccept", [
      [walletConflictRaw],
    ])[0]
    assert.equal(
      walletConflictRefusal.allowed,
      false,
      JSON.stringify(walletConflictRefusal)
    )
    assert.equal(
      walletConflictRefusal["reject-reason"],
      "missing-inputs",
      JSON.stringify(walletConflictRefusal)
    )
    assert.equal(walletConflictRefusal.txid, walletConflictAdmission.txid)
    assert.equal(walletSignatureCalls - walletCallsBeforeRefund, 0)
    const result = {
      digestBinary: selectedDigestBinary,
      digestSourceBinding: fs.existsSync(
        path.join(path.dirname(selectedDigestBinary), "source-binding.json")
      )
        ? JSON.parse(
            fs.readFileSync(
              path.join(
                path.dirname(selectedDigestBinary),
                "source-binding.json"
              ),
              "utf8"
            )
          )
        : {
            explicitOverride: true,
            sourceMatched: false,
            schemaVerified: true,
          },
      scope:
        "Actual isolated Core script-path spends with known single test keys; no threshold ceremony, registered production descriptor, Bank credit or release gate",
      coreVersion: rpc("getnetworkinfo").subversion,
      coreExecutableSha256: CORE_SHA,
      dataDirectory,
      terms,
      walletKey: q,
      depositKey: `0x${depositKey}`,
      parity,
      depositScript: toHex(depositScript),
      profile,
      funding: funding.map((txid: string) => ({
        txid,
        blockHash: fundingBlock,
        raw: rpc("getrawtransaction", [txid, false, fundingBlock]),
        transaction: digest(
          rpc("getrawtransaction", [txid, false, fundingBlock])
        ),
        proof: proofFor(txid, fundingBlock),
      })),
      sweep: {
        input: walletInput,
        raw: sweep,
        unsignedRaw: walletRaw,
        transaction: walletDigest,
        digest: walletDigest.digest,
        txid: sweepId,
        blockHash: sweepBlock,
        mempool: walletAdmission,
        proof: proofFor(sweepId, sweepBlock),
        exactQOutput: swept.scriptPubKey.hex,
      },
      refund: {
        input: refundInput,
        raw: refund,
        unsignedRaw: refundRaw,
        transaction: refundDigest,
        digest: refundDigest.digest,
        txid: refundId,
        blockHash: refundBlock,
        earlyRefusal: early,
        mempool: refundAdmission,
        proof: proofFor(refundId, refundBlock),
        walletOperatorSigningCalls:
          walletSignatureCalls - walletCallsBeforeRefund,
        walletSigningCallbackDisabled: !walletSigningEnabled,
        walletConflict: {
          scope:
            "Actual Core same-byte wallet-leaf conflict against an independently mined refund; known single test key, not threshold signing or production registration; no C-06 lifecycle cleanup claim",
          sourceFundingIndex: 1,
          sourceFundingTransaction: funding[1],
          input: refundInput,
          raw: walletConflictRaw,
          unsignedRaw: walletConflictUnsigned,
          transaction: walletConflictDigest,
          digest: walletConflictDigest.digest,
          walletLeaf: profile.walletLeaf,
          walletControl: toHex(walletControl),
          walletOutputScript: toHex(destination),
          walletSigningEnabledAtPresign,
          earlyAdmission: walletConflictAdmission,
          postRefundRefusal: walletConflictRefusal,
          walletSigningCallbackDisabled: !walletSigningEnabled,
          walletOperatorSigningCallsDuringRefund:
            walletSignatureCalls - walletCallsBeforeRefund,
        },
      },
      commands,
      limits: {
        outerSeconds: 180,
        rpcProcessSeconds: 10,
        rpcClientSeconds: 5,
        localOnly: true,
      },
    }
    fs.writeFileSync(
      path.join(outputDirectory, "core-witnesses.json"),
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
    fs.writeFileSync(
      path.join(outputDirectory, "rpc-commands.json"),
      `${JSON.stringify(commands, null, 2)}\n`
    )
  }
}

if (require.main === module) {
  const [outputDirectory, digestBinary] = process.argv.slice(2)
  runCoreWitnessCheck(outputDirectory, digestBinary)
    .then((result) => {
      process.stdout.write(
        `${JSON.stringify({
          scope: result.scope,
          sweep: result.sweep.txid,
          refund: result.refund.txid,
          refundOperatorSigningCalls: 0,
        })}\n`
      )
    })
    .catch((error) => {
      process.stderr.write(`${error.stack || error}\n`)
      process.exitCode = 1
    })
}
