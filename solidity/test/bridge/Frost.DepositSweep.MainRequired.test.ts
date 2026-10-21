/* eslint-disable no-await-in-loop, no-restricted-syntax, no-bitwise */
// F2 only: real Bridge proxy/API, verifier and Bank. Synthetic two-leaf regtest
// inclusion proofs test accounting, not Bitcoin spend validity or chain work.
// Only the active-reservation marker is controlled, since C04 is absent here.
import { artifacts, ethers, network } from "hardhat"
import { expect } from "chai"
import { createHash } from "crypto"

const ZERO = ethers.constants.HashZero
const Q = "0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
const ID = ethers.utils.keccak256(
  ethers.utils.concat([ethers.utils.id("tbtc-v2/frost-wallet-id/v1"), Q])
)
const TYPE =
  "tuple(uint8 scheme,uint8 profile,uint256 chainId,address registry,uint64 epoch,uint32[] members,address[] operators,uint16 threshold,bytes32 snowfallDescriptor,bytes32 outputKey)"
const sha = (value: Buffer) => createHash("sha256").update(value).digest()
const sha256d = (value: Buffer) => sha(sha(value))
const hex = (value: Buffer) => `0x${value.toString("hex")}`
const raw = (value: string) => Buffer.from(value.slice(2), "hex")
const le = (value: number, width: number) => {
  const b = Buffer.alloc(width)
  b.writeUIntLE(value, 0, width)
  return b
}
const outpoint = (hash: string) =>
  ethers.utils.solidityKeccak256(["bytes32", "uint32"], [hash, 0])

async function deploy(
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
  expect(
    (await ethers.provider.getCode(c.address)).length / 2 - 1,
    name
  ).to.be.at.most(24576)
  return c
}

function transaction(inputs: string[], outputKey: string, amount: number) {
  const tx = {
    version: "0x02000000",
    inputVector: hex(
      Buffer.concat([
        Buffer.from([inputs.length]),
        ...inputs.map((hash) =>
          Buffer.concat([
            raw(hash),
            le(0, 4),
            Buffer.from([0]),
            le(0xffffffff, 4),
          ])
        ),
      ])
    ),
    outputVector: hex(
      Buffer.concat([
        Buffer.from([1]),
        le(amount, 6),
        Buffer.alloc(2),
        Buffer.from("225120", "hex"),
        raw(outputKey),
      ])
    ),
    locktime: "0x00000000",
  }
  const hash = hex(sha256d(Buffer.concat(Object.values(tx).map(raw))))
  return { tx, hash, key: outpoint(hash) }
}

function inclusion(hash: string) {
  const coinbasePreimage = sha(Buffer.from("F2 synthetic coinbase preimage"))
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

describe("C05 F2 required main input through the public Bridge", () => {
  let bridge: any
  let frost: any
  let bank: any
  let payer: any
  let treasury: any
  let signers: any[]
  let terms: any
  let main: ReturnType<typeof transaction>
  let deposits: ReturnType<typeof transaction>[]
  let layout: any
  let self: any
  let snapshot: string

  // Resolve actual compiler slots, never hard-code a custody balance or output.
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
  })
  const span = (node: any) =>
    Array.from(
      { length: Math.ceil(Number(layout.types[node.type].numberOfBytes) / 32) },
      (_, i) =>
        ethers.utils.hexZeroPad(
          ethers.BigNumber.from(node.slot).add(i).toHexString(),
          32
        )
    )
  const walletNode = () =>
    entry(child(child(self, "frostCustody"), "wallets"), ID)
  const wallet = async () => {
    const words = await Promise.all(
      span(walletNode()).map((slot) =>
        ethers.provider.getStorageAt(bridge.address, slot)
      )
    )
    const packed = ethers.BigNumber.from(words[0])
    const mask = ethers.BigNumber.from(2).pow(64).sub(1)
    return {
      generation: packed.and(mask).toNumber(),
      stateVersion: packed.shr(64).and(mask).toNumber(),
      value: packed.shr(128).and(mask).toNumber(),
      mainOutpoint: words[1],
      activeReservation: words[2],
      cancellationExposure: ethers.BigNumber.from(words[3]).toString(),
    }
  }
  const frame = async (keys: string[]) => {
    const funding = child(self, "frostFunding")
    const custody = child(self, "frostCustody")
    const nodes = [
      self,
      walletNode(),
      entry(child(funding, "pendingReveals"), ID),
      entry(child(child(self, "frost"), "wallets"), ID.slice(0, 42), "bytes20"),
    ]
    for (const key of keys) {
      nodes.push(
        entry(child(funding, "deposits"), key),
        entry(child(custody, "outputs"), key),
        entry(child(self, "spentMainUTXOs"), key)
      )
    }
    const slots = Array.from(new Set(nodes.flatMap(span)))
    const addresses = [
      ...signers.map((s) => s.address),
      bridge.address,
      bank.address,
    ]
    return {
      storage: await Promise.all(
        slots.map((slot) => ethers.provider.getStorageAt(bridge.address, slot))
      ),
      deposits: await Promise.all(
        deposits.map((d) => frost.frostDeposit(d.key))
      ),
      balances: await Promise.all(
        addresses.map(async (a) => (await bank.balanceOf(a)).toString())
      ),
      allowances: await Promise.all(
        addresses.map(async (a) =>
          (await bank.allowance(a, bridge.address)).toString()
        )
      ),
      nonces: await Promise.all(
        addresses.map(async (a) => (await bank.nonces(a)).toString())
      ),
      bankOwner: await bank.owner(),
      bankBridge: await bank.bridge(),
    }
  }
  const sweep = (tx: ReturnType<typeof transaction>, includeMain: boolean) => ({
    walletId: ID,
    transaction: tx.tx,
    proof: inclusion(tx.hash),
    includeMain,
    vault: ethers.constants.AddressZero,
  })
  const spent = async (key: string) =>
    (await ethers.provider.getStorageAt(
      bridge.address,
      ethers.utils.hexZeroPad(
        entry(child(self, "spentMainUTXOs"), key).slot.toHexString(),
        32
      )
    )) !== ZERO

  before(async () => {
    signers = await ethers.getSigners()
    const [owner, depositor, feeRecipient] = signers
    payer = depositor
    treasury = feeRecipient
    bank = await deploy("Bank")
    const relay = await deploy("FrostDepositRegtestRelay")
    const implementation = await deploy("Bridge")
    const admin = await deploy("ProxyAdmin")
    const init = implementation.interface.encodeFunctionData("initialize", [
      bank.address,
      relay.address,
      treasury.address,
      owner.address,
      owner.address,
      1,
    ])
    const proxy = await deploy("TransparentUpgradeableProxy", [
      implementation.address,
      admin.address,
      init,
    ])
    bridge = implementation.attach(proxy.address)
    frost = await ethers.getContractAt("IFrostBridge", proxy.address)
    await bank.updateBridge(proxy.address)
    await bridge.setSpvMaintainerStatus(owner.address, true)
    await bridge.updateDepositParameters(10000, 100, 2000, 30)
    const registry = await deploy("FrostRegistryFixture", [proxy.address])
    await frost.configureFrostRegistry(registry.address)
    const descriptor = {
      scheme: 2,
      profile: 1,
      chainId: (await ethers.provider.getNetwork()).chainId,
      registry: registry.address,
      epoch: await ethers.provider.getBlockNumber(),
      members: [1, 2, 3],
      operators: [owner.address, payer.address, treasury.address],
      threshold: 2,
      snowfallDescriptor: ethers.utils.id("F2 controlled registry descriptor"),
      outputKey: Q,
    }
    const descriptorHash = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", TYPE],
        [ethers.utils.id("tbtc-v2/frost-descriptor/v1"), descriptor]
      )
    )
    await registry.created(
      ethers.utils.defaultAbiCoder.encode([TYPE], [descriptor]),
      (await ethers.provider.getBlockNumber()) + 1000
    )
    await registry.ready(ID, descriptorHash)
    const verifier = await deploy("FrostVerifier")
    const genesis = ethers.utils.id("F2 synthetic regtest domain")
    await frost.configureFrostFunding(
      verifier.address,
      ethers.utils.keccak256(await ethers.provider.getCode(verifier.address)),
      ethers.utils.id("UNQUALIFIED F2 local test"),
      genesis
    )
    await frost.setFrostFundingGates(true, true)
    terms = {
      chainId: descriptor.chainId,
      bridge: bridge.address,
      bitcoinGenesis: genesis,
      fullWalletId: ID,
      descriptorHash,
      depositor: payer.address,
      vault: ethers.constants.AddressZero,
      blinding: "0x0000000000000001",
      amount: 100000,
      refundKey: Q,
      refundLocktime:
        (await ethers.provider.getBlock("latest")).timestamp + 86400,
      extraData: ZERO,
    }
    deposits = []
    for (let i = 0; i < 3; i++) {
      const t = {
        ...terms,
        blinding: ethers.utils.hexZeroPad(ethers.utils.hexlify(i + 1), 8),
      }
      const output = await frost.frostDepositOutput(t)
      const d = transaction(
        [ethers.utils.id(`F2 funding ${i}`)],
        output.key,
        100000
      )
      await frost.connect(payer).revealFrostDeposit(t, d.tx, 0)
      deposits.push(d)
    }
    const info = await artifacts.getBuildInfo(
      "contracts/bridge/Bridge.sol:Bridge"
    )
    if (!info) throw Error("Missing Bridge build info")
    layout =
      info.output.contracts["contracts/bridge/Bridge.sol"].Bridge.storageLayout
    self = layout.storage.find((s: any) => s.label === "self")
    main = transaction([deposits[0].hash], Q, 99000)
    await frost.submitFrostDepositSweepProof(sweep(main, false))
    expect(await wallet()).to.deep.equal({
      generation: 0,
      stateVersion: 1,
      value: 99000,
      mainOutpoint: main.key,
      activeReservation: ZERO,
      cancellationExposure: "0",
    })
    expect(await bank.balanceOf(payer.address)).to.equal(98000)
    expect(await bank.balanceOf(treasury.address)).to.equal(1000)
    snapshot = await network.provider.send("evm_snapshot")
  })
  beforeEach(async () => {
    expect(await network.provider.send("evm_revert", [snapshot])).to.equal(true)
    snapshot = await network.provider.send("evm_snapshot")
  })

  it("refuses an unreserved deposit-only fragment and rolls back the complete financial frame", async () => {
    const fragment = transaction([deposits[1].hash], Q, 99000)
    const keys = [...deposits.map((d) => d.key), main.key, fragment.key]
    const before = await frame(keys)
    await expect(
      frost.submitFrostDepositSweepProof(sweep(fragment, false))
    ).to.be.revertedWith("FROST sweep main required")
    expect(await frame(keys)).to.deep.equal(before)
    expect((await frost.frostCustodyOutput(fragment.key)).walletId).to.equal(
      ZERO
    )
    // The very same fragment is valid once a reservation exists: refusal above
    // is the F2 predecessor rule, not a malformed transaction or proof.
    const reservation = child(walletNode(), "activeReservation")
    await network.provider.send("hardhat_setStorageAt", [
      bridge.address,
      ethers.utils.hexZeroPad(reservation.slot.toHexString(), 32),
      ethers.utils.id("F2 controlled active reservation"),
    ])
    await frost.submitFrostDepositSweepProof(sweep(fragment, false))
    expect((await frost.frostCustodyOutput(fragment.key)).value).to.equal(99000)
  })

  it("includes and replaces the unreserved main, conserving fees/credits and tombstoning every input", async () => {
    const replacement = transaction(
      [deposits[1].hash, main.hash, deposits[2].hash],
      Q,
      297499
    )
    await frost.submitFrostDepositSweepProof(sweep(replacement, true))
    // 99,000 + 200,000 - 1,501 = 297,499. Fee split 750 / 751;
    // depositor increment 196,499 plus treasury increment 2,000 = 198,499.
    expect(await bank.balanceOf(payer.address)).to.equal(294499)
    expect(await bank.balanceOf(treasury.address)).to.equal(3000)
    expect(await wallet()).to.deep.equal({
      generation: 0,
      stateVersion: 2,
      value: 297499,
      mainOutpoint: replacement.key,
      activeReservation: ZERO,
      cancellationExposure: "0",
    })
    expect((await frost.frostCustodyOutput(main.key)).spent).to.equal(true)
    expect((await frost.frostCustodyOutput(replacement.key)).value).to.equal(
      297499
    )
    for (const d of deposits) {
      expect(await spent(d.key)).to.equal(true)
      const sweptAt = child(
        entry(child(child(self, "frostFunding"), "deposits"), d.key),
        "sweptAt"
      )
      const recorded = ethers.BigNumber.from(
        await ethers.provider.getStorageAt(
          bridge.address,
          ethers.utils.hexZeroPad(sweptAt.slot.toHexString(), 32)
        )
      )
        .shr(sweptAt.offset * 8)
        .and(ethers.BigNumber.from(2).pow(64).sub(1))
      expect(recorded, "deposit sweep tombstone").not.to.equal(0)
    }
    expect(await spent(main.key)).to.equal(true)
    expect(await spent(replacement.key)).to.equal(false)
    const pending = entry(
      child(child(self, "frostFunding"), "pendingReveals"),
      ID
    )
    expect(
      ethers.BigNumber.from(
        await ethers.provider.getStorageAt(
          bridge.address,
          ethers.utils.hexZeroPad(pending.slot.toHexString(), 32)
        )
      )
    ).to.equal(0)
    const before = await frame([
      ...deposits.map((d) => d.key),
      main.key,
      replacement.key,
    ])
    await expect(
      frost.submitFrostDepositSweepProof(sweep(replacement, true))
    ).to.be.revertedWith("FROST sweep input consumed")
    expect(
      await frame([...deposits.map((d) => d.key), main.key, replacement.key])
    ).to.deep.equal(before)
  })

  it("preserves the captured main/version while accepting proven deposit-only custody during a reservation", async () => {
    const reservationID = ethers.utils.id("F2 controlled active reservation")
    const reservation = child(walletNode(), "activeReservation")
    await network.provider.send("hardhat_setStorageAt", [
      bridge.address,
      ethers.utils.hexZeroPad(reservation.slot.toHexString(), 32),
      reservationID,
    ])
    const fragment = transaction([deposits[1].hash], Q, 99000)
    await frost.submitFrostDepositSweepProof(sweep(fragment, false))
    expect(await wallet()).to.deep.equal({
      generation: 0,
      stateVersion: 1,
      value: 198000,
      mainOutpoint: main.key,
      activeReservation: reservationID,
      cancellationExposure: "0",
    })
    expect((await frost.frostCustodyOutput(main.key)).spent).to.equal(false)
    expect(await spent(main.key)).to.equal(false)
    expect((await frost.frostCustodyOutput(fragment.key)).value).to.equal(99000)
    expect(await bank.balanceOf(payer.address)).to.equal(196000)
    expect(await bank.balanceOf(treasury.address)).to.equal(2000)
    const replacement = transaction([main.hash, deposits[2].hash], Q, 198000)
    const keys = [
      ...deposits.map((d) => d.key),
      main.key,
      fragment.key,
      replacement.key,
    ]
    const before = await frame(keys)
    await expect(
      frost.submitFrostDepositSweepProof(sweep(replacement, true))
    ).to.be.revertedWith("FROST sweep main reserved")
    expect(await frame(keys)).to.deep.equal(before)
  })
})
