/* eslint-disable no-await-in-loop, no-restricted-syntax, no-bitwise */
// D08 piece 1 only: real Core legacy deposit/sweep with public test scalar 3.
// Registry callbacks, Bank credit, signed redemption and upgrade are later pieces.
// Bounded RPC/process and Merkle/coinbase builders follow frost-bitcoin.ts;
// existing helpers are neither edited nor invoked with changed semantics.
import { execFileSync, spawn } from "child_process"
import { createHash } from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import assert from "assert"
import * as secp from "@noble/secp256k1"
import * as bech32 from "bech32"
import {
  BigNumber,
  Contract,
  ContractFactory,
  ContractInterface,
  utils,
} from "ethers"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import {
  prepareEvidenceDirectory,
  reserveCorePort,
  trackCore,
  reapCore,
  copyStoppedCoreTemplate,
} from "./frost-test-isolation"
import { compact, unsigned } from "../data/frost/deposit-profile"
import { CORE, CORE_SHA } from "./frost-core-binary"

const sha = (b: Buffer) => createHash("sha256").update(b).digest()
const hash256 = (b: Buffer) => sha(sha(b))
const hex = (b: Buffer) => `0x${b.toString("hex")}`
const reverse = (s: string) => Buffer.from(s, "hex").reverse()
const hash160 = (b: Buffer) => createHash("ripemd160").update(sha(b)).digest()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
type Input = { txid: string; index: number; value: number }
type Transaction = {
  version: string
  inputVector: string
  outputVector: string
  locktime: string
  strippedHex: string
  txidRPC: string
}
type Admission = {
  allowed: boolean
  "reject-reason"?: string
  "reject-details"?: string
}
type CoreTx = {
  vout: { n: number; value: number; scriptPubKey: { hex: string } }[]
}
type Proof = {
  merkleProof: string
  txIndexInBlock: number
  bitcoinHeaders: string
  coinbasePreimage: string
  coinbaseProof: string
  coreMerkleBlock: string
  coreVerifiedTxids: string[]
  relayQualification: string
}
type Options = {
  depositor: string
  refundLocktime?: number
  depositAmount?: number
  digestBinary?: string
}
type LegacyWitness = {
  scope: string
  productionQualification: false
  coreVersion: string
  coreExecutableSha256: string
  dataDirectory: string
  bitcoinGenesis: string
  wallet: {
    compressedPublicKey: string
    publicKeyX: string
    publicKeyY: string
    pubKeyHash: string
    ecdsaWalletId: string
    knownScalar: number
  }
  reveal: {
    fundingOutputIndex: number
    blindingFactor: string
    walletPubKeyHash: string
    refundPubKeyHash: string
    refundLocktime: string
    vault: string
  }
  witnessScript: string
  depositScript: string
  mainScript: string
  refundTimestamp: number
  funding: {
    txid: string
    blockHash: string
    raw: string
    transaction: Transaction
    proof: Proof
  }
  sweep: {
    input: Input
    raw: string
    unsignedRaw: string
    transaction: Transaction
    txid: string
    blockHash: string
    proof: Proof
    mempool: Admission
    missingSignature: Admission
    digest: string
    signature: string
    value: number
    fee: number
  }
  mainUTXO: { txHash: string; txOutputIndex: number; txOutputValue: number }
  limits: {
    outerSeconds: number
    rpcProcessSeconds: number
    rpcClientSeconds: number
    localOnly: true
  }
}

function spend(
  input: Input,
  destination: Buffer,
  amount: number,
  witness?: Buffer[]
) {
  const vin = Buffer.concat([
    compact(1),
    reverse(input.txid),
    unsigned(input.index, 4, true),
    Buffer.from("00fdffffff", "hex"),
  ])
  const vout = Buffer.concat([
    compact(1),
    unsigned(amount, 8, true),
    compact(destination.length),
    destination,
  ])
  return Buffer.concat([
    unsigned(2, 4, true),
    ...(witness ? [Buffer.from("0001", "hex")] : []),
    vin,
    vout,
    ...(witness
      ? [
          compact(witness.length),
          ...witness.flatMap((item) => [compact(item.length), item]),
        ]
      : []),
    unsigned(0, 4, true),
  ]).toString("hex")
}

/// Exact regular Deposit.sol template, no extra-data branch. The timestamp's
/// four-byte positive ScriptNum profile intentionally stops at the sign boundary.
export function legacyDepositScript(options: Options): {
  witnessScript: Buffer
  refundTimestamp: number
  walletPublicKey: Buffer
  refundPublicKey: Buffer
} {
  assert(
    /^0x[0-9a-fA-F]{40}$/.test(options.depositor),
    "20-byte depositor required"
  )
  const refundTimestamp =
    options.refundLocktime ?? Math.floor(Date.now() / 1000) + 16 * 86400
  assert(
    Number.isInteger(refundTimestamp) &&
      refundTimestamp >= 500000000 &&
      refundTimestamp <= 0x7fffffff,
    "positive four-byte Unix ScriptNum required"
  )
  const amount = options.depositAmount ?? 100000
  assert(
    Number.isSafeInteger(amount) &&
      amount >= 3000 &&
      amount <= 2100000000000000,
    "safe deposit satoshi amount required"
  )
  const walletPublicKey = Buffer.from(
    secp.getPublicKey("3".padStart(64, "0"), true)
  )
  const refundPublicKey = Buffer.from(
    secp.getPublicKey("1".padStart(64, "0"), true)
  )
  const witnessScript = Buffer.concat([
    Buffer.from(
      `14${options.depositor.slice(2)}750801020304050607087576a914`,
      "hex"
    ),
    hash160(walletPublicKey),
    Buffer.from("8763ac6776a914", "hex"),
    hash160(refundPublicKey),
    Buffer.from("8804", "hex"),
    unsigned(refundTimestamp, 4, true),
    Buffer.from("b175ac68", "hex"),
  ])
  return { witnessScript, refundTimestamp, walletPublicKey, refundPublicKey }
}

export async function runLegacyCoreWitness(
  outputDirectory: string,
  options: Options
): Promise<LegacyWitness> {
  const { witnessScript, refundTimestamp, walletPublicKey, refundPublicKey } =
    legacyDepositScript(options)
  const amount = options.depositAmount ?? 100000
  const sweepValue = amount - 1000
  const satoshis = BigInt(amount)
  const bitcoinAmount = `${satoshis / 100000000n}.${(satoshis % 100000000n)
    .toString()
    .padStart(8, "0")}`
  const digestBinary =
    options.digestBinary ||
    process.env.FROST_C04_DIGEST_BINARY ||
    "/private/tmp/c04-public-funding-20261014/frost-digest"
  assert.equal(
    sha(fs.readFileSync(path.join(CORE, "bitcoind"))).toString("hex"),
    CORE_SHA
  )
  prepareEvidenceDirectory(outputDirectory)
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c04-legacy-core-")
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
  function rpc<T>(method: string, args: unknown[] = [], wallet = false): T {
    const start = Date.now()
    try {
      const text = execFileSync(
        path.join(CORE, "bitcoin-cli"),
        [
          "-regtest",
          `-datadir=${dataDirectory}`,
          `-rpcport=${port}`,
          "-rpcclienttimeout=5",
          ...(wallet ? ["-rpcwallet=legacyfixture"] : []),
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
      if (text === "") return null as T
      try {
        return JSON.parse(text) as T
      } catch {
        return text as unknown as T
      }
    } catch (error) {
      commands.push({ method, seconds: (Date.now() - start) / 1000, exit: 1 })
      throw error
    }
  }
  const parse = (raw: string): Transaction =>
    JSON.parse(
      execFileSync(digestBinary, [], {
        input: JSON.stringify({ rawTransaction: raw }),
        timeout: 10000,
      }).toString()
    ) as Transaction

  function proofFor(txid: string, blockHash: string): Proof {
    const block = rpc<{ tx: string[] }>("getblock", [blockHash, 1])
    const index = block.tx.indexOf(txid)
    assert(index > 0, "non-coinbase transaction must be in actual block")
    const leaves = block.tx.map(reverse)
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
    const header = Buffer.from(
      rpc<string>("getblockheader", [blockHash, false]),
      "hex"
    )
    assert(
      header.subarray(36, 68).equals(inclusion.root),
      "branch/header root mismatch"
    )
    const bits = header.readUInt32LE(72)
    const target = BigInt(bits & 0x007fffff) << BigInt(8 * ((bits >>> 24) - 3))
    assert(
      BigInt(`0x${Buffer.from(hash256(header)).reverse().toString("hex")}`) <=
        target,
      "actual regtest PoW"
    )
    const coinbase = parse(
      rpc<string>("getrawtransaction", [block.tx[0], false, blockHash])
    )
    assert.equal(coinbase.txidRPC, block.tx[0])
    const coreMerkleBlock = rpc<string>("gettxoutproof", [
      [txid, block.tx[0]],
      blockHash,
    ])
    const coreVerifiedTxids = rpc<string[]>("verifytxoutproof", [
      coreMerkleBlock,
    ])
    assert.deepEqual([...coreVerifiedTxids].sort(), [txid, block.tx[0]].sort())
    return {
      merkleProof: hex(inclusion.bytes),
      txIndexInBlock: index,
      bitcoinHeaders: hex(header),
      coinbasePreimage: hex(sha(Buffer.from(coinbase.strippedHex, "hex"))),
      coinbaseProof: hex(branch(0).bytes),
      coreMerkleBlock,
      coreVerifiedTxids,
      relayQualification:
        "Actual isolated Core PoW/inclusion; integer regtest difficulty zero; no production relay qualification",
    }
  }

  try {
    let ready = false
    for (let i = 0; i < 40; i++) {
      if (spawnError) throw spawnError
      if (node.exitCode !== null) throw Error(`Core exited: ${node.exitCode}`)
      try {
        rpc("getblockchaininfo")
        ready = true
        break
      } catch {
        await sleep(250)
      }
    }
    assert(ready, "Core bounded startup")
    rpc("createwallet", ["legacyfixture"])
    const miner = rpc<string>("getnewaddress", [], true)
    for (let remaining = 101; remaining > 0; remaining -= 10)
      rpc("generatetoaddress", [Math.min(10, remaining), miner])
    const depositScript = Buffer.concat([
      Buffer.from("0020", "hex"),
      sha(witnessScript),
    ])
    const address = bech32.encode("bcrt", [
      0,
      ...bech32.toWords(sha(witnessScript)),
    ])
    const txid = rpc<string>("sendtoaddress", [address, bitcoinAmount], true)
    const fundingBlock = rpc<string[]>("generatetoaddress", [1, miner])[0]
    const fundingTx = rpc<CoreTx>("getrawtransaction", [
      txid,
      true,
      fundingBlock,
    ])
    const fundingOutput = fundingTx.vout.find(
      (vout) => vout.scriptPubKey.hex === depositScript.toString("hex")
    )
    assert(
      fundingOutput && Math.round(fundingOutput.value * 100000000) === amount,
      "exact P2WSH funding"
    )
    const input = { txid, index: fundingOutput.n, value: amount }
    const mainScript = Buffer.concat([
      Buffer.from("0014", "hex"),
      hash160(walletPublicKey),
    ])
    const outpoint = Buffer.concat([
      reverse(txid),
      unsigned(input.index, 4, true),
    ])
    const sequence = Buffer.from("fdffffff", "hex")
    const output = Buffer.concat([
      unsigned(sweepValue, 8, true),
      compact(mainScript.length),
      mainScript,
    ])
    // BIP143 SIGHASH_ALL for exactly one P2WSH input. ScriptCode is the complete
    // legacy witness script; no OP_CODESEPARATOR exists in this supported profile.
    const sighash = hash256(
      Buffer.concat([
        unsigned(2, 4, true),
        hash256(outpoint),
        hash256(sequence),
        outpoint,
        compact(witnessScript.length),
        witnessScript,
        unsigned(amount, 8, true),
        sequence,
        hash256(output),
        unsigned(0, 4, true),
        unsigned(1, 4, true),
      ])
    )
    const der = Buffer.from(
      await secp.sign(sighash, "3".padStart(64, "0"), {
        der: true,
        canonical: true,
      })
    )
    assert(
      secp.verify(der, sighash, walletPublicKey),
      "independent ECDSA signature check"
    )
    const signature = Buffer.concat([der, Buffer.from([1])])
    const unsignedRaw = spend(input, mainScript, sweepValue)
    const missing = spend(input, mainScript, sweepValue, [
      Buffer.alloc(0),
      walletPublicKey,
      witnessScript,
    ])
    const missingSignature = rpc<Admission[]>("testmempoolaccept", [
      [missing],
    ])[0]
    assert.equal(
      missingSignature.allowed,
      false,
      "wallet branch must require a signature"
    )
    const raw = spend(input, mainScript, sweepValue, [
      signature,
      walletPublicKey,
      witnessScript,
    ])
    const transaction = parse(raw)
    assert.equal(
      transaction.strippedHex,
      unsignedRaw,
      "witness cannot alter frozen transaction"
    )
    const mempool = rpc<Admission[]>("testmempoolaccept", [[raw]])[0]
    assert.equal(mempool.allowed, true, JSON.stringify(mempool))
    const sweepTxid = rpc<string>("sendrawtransaction", [raw])
    assert.equal(sweepTxid, transaction.txidRPC)
    const sweepBlock = rpc<string[]>("generatetoaddress", [1, miner])[0]
    assert.equal(rpc("gettxout", [txid, input.index]), null, "deposit consumed")
    const actualMain = rpc<{ value: number; scriptPubKey: { hex: string } }>(
      "gettxout",
      [sweepTxid, 0]
    )
    assert.equal(Math.round(actualMain.value * 100000000), sweepValue)
    assert.equal(actualMain.scriptPubKey.hex, mainScript.toString("hex"))
    const fullKey = Buffer.from(secp.getPublicKey("3".padStart(64, "0"), false))
    const fundingRaw = rpc<string>("getrawtransaction", [
      txid,
      false,
      fundingBlock,
    ])
    const result: LegacyWitness = {
      scope:
        "D08 legacy Core origin piece only: known ECDSA key, future controlled registry root; no actual registration, Bank credit, redemption, upgrade or production qualification",
      productionQualification: false,
      coreVersion: rpc<{ subversion: string }>("getnetworkinfo").subversion,
      coreExecutableSha256: CORE_SHA,
      dataDirectory,
      bitcoinGenesis: hex(reverse(rpc<string>("getblockhash", [0]))),
      wallet: {
        compressedPublicKey: hex(walletPublicKey),
        publicKeyX: hex(fullKey.subarray(1, 33)),
        publicKeyY: hex(fullKey.subarray(33)),
        pubKeyHash: hex(hash160(walletPublicKey)),
        ecdsaWalletId: utils.keccak256(fullKey.subarray(1)),
        knownScalar: 3,
      },
      reveal: {
        fundingOutputIndex: input.index,
        blindingFactor: "0x0102030405060708",
        walletPubKeyHash: hex(hash160(walletPublicKey)),
        refundPubKeyHash: hex(hash160(refundPublicKey)),
        refundLocktime: hex(unsigned(refundTimestamp, 4, true)),
        vault: utils.getAddress("0x0000000000000000000000000000000000000000"),
      },
      witnessScript: hex(witnessScript),
      depositScript: hex(depositScript),
      mainScript: hex(mainScript),
      refundTimestamp,
      funding: {
        txid,
        blockHash: fundingBlock,
        raw: fundingRaw,
        transaction: parse(fundingRaw),
        proof: proofFor(txid, fundingBlock),
      },
      sweep: {
        input,
        raw,
        unsignedRaw,
        transaction,
        txid: sweepTxid,
        blockHash: sweepBlock,
        proof: proofFor(sweepTxid, sweepBlock),
        mempool,
        missingSignature,
        digest: hex(sighash),
        signature: hex(signature),
        value: sweepValue,
        fee: 1000,
      },
      mainUTXO: {
        txHash: hex(reverse(sweepTxid)),
        txOutputIndex: 0,
        txOutputValue: sweepValue,
      },
      limits: {
        outerSeconds: 180,
        rpcProcessSeconds: 10,
        rpcClientSeconds: 5,
        localOnly: true,
      },
    }
    fs.writeFileSync(
      path.join(outputDirectory, "legacy-core-witness.json"),
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
    fs.writeFileSync(
      path.join(outputDirectory, "process-result.json"),
      `${JSON.stringify({
        stopped: node.exitCode !== null || node.signalCode !== null,
        exitCode: node.exitCode,
        signal: node.signalCode,
      })}\n`
    )
  }
}

type ArtifactRecord = {
  abi: ContractInterface
  bytecode: string
  deployedBytecode: string
  linkReferences: Record<
    string,
    Record<string, { start: number; length: number }[]>
  >
}
type PublicLegacyOrigin = {
  bridge: Contract
  bank: Contract
  implementation: Contract
  admin: Contract
  registry: Contract
  relay: Contract
  watchtower: Contract
  governance: SignerWithAddress
  depositor: SignerWithAddress
  treasury: SignerWithAddress
  maintainer: SignerWithAddress
  guardian: SignerWithAddress
  witness: LegacyWitness
  requestKey: string
  recipientScript: string
  depositKey: string
  baselineTimeout: BigNumber
  deadline: BigNumber
  watchtowerDelay: BigNumber
  baselineBuild: string
  baselineSourceHashes: { path: string; sha256: string }[]
  currentRevision: string
  deployCurrent: () => Promise<Contract>
}

// Public pre-upgrade precursor only. The 76f7905 implementation and ALL of its
// local compiled inputs are pinned; current artifacts supply fixture/watchtower/
// proxy wrappers only. No Bank or Bridge storage seeding is exposed.
export async function publicLegacyOriginFixture(
  evidenceDirectory: string
): Promise<PublicLegacyOrigin> {
  prepareEvidenceDirectory(evidenceDirectory)
  const { artifacts, ethers } = await import("hardhat")
  const baselineBuild =
    process.env.FROST_C04_LEGACY_BASELINE_BUILD ||
    "/private/tmp/c05-baseline-layout-20261014/build"
  // Bind to this checkout's committed sources by default. The upgraded runtime
  // must equal HEAD exactly, so uncommitted production edits refuse.
  const repository =
    process.env.FROST_C04_LEGACY_SOURCE_ROOT ||
    path.resolve(__dirname, "../../..")
  const currentRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    timeout: 10000,
  })
    .toString()
    .trim()
  const bridgeArtifactPath = path.join(
    baselineBuild,
    "contracts/bridge/Bridge.sol/Bridge.json"
  )
  const debug = JSON.parse(
    fs.readFileSync(bridgeArtifactPath.replace(/\.json$/, ".dbg.json"), "utf8")
  ) as { buildInfo: string }
  const buildInfo = JSON.parse(
    fs.readFileSync(
      path.resolve(path.dirname(bridgeArtifactPath), debug.buildInfo),
      "utf8"
    )
  ) as {
    solcVersion: string
    input: { sources: Record<string, { content: string }> }
    output: {
      contracts: Record<
        string,
        Record<
          string,
          {
            evm: {
              bytecode: { object: string }
              deployedBytecode: { object: string }
            }
          }
        >
      >
    }
  }
  assert.equal(buildInfo.solcVersion, "0.8.17")
  const baselineSourceHashes = Object.entries(buildInfo.input.sources)
    .filter(([name]) => name.startsWith("contracts/"))
    .map(([name, source]) => {
      const pinned = execFileSync("git", ["show", `76f7905:solidity/${name}`], {
        cwd: repository,
        timeout: 10000,
      }).toString()
      assert.equal(
        source.content,
        pinned,
        `baseline source must be 76f7905: ${name}`
      )
      return { path: name, sha256: sha(Buffer.from(pinned)).toString("hex") }
    })
  const [
    governance,
    depositor,
    treasury,
    maintainer,
    manager,
    guardian,
    guardian2,
    guardian3,
  ] = await ethers.getSigners()
  const cache = new Map<string, Contract>()
  const runtimeSizes: {
    name: string
    baseline: boolean
    address: string
    bytes: number
    runtimeHash: string
  }[] = []
  async function deploy(
    name: string,
    args: unknown[] = [],
    baseline = false
  ): Promise<Contract> {
    let artifact: ArtifactRecord
    if (baseline) {
      const [source, contract] = name.split(":")
      assert(source && contract, "baseline deployment requires qualified name")
      artifact = JSON.parse(
        fs.readFileSync(
          path.join(baselineBuild, source, `${contract}.json`),
          "utf8"
        )
      ) as ArtifactRecord
      const compiled = buildInfo.output.contracts[source][contract]
      assert.equal(artifact.bytecode, `0x${compiled.evm.bytecode.object}`)
      assert.equal(
        artifact.deployedBytecode,
        `0x${compiled.evm.deployedBytecode.object}`
      )
    } else {
      artifact = await artifacts.readArtifact(name)
      if (name.includes(":")) {
        const currentBuild = await artifacts.getBuildInfo(name)
        assert(currentBuild, `compiled artifact binding: ${name}`)
        const [source, contract] = name.split(":")
        const compiled = currentBuild.output.contracts[source][contract]
        assert.equal(artifact.bytecode, `0x${compiled.evm.bytecode.object}`)
        assert.equal(
          artifact.deployedBytecode,
          `0x${compiled.evm.deployedBytecode.object}`
        )
      }
    }
    assert(
      (artifact.deployedBytecode.length - 2) / 2 <= 24576,
      `runtime limit: ${name}`
    )
    let { bytecode } = artifact
    for (const [source, libraries] of Object.entries(artifact.linkReferences)) {
      for (const [library, positions] of Object.entries(libraries)) {
        const key = `${baseline ? "baseline" : "current"}:${source}:${library}`
        if (!cache.has(key))
          cache.set(key, await deploy(`${source}:${library}`, [], baseline))
        const dependency = cache.get(key)
        assert(dependency)
        for (const position of positions)
          bytecode =
            bytecode.slice(0, 2 + position.start * 2) +
            dependency.address.slice(2) +
            bytecode.slice(2 + (position.start + position.length) * 2)
      }
    }
    const contract = await new ContractFactory(
      artifact.abi,
      bytecode,
      governance
    ).deploy(...args)
    await contract.deployed()
    const runtime = await ethers.provider.getCode(contract.address)
    assert((runtime.length - 2) / 2 <= 24576)
    runtimeSizes.push({
      name,
      baseline,
      address: contract.address,
      bytes: (runtime.length - 2) / 2,
      runtimeHash: utils.keccak256(runtime),
    })
    return contract
  }
  const bank = await deploy("contracts/bank/Bank.sol:Bank", [], true)
  const registry = await deploy("FrostLegacyOriginRegistryFixture")
  const relay = await deploy("FrostLegacyOriginRegtestRelay")
  const implementation = await deploy(
    "contracts/bridge/Bridge.sol:Bridge",
    [],
    true
  )
  const admin = await deploy("ProxyAdmin")
  const initialization = implementation.interface.encodeFunctionData(
    "initialize",
    [
      bank.address,
      relay.address,
      treasury.address,
      registry.address,
      governance.address,
      1,
    ]
  )
  const proxy = await deploy("TransparentUpgradeableProxy", [
    implementation.address,
    admin.address,
    initialization,
  ])
  const bridge = implementation.attach(proxy.address)
  await registry.bindWalletOwner(bridge.address)
  await bank.updateBridge(bridge.address)
  await bridge.setSpvMaintainerStatus(maintainer.address, true)
  // All local numerical settings precede obligations. Preserve the baseline
  // timeout exactly; never install the FROST test profile's 3600-second timeout.
  const originalRedemption = Array.from(await bridge.redemptionParameters())
  const baselineTimeout = BigNumber.from(originalRedemption[4])
  await bridge.updateDepositParameters(3000, 100, 2000, 30)
  const movement = Array.from(await bridge.movingFundsParameters())
  movement[1] = 500
  await bridge.updateMovingFundsParameters(...movement)
  await bridge.updateRedemptionParameters(
    3000,
    100,
    2000,
    2000,
    originalRedemption[4],
    originalRedemption[5],
    originalRedemption[6]
  )
  const watchtowerImplementation = await deploy("RedemptionWatchtower")
  const watchtowerInitialization =
    watchtowerImplementation.interface.encodeFunctionData("initialize", [
      bridge.address,
    ])
  const watchtowerProxy = await deploy("TransparentUpgradeableProxy", [
    watchtowerImplementation.address,
    admin.address,
    watchtowerInitialization,
  ])
  const watchtower = watchtowerImplementation.attach(watchtowerProxy.address)
  await watchtower.enableWatchtower(manager.address, [
    guardian.address,
    guardian2.address,
    guardian3.address,
  ])
  await bridge.setRedemptionWatchtower(watchtower.address)
  const witness = await runLegacyCoreWitness(
    path.join(evidenceDirectory, "core"),
    {
      depositor: depositor.address,
      refundLocktime:
        Math.max(
          (
            await ethers.provider.getBlock("latest")
          ).timestamp,
          Math.floor(Date.now() / 1000)
        ) +
        16 * 86400,
    }
  )
  const emptyMain = {
    txHash: utils.hexZeroPad("0x00", 32),
    txOutputIndex: 0,
    txOutputValue: 0,
  }
  await bridge.requestNewWallet(emptyMain)
  await registry.publish(
    witness.wallet.ecdsaWalletId,
    witness.wallet.publicKeyX,
    witness.wallet.publicKeyY
  )
  assert.equal((await bridge.wallets(witness.wallet.pubKeyHash)).state, 1)
  assert.equal((await bank.balanceOf(depositor.address)).toString(), "0")
  await bridge
    .connect(depositor)
    .revealDeposit(witness.funding.transaction, witness.reveal)
  assert.equal(
    (await bank.balanceOf(depositor.address)).toString(),
    "0",
    "reveal cannot create Bank credit"
  )
  await bridge
    .connect(maintainer)
    .submitDepositSweepProof(
      witness.sweep.transaction,
      witness.sweep.proof,
      emptyMain,
      utils.getAddress("0x0000000000000000000000000000000000000000")
    )
  assert.equal((await bank.balanceOf(depositor.address)).toString(), "98000")
  assert.equal((await bank.balanceOf(treasury.address)).toString(), "1000")
  const depositKey = utils.solidityKeccak256(
    ["bytes32", "uint32"],
    [
      `0x${Buffer.from(witness.funding.txid, "hex").reverse().toString("hex")}`,
      witness.reveal.fundingOutputIndex,
    ]
  )
  const recipientScript = `0x160014${witness.reveal.refundPubKeyHash.slice(2)}`
  await bank.connect(depositor).approveBalance(bridge.address, 20000)
  await bridge
    .connect(depositor)
    .requestRedemption(
      witness.wallet.pubKeyHash,
      witness.mainUTXO,
      recipientScript,
      20000
    )
  const requestKey = utils.solidityKeccak256(
    ["bytes32", "bytes20"],
    [utils.keccak256(recipientScript), witness.wallet.pubKeyHash]
  )
  // Preserve a nonempty legacy watchtower record across the later upgrade.
  await watchtower
    .connect(guardian)
    .raiseObjection(witness.wallet.pubKeyHash, recipientScript)
  const pending = await bridge.pendingRedemptions(requestKey)
  const deadline = BigNumber.from(pending.requestedAt).add(baselineTimeout)
  const watchtowerDelay = BigNumber.from(
    await watchtower.getRedemptionDelay(requestKey)
  )
  assert(
    watchtowerDelay.lt(baselineTimeout),
    "watchtower maturity precedes accrued legacy deadline"
  )
  prepareEvidenceDirectory(evidenceDirectory)
  fs.writeFileSync(
    path.join(evidenceDirectory, "public-legacy-origin.json"),
    `${JSON.stringify(
      {
        scope:
          "Public 76f7905 legacy callback/reveal/Core-SPV/Bank/request precursor; controlled registry, known scalar 3, zero integer regtest relay difficulty; not threshold or completed D08 qualification",
        productionQualification: false,
        baselineRevision: "76f7905",
        baselineSourceHashes,
        baselineBuild,
        bridge: bridge.address,
        bank: bank.address,
        implementation: implementation.address,
        admin: admin.address,
        registry: registry.address,
        relay: relay.address,
        watchtower: watchtower.address,
        depositor: depositor.address,
        treasury: treasury.address,
        requestKey,
        recipientScript,
        wallet: witness.wallet,
        mainUTXO: witness.mainUTXO,
        depositKey,
        capturedRequest: pending,
        baselineTimeout: baselineTimeout.toString(),
        accruedDeadline: deadline.toString(),
        watchtowerDelay: watchtowerDelay.toString(),
        vetoProposal: await watchtower.vetoProposals(requestKey),
        inventoryStatus:
          "pending original payment; no signed redemption or fulfilled disposition yet",
        runtimeSizes,
      },
      null,
      2
    )}\n`
  )
  return {
    bridge,
    bank,
    implementation,
    admin,
    registry,
    relay,
    watchtower,
    governance,
    depositor,
    treasury,
    maintainer,
    guardian,
    witness,
    requestKey,
    recipientScript,
    depositKey,
    baselineTimeout,
    deadline,
    watchtowerDelay,
    baselineBuild,
    baselineSourceHashes,
    currentRevision,
    deployCurrent: async () => {
      const current = await artifacts.getBuildInfo(
        "contracts/bridge/Bridge.sol:Bridge"
      )
      assert(current)
      const hashes = Object.entries(current.input.sources)
        // Generated, gitignored re-exports of dependencies are not repository
        // sources; a full compile can place them in Bridge's build-info.
        .filter(
          ([name]) =>
            name.startsWith("contracts/") &&
            !name.startsWith("contracts/test/") &&
            !name.startsWith("contracts/hardhat-dependency-compiler/")
        )
        .map(([name, source]) => {
          const pinned = execFileSync(
            "git",
            [
              "show",
              `${currentRevision}:solidity/${name}`,
            ],
            { cwd: repository, timeout: 10000 }
          ).toString()
          assert.equal(source.content, pinned, `frozen runtime source: ${name}`)
          return {
            path: name,
            sha256: sha(Buffer.from(pinned)).toString("hex"),
          }
        })
      const upgraded = await deploy("contracts/bridge/Bridge.sol:Bridge")
      fs.writeFileSync(
        path.join(evidenceDirectory, "current-source-binding.json"),
        JSON.stringify(
          {
            revision: currentRevision,
            sourceHashes: hashes,
            runtimeSizes,
          },
          null,
          2
        )
      )
      return upgraded
    },
  }
}

// D08 local disposition: phase prepare signs/admission-checks only; mine can
// only replay the archived bytes. Both phases fork a stopped offline Core base.
type ArchivedLegacyPayment = {
  raw: string
  transaction: Transaction
  digest: string
  dataDirectory: string
  accepted: Admission
  tip: string
  height: number
  rawSha256: string
}
export async function legacyPaymentPhase(
  outputDirectory: string,
  witness: LegacyWitness,
  phase: "prepare" | "mine",
  archived?: ArchivedLegacyPayment
): Promise<{
  archive: ArchivedLegacyPayment
  proof?: Proof
  blockHash?: string
}> {
  assert.equal(
    sha(fs.readFileSync(path.join(CORE, "bitcoind"))).toString("hex"),
    CORE_SHA
  )
  prepareEvidenceDirectory(outputDirectory)
  const base =
    phase === "prepare" ? witness.dataDirectory : archived?.dataDirectory
  assert(base, "stopped Core base required")
  const dataDirectory = copyStoppedCoreTemplate(base, `c04-legacy-${phase}-`)
  const digestBinary =
    process.env.FROST_C04_DIGEST_BINARY ||
    "/private/tmp/c04-public-funding-20261014/frost-digest"
  const portLease = await reserveCorePort()
  const { port } = portLease
  const fd = fs.openSync(
    path.join(outputDirectory, `${phase}-bitcoin-core.log`),
    "w"
  )
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
  function rpc<T>(method: string, args: unknown[] = [], wallet = false): T {
    const start = Date.now()
    try {
      const text = execFileSync(
        path.join(CORE, "bitcoin-cli"),
        [
          "-regtest",
          `-datadir=${dataDirectory}`,
          `-rpcport=${port}`,
          "-rpcclienttimeout=5",
          ...(wallet ? ["-rpcwallet=legacyfixture"] : []),
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
      if (text === "") return null as T
      try {
        return JSON.parse(text) as T
      } catch {
        return text as unknown as T
      }
    } catch (error) {
      commands.push({ method, seconds: (Date.now() - start) / 1000, exit: 1 })
      throw error
    }
  }
  const parse = (raw: string): Transaction =>
    JSON.parse(
      execFileSync(digestBinary, [], {
        input: JSON.stringify({ rawTransaction: raw }),
        timeout: 10000,
      }).toString()
    ) as Transaction

  function proofFor(txid: string, blockHash: string): Proof {
    const block = rpc<{ tx: string[] }>("getblock", [blockHash, 1])
    const index = block.tx.indexOf(txid)
    assert(index > 0, "non-coinbase transaction must be in actual block")
    const leaves = block.tx.map(reverse)
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
    const header = Buffer.from(
      rpc<string>("getblockheader", [blockHash, false]),
      "hex"
    )
    assert(
      header.subarray(36, 68).equals(inclusion.root),
      "branch/header root mismatch"
    )
    const bits = header.readUInt32LE(72)
    const target = BigInt(bits & 0x007fffff) << BigInt(8 * ((bits >>> 24) - 3))
    assert(
      BigInt(`0x${Buffer.from(hash256(header)).reverse().toString("hex")}`) <=
        target,
      "actual regtest PoW"
    )
    const coinbase = parse(
      rpc<string>("getrawtransaction", [block.tx[0], false, blockHash])
    )
    assert.equal(coinbase.txidRPC, block.tx[0])
    const coreMerkleBlock = rpc<string>("gettxoutproof", [
      [txid, block.tx[0]],
      blockHash,
    ])
    const coreVerifiedTxids = rpc<string[]>("verifytxoutproof", [
      coreMerkleBlock,
    ])
    assert.deepEqual([...coreVerifiedTxids].sort(), [txid, block.tx[0]].sort())
    return {
      merkleProof: hex(inclusion.bytes),
      txIndexInBlock: index,
      bitcoinHeaders: hex(header),
      coinbasePreimage: hex(sha(Buffer.from(coinbase.strippedHex, "hex"))),
      coinbaseProof: hex(branch(0).bytes),
      coreMerkleBlock,
      coreVerifiedTxids,
      relayQualification:
        "Actual isolated Core PoW/inclusion; integer regtest difficulty zero; no production relay qualification",
    }
  }

  try {
    let ready = false
    for (let i = 0; i < 40; i++) {
      if (spawnError) throw spawnError
      if (node.exitCode !== null) throw Error(`Core exited: ${node.exitCode}`)
      try {
        rpc("getblockchaininfo")
        ready = true
        break
      } catch {
        await sleep(250)
      }
    }
    assert(ready, "Core bounded startup")

    if (phase === "prepare") {
      const outpoint = Buffer.concat([
        reverse(witness.sweep.txid),
        unsigned(0, 4, true),
      ])
      const sequence = Buffer.from("fdffffff", "hex")
      const destinations = [
        Buffer.from(`0014${witness.reveal.refundPubKeyHash.slice(2)}`, "hex"),
        Buffer.from(witness.mainScript.slice(2), "hex"),
      ]
      const outputs = Buffer.concat(
        destinations.map((script, i) =>
          Buffer.concat([
            unsigned(i === 0 ? 18800 : 79200, 8, true),
            compact(script.length),
            script,
          ])
        )
      )
      const scriptCode = Buffer.from(
        `76a914${witness.wallet.pubKeyHash.slice(2)}88ac`,
        "hex"
      )
      const digest = hash256(
        Buffer.concat([
          unsigned(2, 4, true),
          hash256(outpoint),
          hash256(sequence),
          outpoint,
          compact(scriptCode.length),
          scriptCode,
          unsigned(99000, 8, true),
          sequence,
          hash256(outputs),
          unsigned(0, 4, true),
          unsigned(1, 4, true),
        ])
      )
      const der = Buffer.from(
        await secp.sign(digest, "3".padStart(64, "0"), {
          der: true,
          canonical: true,
        })
      )
      const publicKey = Buffer.from(
        witness.wallet.compressedPublicKey.slice(2),
        "hex"
      )
      assert(secp.verify(der, digest, publicKey))
      const signature = Buffer.concat([der, Buffer.from([1])])
      const raw = Buffer.concat([
        unsigned(2, 4, true),
        Buffer.from("000101", "hex"),
        outpoint,
        Buffer.from("00", "hex"),
        sequence,
        compact(2),
        outputs,
        compact(2),
        compact(signature.length),
        signature,
        compact(publicKey.length),
        publicKey,
        unsigned(0, 4, true),
      ]).toString("hex")
      const transaction = parse(raw)
      const tip = rpc<string>("getbestblockhash")
      const height = rpc<number>("getblockcount")
      const accepted = rpc<Admission[]>("testmempoolaccept", [[raw]])[0]
      assert.equal(accepted.allowed, true, JSON.stringify(accepted))
      assert.equal(rpc<string>("getbestblockhash"), tip)
      assert.equal(rpc<number>("getblockcount"), height)
      assert.deepEqual(
        rpc<string[]>("getrawmempool"),
        [],
        "admission only; no broadcast or mining"
      )
      const archive = {
        raw,
        transaction,
        digest: hex(digest),
        dataDirectory,
        accepted,
        tip,
        height,
        rawSha256: sha(Buffer.from(raw, "hex")).toString("hex"),
      }
      fs.writeFileSync(
        path.join(outputDirectory, "signed-before-upgrade.json"),
        JSON.stringify(archive, null, 2)
      )
      return { archive }
    }
    assert(archived)
    assert.equal(
      sha(Buffer.from(archived.raw, "hex")).toString("hex"),
      archived.rawSha256
    )
    assert.equal(rpc<string>("getbestblockhash"), archived.tip)
    assert.equal(rpc<number>("getblockcount"), archived.height)
    assert.equal(
      rpc<string>("sendrawtransaction", [archived.raw]),
      archived.transaction.txidRPC
    )
    const tip = rpc<{ time: number }>("getblockheader", [archived.tip, true])
    rpc("setmocktime", [tip.time + 600])
    const miner = bech32.encode("bcrt", [
      0,
      ...bech32.toWords(Buffer.from(witness.wallet.pubKeyHash.slice(2), "hex")),
    ])
    const blockHash = rpc<string[]>("generatetoaddress", [1, miner])[0]
    assert.equal(
      rpc<string>("getrawtransaction", [
        archived.transaction.txidRPC,
        false,
        blockHash,
      ]),
      archived.raw
    )
    assert.equal(rpc("gettxout", [witness.sweep.txid, 0]), null)
    for (const [index, value, script] of [
      [0, 18800, `0014${witness.reveal.refundPubKeyHash.slice(2)}`],
      [1, 79200, witness.mainScript.slice(2)],
    ] as const) {
      const output = rpc<{ value: number; scriptPubKey: { hex: string } }>(
        "gettxout",
        [archived.transaction.txidRPC, index]
      )
      assert.equal(Math.round(output.value * 100000000), value)
      assert.equal(output.scriptPubKey.hex, script)
    }
    const result = {
      archive: archived,
      blockHash,
      proof: proofFor(archived.transaction.txidRPC, blockHash),
    }
    fs.writeFileSync(
      path.join(outputDirectory, "mined-after-upgrade.json"),
      JSON.stringify(result, null, 2)
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
      path.join(outputDirectory, `${phase}-rpc-commands.json`),
      `${JSON.stringify(commands, null, 2)}\n`
    )
    fs.writeFileSync(
      path.join(outputDirectory, `${phase}-process-result.json`),
      `${JSON.stringify({
        stopped: node.exitCode !== null || node.signalCode !== null,
        exitCode: node.exitCode,
        signal: node.signalCode,
      })}\n`
    )
  }
}
