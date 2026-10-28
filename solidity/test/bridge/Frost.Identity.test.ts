/* eslint-disable no-await-in-loop, no-restricted-syntax */
// Contract transitions, deployment links and upgrade snapshots are sequential.
/* eslint-disable no-underscore-dangle */
import { artifacts, ethers, network, run } from "hardhat"
import { expect } from "chai"
import { execFileSync } from "child_process"
import path from "path"

const BASE = "40a11d1dcdcf82d3962e430067cfe3f97be81483"
const TYPE =
  "tuple(uint8 scheme,uint8 profile,uint256 chainId,address registry,uint64 epoch,uint32[] members,address[] operators,uint16 threshold,bytes32 snowfallDescriptor,bytes32 outputKey)"
const Q = "0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
const Y = "0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8"
const ID = ethers.utils.keccak256(
  ethers.utils.concat([ethers.utils.id("tbtc-v2/frost-wallet-id/v1"), Q])
)
const LABEL = ID.slice(0, 42)

// Deploy real linked contracts with the normal EIP-170 size limit.
async function deploy(
  name: string,
  args: any[] = [],
  compiled?: any,
  cache = new Map<string, string>()
): Promise<any> {
  const [signer] = await ethers.getSigners()
  let a: any
  if (compiled) {
    const [source, contract] = name.split(":")
    const c = compiled.contracts[source][contract]
    a = {
      abi: c.abi,
      bytecode: `0x${c.evm.bytecode.object}`,
      linkReferences: c.evm.bytecode.linkReferences,
    }
  } else a = await artifacts.readArtifact(name)
  let { bytecode } = a
  for (const [source, libs] of Object.entries(a.linkReferences) as any) {
    for (const [lib, positions] of Object.entries(libs) as any) {
      const key = `${source}:${lib}`
      if (!cache.has(key))
        cache.set(key, (await deploy(key, [], compiled, cache)).address)
      for (const p of positions)
        bytecode =
          bytecode.slice(0, 2 + p.start * 2) +
          cache.get(key)!.slice(2) +
          bytecode.slice(2 + (p.start + p.length) * 2)
    }
  }
  const c = await new ethers.ContractFactory(a.abi, bytecode, signer).deploy(
    ...args
  )
  await c.deployed()
  expect(
    (await ethers.provider.getCode(c.address)).length / 2 - 1
  ).to.be.at.most(24576)
  return c
}
async function fixture(compiled?: any) {
  const [admin, other] = await ethers.getSigners()
  const implementation = await deploy(
    "contracts/bridge/Bridge.sol:Bridge",
    [],
    compiled
  )
  const proxyAdmin = await deploy(
    "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin"
  )
  const data = implementation.interface.encodeFunctionData(
    "initialize",
    Array(5).fill(admin.address).concat([1])
  )
  const proxy = await deploy(
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy",
    [implementation.address, proxyAdmin.address, data]
  )
  const bridge = implementation.attach(proxy.address)
  const frost = await ethers.getContractAt("IFrostBridge", proxy.address)
  return { admin, other, bridge, frost, proxyAdmin }
}
async function descriptor(registry: string) {
  const [a, b, c] = await ethers.getSigners()
  return {
    scheme: 2,
    profile: 1,
    chainId: (await ethers.provider.getNetwork()).chainId,
    registry,
    epoch: await ethers.provider.getBlockNumber(),
    members: [1, 2, 3],
    operators: [a.address, b.address, c.address],
    threshold: 2,
    snowfallDescriptor: ethers.utils.id("local-vector"),
    outputKey: Q,
  }
}
function encode(d: any) {
  return ethers.utils.defaultAbiCoder.encode([TYPE], [d])
}
function commitment(d: any) {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["bytes32", TYPE],
      [ethers.utils.id("tbtc-v2/frost-descriptor/v1"), d]
    )
  )
}

// Hash preimages for a cross-scheme label collision are not feasible to find.
// Force only the occupied state at the colliding label using the compiler's
// real storage layout, then exercise the actual public callback and undo the
// injection for a positive control with the exact same input.
async function forceCollisionState(bridge: any, frost: boolean, label: string) {
  const info: any = await artifacts.getBuildInfo(
    "contracts/bridge/Bridge.sol:Bridge"
  )
  const layout =
    info.output.contracts["contracts/bridge/Bridge.sol"].Bridge.storageLayout
  const self = layout.storage.find((field: any) => field.label === "self")
  let parent = layout.types[self.type]
  let base = ethers.BigNumber.from(self.slot)
  if (frost) {
    const field = parent.members.find((member: any) => member.label === "frost")
    base = base.add(field.slot)
    parent = layout.types[field.type]
  }
  const field = parent.members.find(
    (member: any) => member.label === (frost ? "wallets" : "registeredWallets")
  )
  const wallet = layout.types[layout.types[field.type].value]
  const state = wallet.members.find((member: any) => member.label === "state")
  const entry = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["bytes20", "uint256"],
      [label, base.add(field.slot)]
    )
  )
  const slot = ethers.utils.hexZeroPad(
    ethers.BigNumber.from(entry).add(state.slot).toHexString(),
    32
  )
  const original = await ethers.provider.getStorageAt(bridge.address, slot)
  const mask = ethers.BigNumber.from(255).shl(state.offset * 8)
  const occupied = ethers.BigNumber.from(original)
    .and(ethers.constants.MaxUint256.xor(mask))
    .or(ethers.BigNumber.from(frost ? 2 : 1).shl(state.offset * 8))
  await network.provider.send("hardhat_setStorageAt", [
    bridge.address,
    slot,
    ethers.utils.hexZeroPad(occupied.toHexString(), 32),
  ])
  return {
    slot,
    occupied: ethers.utils.hexZeroPad(occupied.toHexString(), 32),
    undo: async () =>
      network.provider.send("hardhat_setStorageAt", [
        bridge.address,
        slot,
        original,
      ]),
  }
}

describe("FROST immutable identity and inactive Bridge", () => {
  it("keeps legacy identity, callback authority, exact output routing, and tombstones distinct", async () => {
    const { admin, other, bridge, frost } = await fixture()
    const registry = await deploy(
      "contracts/test/FrostRegistryFixture.sol:FrostRegistryFixture",
      [bridge.address]
    )
    await expect(frost.connect(other).configureFrostRegistry(registry.address))
      .to.be.reverted
    await frost.configureFrostRegistry(registry.address)
    await expect(frost.configureFrostRegistry(registry.address)).to.be.reverted
    await expect(frost.requestNewFrostWallet()).to.be.reverted
    const d = await descriptor(registry.address)
    const encoded = encode(d)
    const deadline = (await ethers.provider.getBlockNumber()) + 20
    await expect(frost.__snowfallWalletCreated(encoded, deadline)).to.be
      .reverted
    await registry.created(encoded, deadline)
    expect(await frost.walletScheme(LABEL)).to.equal(2)
    expect(await frost.resolveWallet(registry.address, ID)).to.equal(LABEL)
    expect(await frost.resolveWalletOutput(Q)).to.equal(LABEL)
    expect(
      await frost.resolveFrostOutputScript(`0x5120${Q.slice(2)}`)
    ).to.equal(LABEL)
    expect(
      await frost.resolveFrostOutputScript(`0x225120${Q.slice(2)}`)
    ).to.equal(LABEL)
    for (const raw of [
      `0x5121${Q.slice(2)}`,
      `0x215120${Q.slice(2)}`,
      `0x5120${Q.slice(2)}00`,
    ])
      await expect(frost.resolveFrostOutputScript(raw)).to.be.reverted
    expect(await frost.isFrostFundingTarget(LABEL)).to.equal(false)
    await expect(registry.created(encoded, deadline)).to.be.reverted
    await bridge.__ecdsaWalletCreatedCallback(ethers.utils.id("legacy"), Q, Y)
    const legacyLabel = ethers.utils.ripemd160(
      ethers.utils.sha256(`0x02${Q.slice(2)}`)
    )
    expect(await frost.walletScheme(legacyLabel)).to.equal(1)
    expect((await bridge.wallets(legacyLabel)).state).to.equal(1)
    const invalidX = ethers.utils.hexZeroPad("0x01", 32)
    const invalidLabel = ethers.utils.ripemd160(
      ethers.utils.sha256(`0x02${invalidX.slice(2)}`)
    )
    expect(await frost.walletScheme(invalidLabel)).to.equal(0)
    await expect(
      bridge.__ecdsaWalletCreatedCallback(
        ethers.utils.id("invalid"),
        // Distinct, unused label: duplicate registration cannot mask the curve check.
        invalidX,
        ethers.constants.HashZero
      )
    ).to.be.revertedWith("Invalid ECDSA curve point")
    await network.provider.send("hardhat_mine", [
      `0x${(deadline - (await ethers.provider.getBlockNumber())).toString(16)}`,
    ])
    await expect(registry.ready(ID, commitment(d))).to.be.reverted
    await registry.expire(ID)
    expect(await frost.resolveWalletOutput(Q)).to.equal(LABEL)
    await expect(registry.created(encoded, deadline + 100)).to.be.reverted
    expect(await frost.isFrostFundingTarget(LABEL)).to.equal(false)
    expect((await bridge.wallets(legacyLabel)).state).to.equal(1)
    await expect(
      admin.sendTransaction({ to: bridge.address, data: "0xdeadbeef" })
    ).to.be.reverted
  })
  it("rejects changed domains, profiles, noncanonical points, and malformed descriptors", async () => {
    const { bridge, frost } = await fixture()
    const r = await deploy(
      "contracts/test/FrostRegistryFixture.sol:FrostRegistryFixture",
      [bridge.address]
    )
    await frost.configureFrostRegistry(r.address)
    const d = await descriptor(r.address)
    const deadline = (await ethers.provider.getBlockNumber()) + 100
    for (const changes of [
      { scheme: 0 },
      { profile: 9 },
      { chainId: d.chainId + 1 },
      { registry: bridge.address },
      { threshold: 1 },
      { members: [1, 2] },
      { outputKey: `0x${"ff".repeat(32)}` },
      { outputKey: ethers.constants.HashZero },
    ])
      await expect(r.created(encode({ ...d, ...changes }), deadline)).to.be
        .reverted
    await expect(r.created(`${encode(d)}00`, deadline)).to.be.reverted
  })
  it("rejects cross-scheme label occupancy in both directions", async () => {
    for (const incomingFrost of [true, false]) {
      const { bridge, frost } = await fixture()
      const registry = await deploy(
        "contracts/test/FrostRegistryFixture.sol:FrostRegistryFixture",
        [bridge.address]
      )
      await frost.configureFrostRegistry(registry.address)
      const d = await descriptor(registry.address)
      const deadline = (await ethers.provider.getBlockNumber()) + 30
      const label = incomingFrost
        ? LABEL
        : ethers.utils.ripemd160(ethers.utils.sha256(`0x02${Q.slice(2)}`))
      const collision = await forceCollisionState(bridge, !incomingFrost, label)
      expect(
        await ethers.provider.getStorageAt(bridge.address, collision.slot)
      ).to.equal(collision.occupied)
      const count = await bridge.liveWalletsCount()
      const submit = () =>
        incomingFrost
          ? registry.created(encode(d), deadline)
          : bridge.__ecdsaWalletCreatedCallback(
              ethers.utils.id("collision-control"),
              Q,
              Y
            )
      await expect(submit()).to.be.revertedWith(
        incomingFrost ? "FROST identity occupied" : "Wallet label occupied"
      )
      expect(
        await ethers.provider.getStorageAt(bridge.address, collision.slot)
      ).to.equal(collision.occupied)
      expect(await bridge.liveWalletsCount()).to.equal(count)
      await collision.undo()
      await submit()
      expect(await frost.walletScheme(label)).to.equal(incomingFrost ? 2 : 1)
    }
  })
  it("keeps Q reserved across epochs, including after unfunded expiry", async () => {
    const { bridge, frost } = await fixture()
    const registry = await deploy(
      "contracts/test/FrostRegistryFixture.sol:FrostRegistryFixture",
      [bridge.address]
    )
    await frost.configureFrostRegistry(registry.address)
    const d = await descriptor(registry.address)
    const deadline = (await ethers.provider.getBlockNumber()) + 30
    await registry.created(encode(d), deadline)
    for (const expired of [false, true]) {
      if (expired) {
        await network.provider.send("hardhat_mine", [
          `0x${(deadline - (await ethers.provider.getBlockNumber())).toString(
            16
          )}`,
        ])
        await registry.expire(ID)
      } else await network.provider.send("evm_mine")
      const retained = await frost.walletDescriptor(LABEL)
      const next = {
        ...d,
        epoch: await ethers.provider.getBlockNumber(),
        snowfallDescriptor: ethers.utils.id("fresh-epoch-same-Q"),
      }
      expect(next.epoch).to.be.greaterThan(d.epoch)
      await expect(
        registry.created(encode(next), deadline + 100)
      ).to.be.revertedWith("FROST identity occupied")
      expect(await frost.walletDescriptor(LABEL)).to.equal(retained)
      expect(await frost.resolveWalletOutput(Q)).to.equal(LABEL)
      expect(await frost.resolveWallet(registry.address, ID)).to.equal(LABEL)
    }
  })
  it("preserves every old storage field and populated legacy getters across the upgrade", async function () {
    this.timeout(180000)
    const info: any = await artifacts.getBuildInfo(
      "contracts/bridge/Bridge.sol:Bridge"
    )
    const input = JSON.parse(JSON.stringify(info.input))
    for (const name of ["Bridge.sol", "BridgeState.sol", "Wallets.sol"]) {
      input.sources[`contracts/bridge/${name}`].content = execFileSync(
        "git",
        ["show", `${BASE}:solidity/contracts/bridge/${name}`],
        { cwd: path.resolve(__dirname, "../../.."), encoding: "utf8" }
      )
    }
    for (const key of Object.keys(input.sources)) {
      if (
        key.startsWith("contracts/frost/") ||
        key === "contracts/test/FrostRegistryFixture.sol"
      )
        delete input.sources[key]
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
    expect(
      (output.errors || []).filter((e: any) => e.severity === "error")
    ).to.deep.equal([])
    const before =
      output.contracts["contracts/bridge/Bridge.sol"].Bridge.storageLayout
    const after =
      info.output.contracts["contracts/bridge/Bridge.sol"].Bridge.storageLayout
    function shape(layout: any, type: string): any {
      const t = layout.types[type]
      return {
        encoding: t.encoding,
        bytes: t.numberOfBytes,
        label: t.label,
        members: t.members?.map((m: any) => ({
          label: m.label,
          slot: m.slot,
          offset: m.offset,
          shape: shape(layout, m.type),
        })),
        key: t.key ? shape(layout, t.key) : undefined,
        value: t.value ? shape(layout, t.value) : undefined,
        base: t.base ? shape(layout, t.base) : undefined,
      }
    }
    for (const old of before.storage) {
      const now = after.storage.find((x: any) => x.label === old.label)
      expect([now.slot, now.offset]).to.deep.equal([old.slot, old.offset])
      if (old.label !== "self")
        expect(shape(after, now.type)).to.deep.equal(shape(before, old.type))
    }
    const oldSelf =
      before.types[before.storage.find((x: any) => x.label === "self").type]
    const newSelf =
      after.types[after.storage.find((x: any) => x.label === "self").type]
    expect(newSelf.numberOfBytes).to.equal(oldSelf.numberOfBytes)
    for (const old of oldSelf.members.filter((x: any) => x.label !== "__gap")) {
      const now = newSelf.members.find((x: any) => x.label === old.label)
      expect([now.slot, now.offset, shape(after, now.type)]).to.deep.equal([
        old.slot,
        old.offset,
        shape(before, old.type),
      ])
    }
    const { bridge, proxyAdmin, admin } = await fixture(output)
    const legacy = ethers.utils.ripemd160(
      ethers.utils.sha256(`0x02${Q.slice(2)}`)
    )
    await bridge.__ecdsaWalletCreatedCallback(ethers.utils.id("legacy"), Q, Y)
    await bridge.updateTreasury(admin.address)
    const slots = 51 + Number(oldSelf.numberOfBytes) / 32
    const words = []
    for (let i = 0; i < slots; i++)
      words.push(await ethers.provider.getStorageAt(bridge.address, i))
    const getters: any = {}
    for (const [name, f] of Object.entries(bridge.interface.functions) as any) {
      if (
        f.inputs.length === 0 &&
        (f.stateMutability === "view" || f.stateMutability === "pure")
      ) {
        try {
          getters[name] = JSON.stringify(await bridge[name]())
        } catch {
          getters[name] = "revert"
        }
      }
    }
    const walletBefore = JSON.stringify(await bridge.wallets(legacy))
    const next = await deploy("contracts/bridge/Bridge.sol:Bridge")
    await proxyAdmin.upgrade(bridge.address, next.address)
    for (let i = 0; i < slots; i++)
      expect(await ethers.provider.getStorageAt(bridge.address, i)).to.equal(
        words[i]
      )
    for (const name of Object.keys(getters)) {
      let value
      try {
        value = JSON.stringify(await bridge[name]())
      } catch {
        value = "revert"
      }
      expect(value).to.equal(getters[name])
    }
    expect(JSON.stringify(await bridge.wallets(legacy))).to.equal(walletBefore)
    expect(
      await (
        await ethers.getContractAt("IFrostBridge", bridge.address)
      ).walletScheme(legacy)
    ).to.equal(1)
  })
})
