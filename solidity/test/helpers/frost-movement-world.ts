/* eslint-disable no-await-in-loop, no-restricted-syntax, no-bitwise */
// C-06 component world: the real Bridge proxy, linked FROST libraries, Bank,
// verifier and registry callbacks. Wallets are funded by real reveals and
// deposit sweep proofs. Inclusion proofs are synthetic two-leaf regtest
// blocks (accounting only, not Bitcoin spend validity or chain work).
// Lifecycle entry to MovingFunds is C-09; until then it is a controlled
// storage marker, written together with the eligibility counter it implies.
import { artifacts, ethers, network } from "hardhat"
import { expect } from "chai"
import { createHash } from "crypto"

export const ZERO = ethers.constants.HashZero
export const State = {
  Unknown: 0,
  Candidate: 1,
  RegisteredPendingReady: 2,
  ReadyUnfunded: 3,
  Live: 4,
  MovingFunds: 5,
  Closing: 6,
  Closed: 7,
  Terminated: 8,
}
export const Incoming = { Unknown: 0, Pending: 1, Escalated: 2, Swept: 3 }

export const TYPE =
  "tuple(uint8 scheme,uint8 profile,uint256 chainId,address registry,uint64 epoch,uint32[] members,address[] operators,uint16 threshold,bytes32 snowfallDescriptor,bytes32 outputKey)"
const sha = (value: Buffer) => createHash("sha256").update(value).digest()
const sha256d = (value: Buffer) => sha(sha(value))
export const hex = (value: Buffer) => `0x${value.toString("hex")}`
export const raw = (value: string) => Buffer.from(value.slice(2), "hex")
const le = (value: number, width: number) => {
  const b = Buffer.alloc(width)
  b.writeUIntLE(value, 0, width)
  return b
}
export const outpoint = (hash: string, index = 0) =>
  ethers.utils.solidityKeccak256(["bytes32", "uint32"], [hash, index])

export async function deploy(
  name: string,
  args: unknown[] = [],
  cache = new Map<string, string>()
): Promise<any> {
  const a = await artifacts.readArtifact(name)
  expect((a.deployedBytecode.length - 2) / 2, name).to.be.at.most(24576)
  let { bytecode } = a
  for (const [source, libraries] of Object.entries(a.linkReferences)) {
    for (const [library, positions] of Object.entries(libraries)) {
      const key = `${source}:${library}`
      if (!cache.has(key))
        cache.set(key, (await deploy(key, [], cache)).address)
      const address = cache.get(key)
      if (!address) throw Error(`Missing library ${key}`)
      for (const p of positions)
        bytecode =
          bytecode.slice(0, 2 + p.start * 2) +
          address.slice(2) +
          bytecode.slice(2 + (p.start + p.length) * 2)
    }
  }
  const [signer] = await ethers.getSigners()
  const c = await new ethers.ContractFactory(a.abi, bytecode, signer).deploy(
    ...args
  )
  await c.deployed()
  return c
}

export type Output = { value: number; script: Buffer }
export const p2tr = (q: string) =>
  Buffer.concat([Buffer.from("225120", "hex"), raw(q)])
export const p2wpkh = (pkh: string) =>
  Buffer.concat([Buffer.from("160014", "hex"), raw(pkh)])

/// Version 2 transaction with empty scriptSigs; inputs are [hash, index].
export function transaction(
  inputs: [string, number][],
  outputs: Output[],
  version = "0x02000000"
) {
  const tx = {
    version,
    inputVector: hex(
      Buffer.concat([
        Buffer.from([inputs.length]),
        ...inputs.map(([hash, index]) =>
          Buffer.concat([
            raw(hash),
            le(index, 4),
            Buffer.from([0]),
            le(0xffffffff, 4),
          ])
        ),
      ])
    ),
    outputVector: hex(
      Buffer.concat([
        Buffer.from([outputs.length]),
        ...outputs.map((o) =>
          Buffer.concat([le(o.value, 6), Buffer.alloc(2), o.script])
        ),
      ])
    ),
    locktime: "0x00000000",
  }
  const hash = hex(sha256d(Buffer.concat(Object.values(tx).map(raw))))
  return { tx, hash, key: (i = 0) => outpoint(hash, i) }
}
export type Tx = ReturnType<typeof transaction>

export function inclusion(hash: string) {
  const coinbasePreimage = sha(Buffer.from(`C06 coinbase ${hash}`))
  const coinbaseHash = sha(coinbasePreimage)
  const root = sha256d(Buffer.concat([coinbaseHash, raw(hash)]))
  const header = Buffer.concat([
    le(2, 4),
    Buffer.alloc(32),
    root,
    le(1700000000, 4),
    le(0x207fffff, 4),
    le(0, 4),
  ])
  const target = ethers.BigNumber.from("0x7fffff").shl(8 * 29)
  let nonce = 0
  while (
    ethers.BigNumber.from(hex(Buffer.from(sha256d(header)).reverse())).gt(
      target
    )
  ) {
    nonce += 1
    if (nonce > 10000) throw Error("Regtest nonce search cap")
    header.writeUInt32LE(nonce, 76)
  }
  return {
    merkleProof: hex(coinbaseHash),
    txIndexInBlock: 1,
    bitcoinHeaders: hex(header),
    coinbasePreimage: hex(coinbasePreimage),
    coinbaseProof: hash,
  }
}

export type Wallet = {
  q: string
  id: string
  label: string
  descriptor: any
  descriptorHash: string
  main?: Tx
  value: number
}

export async function movementWorld(count = 4) {
  const signers = await ethers.getSigners()
  const [owner, depositor, treasury, operator] = signers
  const bank = await deploy("Bank")
  const relay = await deploy("FrostDepositRegtestRelay")
  const implementation = await deploy("Bridge")
  const admin = await deploy("ProxyAdmin")
  const legacyRegistry = await deploy("FrostDrainRegistryFixture")
  // The legacy commitment refunds gas through the pool.
  const pool = await deploy(
    "@keep-network/random-beacon/contracts/ReimbursementPool.sol:ReimbursementPool",
    [0, 0]
  )
  const init = implementation.interface.encodeFunctionData("initialize", [
    bank.address,
    relay.address,
    treasury.address,
    legacyRegistry.address,
    pool.address,
    1,
  ])
  const proxy = await deploy("TransparentUpgradeableProxy", [
    implementation.address,
    admin.address,
    init,
  ])
  const bridge = implementation.attach(proxy.address)
  const frost = await ethers.getContractAt("IFrostBridge", proxy.address)
  await legacyRegistry.bindWalletOwner(proxy.address)
  await pool.authorize(proxy.address)
  await bank.updateBridge(proxy.address)
  await bridge.setSpvMaintainerStatus(owner.address, true)
  await bridge.updateDepositParameters(10000, 100, 2000, 30)
  // Legacy moving funds parameters are shared by the FROST route.
  // txMaxTotalFee, dust, resetDelay, timeout, slashing, notifier multiplier,
  // commitment gas offset, sweep max fee, sweep timeout, sweep slashing,
  // sweep notifier multiplier.
  await bridge.updateMovingFundsParameters(
    5000,
    20000,
    3600,
    7 * 86400,
    0,
    0,
    0,
    5000,
    10 * 86400,
    0,
    0
  )
  // walletMaxBtcTransfer is 250,000 satoshi in this world.
  const walletParams = await bridge.walletParameters()
  await bridge.updateWalletParameters(
    walletParams.walletCreationPeriod,
    walletParams.walletCreationMinBtcBalance,
    walletParams.walletCreationMaxBtcBalance,
    walletParams.walletClosureMinBtcBalance,
    walletParams.walletMaxAge,
    250000,
    walletParams.walletClosingPeriod
  )
  const registry = await deploy("FrostRegistryFixture", [proxy.address])
  await frost.configureFrostRegistry(registry.address)
  const verifier = await deploy("FrostVerifier")
  const genesis = ethers.utils.id("C06 synthetic regtest domain")
  await frost.configureFrostFunding(
    verifier.address,
    ethers.utils.keccak256(await ethers.provider.getCode(verifier.address)),
    ethers.utils.id("UNQUALIFIED C06 local test"),
    genesis
  )
  await frost.setFrostFundingGates(true, true)
  const { chainId } = await ethers.provider.getNetwork()

  const wallets: Wallet[] = []
  for (let i = 0; i < count; i++) {
    const pub = ethers.utils.computePublicKey(
      ethers.utils.hexZeroPad(ethers.utils.hexlify(1000 + i), 32),
      true
    )
    const q = `0x${pub.slice(4)}`
    const descriptor = {
      scheme: 2,
      profile: 1,
      chainId,
      registry: registry.address,
      epoch: await ethers.provider.getBlockNumber(),
      members: [1, 2, 3],
      operators: [operator.address, owner.address, depositor.address],
      threshold: 2,
      snowfallDescriptor: ethers.utils.id(`C06 wallet ${i}`),
      outputKey: q,
    }
    const descriptorHash = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", TYPE],
        [ethers.utils.id("tbtc-v2/frost-descriptor/v1"), descriptor]
      )
    )
    const id = ethers.utils.keccak256(
      ethers.utils.concat([ethers.utils.id("tbtc-v2/frost-wallet-id/v1"), q])
    )
    await registry.created(
      ethers.utils.defaultAbiCoder.encode([TYPE], [descriptor]),
      (await ethers.provider.getBlockNumber()) + 100000
    )
    await registry.ready(id, descriptorHash)
    wallets.push({
      q,
      id,
      label: id.slice(0, 42),
      descriptor,
      descriptorHash,
      value: 0,
    })
  }

  const info = await artifacts.getBuildInfo(
    "contracts/bridge/Bridge.sol:Bridge"
  )
  if (!info) throw Error("Missing Bridge build info")
  const layout =
    info.output.contracts["contracts/bridge/Bridge.sol"].Bridge.storageLayout
  const self = layout.storage.find((s: any) => s.label === "self")
  const child = (node: any, name: string) => {
    const field = layout.types[node.type].members.find(
      (m: any) => m.label === name
    )
    if (!field) throw Error(`Missing storage field ${name}`)
    return {
      type: field.type,
      slot: ethers.BigNumber.from(node.slot).add(field.slot),
      offset: field.offset,
    }
  }
  const entry = (node: any, key: string, keyType = "bytes32") => ({
    type: layout.types[node.type].value,
    slot: ethers.BigNumber.from(
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          [keyType, "uint256"],
          [key, node.slot]
        )
      )
    ),
    offset: 0,
  })
  const slotHex = (slot: any) => ethers.utils.hexZeroPad(slot.toHexString(), 32)
  /// Read-modify-write of one packed field; a controlled marker only.
  const writeField = async (node: any, value: ethers.BigNumberish) => {
    const bytes = Number(layout.types[node.type].numberOfBytes)
    const word = ethers.BigNumber.from(
      await ethers.provider.getStorageAt(proxy.address, slotHex(node.slot))
    )
    const shift = node.offset * 8
    const mask = ethers.BigNumber.from(2)
      .pow(bytes * 8)
      .sub(1)
      .shl(shift)
    const next = word
      .and(ethers.constants.MaxUint256.xor(mask))
      .or(ethers.BigNumber.from(value).shl(shift))
    await network.provider.send("hardhat_setStorageAt", [
      proxy.address,
      ethers.utils.hexValue(node.slot),
      ethers.utils.hexZeroPad(next.toHexString(), 32),
    ])
  }
  const readField = async (node: any) => {
    const bytes = Number(layout.types[node.type].numberOfBytes)
    const word = ethers.BigNumber.from(
      await ethers.provider.getStorageAt(proxy.address, slotHex(node.slot))
    )
    return word
      .shr(node.offset * 8)
      .and(
        ethers.BigNumber.from(2)
          .pow(bytes * 8)
          .sub(1)
      )
      .toNumber()
  }
  const walletNode = (w: Wallet) =>
    entry(child(child(self, "frost"), "wallets"), w.label, "bytes20")
  const movementNode = () => child(self, "frostMovement")

  const now = async () => (await ethers.provider.getBlock("latest")).timestamp
  const state = async (w: Wallet) => readField(child(walletNode(w), "state"))

  /// Controlled C-09 stand-in: enter MovingFunds and keep the counter true.
  const enterMovingFunds = async (w: Wallet) => {
    const eligible =
      [State.ReadyUnfunded, State.Live].includes(await state(w)) &&
      (await readField(child(walletNode(w), "quarantined"))) === 0
    await writeField(child(walletNode(w), "state"), State.MovingFunds)
    if (eligible) {
      const counter = child(movementNode(), "eligibleTargets")
      await writeField(counter, (await readField(counter)) - 1)
    }
    await writeField(
      child(
        entry(child(movementNode(), "lifecycles"), w.id),
        "movingFundsRequestedAt"
      ),
      await now()
    )
  }
  const setState = async (w: Wallet, next: number) => {
    const before = await state(w)
    const wasEligible = [State.ReadyUnfunded, State.Live].includes(before)
    const isEligible = [State.ReadyUnfunded, State.Live].includes(next)
    await writeField(child(walletNode(w), "state"), next)
    if (wasEligible !== isEligible) {
      const counter = child(movementNode(), "eligibleTargets")
      await writeField(
        counter,
        (await readField(counter)) + (isEligible ? 1 : -1)
      )
    }
  }

  let revealed = 0
  const terms = async (w: Wallet, amount: number, lockAhead = 86400) => {
    revealed += 1
    return {
      chainId,
      bridge: proxy.address,
      bitcoinGenesis: genesis,
      fullWalletId: w.id,
      descriptorHash: w.descriptorHash,
      depositor: depositor.address,
      vault: ethers.constants.AddressZero,
      blinding: ethers.utils.hexZeroPad(ethers.utils.hexlify(revealed), 8),
      amount,
      refundKey: w.q,
      refundLocktime: (await now()) + lockAhead,
      extraData: ZERO,
    }
  }
  /// Reveal one deposit and return its funding transaction.
  const reveal = async (w: Wallet, amount: number, lockAhead = 86400) => {
    const t = await terms(w, amount, lockAhead)
    const output = await frost.frostDepositOutput(t)
    const funding = transaction(
      [[ethers.utils.id(`C06 funding ${revealed}`), 0]],
      [{ value: amount, script: p2tr(output.key) }]
    )
    await frost.connect(depositor).revealFrostDeposit(t, funding.tx, 0)
    return funding
  }
  /// Fund an unfunded wallet with one real deposit sweep (fee 1,000).
  const fund = async (w: Wallet, amount: number) => {
    const funding = await reveal(w, amount)
    const main = transaction(
      [[funding.hash, 0]],
      [{ value: amount - 1000, script: p2tr(w.q) }]
    )
    await frost.submitFrostDepositSweepProof({
      walletId: w.id,
      transaction: main.tx,
      proof: inclusion(main.hash),
      includeMain: false,
      vault: ethers.constants.AddressZero,
    })
    // The wallet record tracks its current main for the tests.
    /* eslint-disable no-param-reassign */
    w.main = main
    w.value = amount - 1000
    /* eslint-enable no-param-reassign */
    return main
  }
  // frostDeposit returns the ABI-encoded FrostFundingState.Deposit.
  const depositType = (
    await artifacts.readArtifact("FrostDepositSweepFixture")
  ).abi.find((f: any) => f.name === "deposit").outputs[0]
  const deposit = async (key: string) =>
    ethers.utils.defaultAbiCoder.decode(
      [ethers.utils.ParamType.from(depositType)],
      await frost.frostDeposit(key)
    )[0]
  const commitment = async (w: Wallet, period?: number) =>
    frost.frostMovingFundsCommitment(
      w.id,
      period ?? (await frost.frostWalletLifecycle(w.id)).period
    )

  return {
    signers,
    owner,
    depositor,
    treasury,
    operator,
    bank,
    bridge,
    frost,
    proxy,
    pool,
    registry,
    legacyRegistry,
    wallets,
    layout,
    self,
    child,
    entry,
    writeField,
    readField,
    walletNode,
    movementNode,
    now,
    state,
    enterMovingFunds,
    setState,
    reveal,
    fund,
    deposit,
    commitment,
  }
}
export type World = Awaited<ReturnType<typeof movementWorld>>

/// Sort wallets by label, the commitment order.
export const ascending = (ws: Wallet[]) =>
  [...ws].sort((a, b) =>
    ethers.BigNumber.from(a.label).lt(ethers.BigNumber.from(b.label)) ? -1 : 1
  )

/// Equal split of `total` with the remainder on the last output.
export function split(total: number, n: number) {
  const base = Math.floor(total / n)
  return Array.from({ length: n }, (_, i) =>
    i === n - 1 ? total - base * (n - 1) : base
  )
}
