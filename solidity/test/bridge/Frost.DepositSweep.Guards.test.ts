/* eslint-disable no-await-in-loop, no-restricted-syntax */
// Narrow public-route component evidence: actual Bridge/proxy, verifier, Bank
// and TBTCVault; controlled registry metadata and synthetic regtest SPV headers.
// No Bitcoin Core script acceptance, production finality or qualification claim.
// OPEN: a Core-mined refund-spent witness needs an extension of the existing
// Core helper. Synthetic shared-spent preconditions below do not discharge it.
import { artifacts, ethers, network } from "hardhat"
import { expect } from "chai"
import { baseTerms, unsigned, toHex } from "../data/frost/deposit-profile"

const Q = "0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
const TYPE =
  "tuple(uint8 scheme,uint8 profile,uint256 chainId,address registry,uint64 epoch,uint32[] members,address[] operators,uint16 threshold,bytes32 snowfallDescriptor,bytes32 outputKey)"
const ID = ethers.utils.keccak256(
  ethers.utils.hexConcat([ethers.utils.id("tbtc-v2/frost-wallet-id/v1"), Q])
)
const ZERO = ethers.constants.AddressZero
const hash256 = (bytes: string) =>
  ethers.utils.sha256(ethers.utils.sha256(bytes))
const txHash = (tx: any) =>
  hash256(
    ethers.utils.hexConcat([
      tx.version,
      tx.inputVector,
      tx.outputVector,
      tx.locktime,
    ])
  )
const outpoint = (hash: string, index = 0) =>
  ethers.utils.solidityKeccak256(["bytes32", "uint32"], [hash, index])
const entry = (hash: string, index = 0, script = "00") =>
  `${hash.slice(2)}${toHex(unsigned(index, 4, true)).slice(2)}${script}ffffffff`
const output = (value: string | number, key = Q) =>
  `${toHex(unsigned(value, 8, true)).slice(2)}225120${key.slice(2)}`

async function deploy(
  name: string,
  args: any[] = [],
  cache = new Map<string, string>()
): Promise<any> {
  const a = await artifacts.readArtifact(name)
  let { bytecode } = a
  for (const [source, libraries] of Object.entries(a.linkReferences)) {
    for (const [library, positions] of Object.entries(libraries)) {
      const key = `${source}:${library}`
      if (!cache.has(key))
        cache.set(key, (await deploy(key, [], cache)).address)
      const address = cache.get(key)
      if (!address) throw Error(key)
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
  expect((await ethers.provider.getCode(c.address)).length / 2 - 1).at.most(
    24576
  )
  return c
}

// Two-leaf synthetic block. The real BitcoinTx validator checks both inclusion
// paths and actual header PoW. Difficulty zero is deliberately unqualified.
function syntheticProof(tx: any) {
  const coinbasePreimage = ethers.utils.id(
    "synthetic coinbase preimage, not Core"
  )
  const coinbaseHash = ethers.utils.sha256(coinbasePreimage)
  const hash = txHash(tx)
  const root = hash256(ethers.utils.hexConcat([coinbaseHash, hash]))
  const header = Buffer.alloc(80)
  header.writeUInt32LE(2, 0)
  Buffer.from(root.slice(2), "hex").copy(header, 36)
  header.writeUInt32LE(1700000000, 68)
  header.writeUInt32LE(0x207fffff, 72)
  const target = BigInt("0x7fffff") * BigInt(2) ** BigInt(232)
  for (let nonce = 0; ; nonce += 1) {
    header.writeUInt32LE(nonce, 76)
    const digest = Buffer.from(hash256(toHex(header)).slice(2), "hex").reverse()
    if (BigInt(`0x${digest.toString("hex")}`) <= target) break
  }
  return {
    merkleProof: coinbaseHash,
    txIndexInBlock: 1,
    bitcoinHeaders: toHex(header),
    coinbasePreimage,
    coinbaseProof: hash,
  }
}

describe("C-05 public sweep guards (synthetic SPV component, unqualified)", () => {
  let bridge: any
  let frost: any
  let bank: any
  let vault: any
  let token: any
  let owner: any
  let payer: any
  let second: any
  let treasury: any
  let descriptorHash: string
  let snapshot: string
  let layout: any
  let self: any
  let tracked: Set<string>
  let legacyLabels: Set<string>

  before(async () => {
    const [governance, depositor, other, feeRecipient] =
      await ethers.getSigners()
    owner = governance
    payer = depositor
    second = other
    treasury = feeRecipient
    bank = await deploy("Bank")
    const relay = await deploy("FrostDepositRegtestRelay")
    const implementation = await deploy("Bridge")
    const admin = await deploy("ProxyAdmin")
    const proxy = await deploy("TransparentUpgradeableProxy", [
      implementation.address,
      admin.address,
      implementation.interface.encodeFunctionData("initialize", [
        bank.address,
        relay.address,
        treasury.address,
        owner.address,
        owner.address,
        1,
      ]),
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
      operators: [owner.address, payer.address, second.address],
      threshold: 2,
      snowfallDescriptor: ethers.utils.id("controlled F3 component registry"),
      outputKey: Q,
    }
    descriptorHash = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", TYPE],
        [ethers.utils.id("tbtc-v2/frost-descriptor/v1"), descriptor]
      )
    )
    await registry.created(
      ethers.utils.defaultAbiCoder.encode([TYPE], [descriptor]),
      (await ethers.provider.getBlockNumber()) + 100
    )
    await registry.ready(ID, descriptorHash)
    const verifier = await deploy("FrostVerifier")
    await frost.configureFrostFunding(
      verifier.address,
      ethers.utils.keccak256(await ethers.provider.getCode(verifier.address)),
      ethers.utils.id("UNQUALIFIED F3 component"),
      ethers.utils.id("synthetic network")
    )
    await frost.setFrostFundingGates(true, true)
    token = await deploy("TBTC")
    vault = await deploy("TBTCVault", [
      bank.address,
      token.address,
      bridge.address,
    ])
    await token.transferOwnership(vault.address)
    await bridge.setVaultStatus(vault.address, true)
    await vault.addMinter(owner.address)
    const build: any = await artifacts.getBuildInfo(
      "contracts/bridge/Bridge.sol:Bridge"
    )
    layout =
      build.output.contracts["contracts/bridge/Bridge.sol"].Bridge.storageLayout
    self = layout.storage.find((f: any) => f.label === "self")
    snapshot = await network.provider.send("evm_snapshot")
  })
  beforeEach(async () => {
    expect(await network.provider.send("evm_revert", [snapshot])).eq(true)
    snapshot = await network.provider.send("evm_snapshot")
    tracked = new Set<string>()
    legacyLabels = new Set<string>()
  })

  function member(path: string[]) {
    let type = layout.types[self.type]
    let slot = ethers.BigNumber.from(self.slot)
    for (const name of path) {
      const f = type.members.find((m: any) => m.label === name)
      if (!f) throw Error(`Missing storage member ${name}`)
      slot = slot.add(f.slot)
      type = layout.types[f.type]
    }
    return { type, slot }
  }
  function mappingSlots(path: string[], key: string) {
    const m = member(path)
    const base = ethers.BigNumber.from(
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          [layout.types[m.type.key].label, "uint256"],
          [key, m.slot]
        )
      )
    )
    const size = Math.ceil(
      Number(layout.types[m.type.value].numberOfBytes) / 32
    )
    return Array.from({ length: size }, (_, i) =>
      ethers.utils.hexZeroPad(base.add(i).toHexString(), 32)
    )
  }
  // Synthetic inconsistent identity/spent preconditions only. These targeted
  // guards are not a reachable Bitcoin refund or cross-scheme hash collision.
  async function occupy(path: string[], key: string, field?: string) {
    const mapping = member(path)
    const valueType = layout.types[mapping.type.value]
    const f = field
      ? valueType.members.find((m: any) => m.label === field)
      : { slot: 0, offset: 0 }
    if (!f) throw Error(`Missing occupied field ${field}`)
    const slot = ethers.utils.hexZeroPad(
      ethers.BigNumber.from(mappingSlots(path, key)[0])
        .add(f.slot)
        .toHexString(),
      32
    )
    const original = ethers.BigNumber.from(
      await ethers.provider.getStorageAt(bridge.address, slot)
    )
    // Set only the low bit of this field; preserve all packed neighbours.
    const changed = original.or(ethers.BigNumber.from(1).shl(f.offset * 8))
    await network.provider.send("hardhat_setStorageAt", [
      bridge.address,
      ethers.utils.hexValue(slot),
      ethers.utils.hexZeroPad(changed.toHexString(), 32),
    ])
  }
  // Full relevant financial frame: all static Bridge fields, both wallet records,
  // pending/entered/config, all touched receipt/legacy/custody/spent entries, Bank
  // balances/allowances/nonces and actual Vault token supply/balances/debt.
  async function frame() {
    const slots = Array.from(
      { length: Math.ceil(Number(layout.types[self.type].numberOfBytes) / 32) },
      (_, i) =>
        ethers.utils.hexZeroPad(
          ethers.BigNumber.from(self.slot).add(i).toHexString(),
          32
        )
    )
    slots.push(
      ...mappingSlots(["frost", "wallets"], ID.slice(0, 42)),
      ...mappingSlots(["frostCustody", "wallets"], ID),
      ...mappingSlots(["frostFunding", "pendingReveals"], ID)
    )
    for (const label of legacyLabels)
      slots.push(...mappingSlots(["registeredWallets"], label))
    for (const key of tracked)
      for (const p of [
        ["frostFunding", "deposits"],
        ["frostCustody", "outputs"],
        ["deposits"],
        ["spentMainUTXOs"],
      ])
        slots.push(...mappingSlots(p, key))
    const addresses = [
      owner.address,
      payer.address,
      second.address,
      treasury.address,
      bridge.address,
      bank.address,
      vault.address,
    ]
    const values = await Promise.all(
      slots.map((s) => ethers.provider.getStorageAt(bridge.address, s))
    )
    for (const address of addresses) {
      values.push(
        (await bank.balanceOf(address)).toString(),
        (await bank.nonces(address)).toString(),
        (await token.balanceOf(address)).toString(),
        (await vault.optimisticMintingDebt(address)).toString()
      )
      for (const spender of addresses)
        values.push(
          (await bank.allowance(address, spender)).toString(),
          (await token.allowance(address, spender)).toString()
        )
    }
    values.push(
      (await token.totalSupply()).toString(),
      await token.owner(),
      await bank.owner(),
      await bank.bridge(),
      await frost.walletDescriptor(ID.slice(0, 42))
    )
    for (const key of tracked)
      values.push(JSON.stringify(await vault.optimisticMintingRequests(key)))
    return values
  }
  async function reveal(
    signer = payer,
    route = ZERO,
    blinding = "0x0102030405060708",
    submit = true,
    amount = "100000"
  ) {
    const terms = {
      ...baseTerms,
      chainId: String((await ethers.provider.getNetwork()).chainId),
      bridge: bridge.address,
      bitcoinGenesis: ethers.utils.id("synthetic network"),
      fullWalletId: ID,
      descriptorHash,
      depositor: signer.address,
      vault: route,
      blinding,
      amount,
      refundKey: Q,
      refundLocktime:
        (await ethers.provider.getBlock("latest")).timestamp + 86400,
    }
    const result = await frost.frostDepositOutput(terms)
    const tx = {
      version: "0x02000000",
      inputVector: `0x01${entry(ethers.utils.id(blinding))}`,
      outputVector: `0x01${output(amount, result.key)}`,
      locktime: "0x00000000",
    }
    const hash = txHash(tx)
    const key = outpoint(hash)
    tracked.add(key)
    if (submit) await frost.connect(signer).revealFrostDeposit(terms, tx, 0)
    return { terms, tx, hash, key }
  }
  function sweep(
    hashes: string[],
    value = 99000,
    route = ZERO,
    change: any = {}
  ) {
    const transaction = {
      version: "0x02000000",
      inputVector: `0x${hashes.length.toString(16).padStart(2, "0")}${hashes
        .map((h) => entry(h))
        .join("")}`,
      outputVector: `0x01${output(value)}`,
      locktime: "0x00000000",
      ...change,
    }
    tracked.add(outpoint(txHash(transaction)))
    tracked.add(outpoint(txHash(transaction), 1))
    for (const hash of hashes) {
      tracked.add(outpoint(hash))
      tracked.add(outpoint(hash, 1))
    }
    return {
      walletId: ID,
      transaction,
      proof: syntheticProof(transaction),
      includeMain: false,
      vault: route,
    }
  }
  async function rejects(request: any, reason: string) {
    const before = await frame()
    await expect(frost.submitFrostDepositSweepProof(request)).revertedWith(
      reason
    )
    expect(await frame()).deep.eq(before)
  }
  async function recognizedMain() {
    const d = await reveal()
    const request = sweep([d.hash])
    await frost.submitFrostDepositSweepProof(request)
    const hash = txHash(request.transaction)
    const key = outpoint(hash)
    const main = await frost.frostCustodyOutput(key)
    expect(main.walletId).eq(ID)
    expect(main.value).eq(99000)
    expect(main.spent).eq(false)
    return { hash, key }
  }

  it("rejects a repeated recognized main after consuming a fresh deposit, with full rollback", async () => {
    const main = await recognizedMain()
    const d = await reveal(payer, ZERO, "0x0102030405060709")
    await rejects(
      { ...sweep([d.hash, main.hash, main.hash], 198000), includeMain: true },
      "FROST sweep main duplicate"
    )
  })
  it("rejects a synthetic wrong-wallet identity on an actually credited main", async () => {
    const main = await recognizedMain()
    const d = await reveal(payer, ZERO, "0x0102030405060709")
    // No normal credit can create this identity mismatch. Perturb only the
    // complete walletId word to isolate this defensive check, not qualification.
    await network.provider.send("hardhat_setStorageAt", [
      bridge.address,
      ethers.utils.hexValue(
        mappingSlots(["frostCustody", "outputs"], main.key)[0]
      ),
      ethers.utils.id("synthetic wrong main wallet"),
    ])
    await rejects(
      { ...sweep([d.hash, main.hash], 198000), includeMain: true },
      "FROST sweep main identity"
    )
  })
  it("rejects a synthetic spent identity on an actually credited main", async () => {
    const main = await recognizedMain()
    const d = await reveal(payer, ZERO, "0x0102030405060709")
    // Set only the custody spent bit: the shared spent bit stays clear so the
    // earlier shared-input guard does not shadow the main-identity check.
    await occupy(["frostCustody", "outputs"], main.key, "spent")
    await rejects(
      { ...sweep([d.hash, main.hash], 198000), includeMain: true },
      "FROST sweep main identity"
    )
  })
  it("rejects an includeMain input set that omits the recognized main, after prior deposit effects", async () => {
    await recognizedMain()
    const a = await reveal(payer, ZERO, "0x0102030405060709")
    const b = await reveal(second, ZERO, "0x010203040506070a")
    // The terminal input-set assertion is implied by the loop's earlier guards:
    // n inputs each consume either one deposit or the main; duplicate main is
    // forbidden and deposit capacity is n - includeMain. Without the main, the
    // nth deposit exceeds capacity and reverts here before the terminal check.
    // Successful loops therefore have exactly n - includeMain deposits and
    // mainFound == includeMain. Do not fabricate an independent terminal failure.
    await rejects(
      { ...sweep([a.hash, b.hash], 198000), includeMain: true },
      "FROST sweep deposit"
    )
  })
  it("accepts an aggregate deposit principal exactly at MAX_SATOSHI", async () => {
    const half = "1050000000000000"
    const a = await reveal(payer, ZERO, "0x0102030405060708", true, half)
    const b = await reveal(second, ZERO, "0x0102030405060709", true, half)
    const value = 2100000000000000 - 1000
    const request = sweep([a.hash, b.hash], value)
    await frost.submitFrostDepositSweepProof(request)
    const credit = ethers.BigNumber.from(half)
      .sub(ethers.BigNumber.from(half).div(100))
      .sub(500)
    expect(await bank.balanceOf(payer.address)).eq(credit)
    expect(await bank.balanceOf(second.address)).eq(credit)
    expect(await bank.balanceOf(treasury.address)).eq(
      ethers.BigNumber.from(half).div(100).mul(2)
    )
    expect(
      (await frost.frostCustodyOutput(outpoint(txHash(request.transaction))))
        .value
    ).eq(value)
    expect(
      (await bank.balanceOf(payer.address))
        .add(await bank.balanceOf(second.address))
        .add(await bank.balanceOf(treasury.address))
    ).eq(value)
  })
  it("rejects an aggregate deposit principal one satoshi above MAX_SATOSHI with full rollback", async () => {
    const a = await reveal(
      payer,
      ZERO,
      "0x0102030405060708",
      true,
      "1050000000000000"
    )
    const b = await reveal(
      second,
      ZERO,
      "0x0102030405060709",
      true,
      "1050000000000001"
    )
    await rejects(
      sweep([a.hash, b.hash], 2100000000000000),
      "FROST sweep total"
    )
  })
  it("includes recognized main value in the aggregate MAX_SATOSHI bound", async () => {
    const main = await recognizedMain()
    const d = await reveal(
      payer,
      ZERO,
      "0x0102030405060709",
      true,
      "2099999999901001"
    )
    await rejects(
      { ...sweep([d.hash, main.hash], 2100000000000000), includeMain: true },
      "FROST sweep total"
    )
  })

  it("uses the captured cap after governance raises the current cap; exact cap succeeds", async () => {
    const d = await reveal()
    await bridge.updateDepositParameters(10000, 50, 3000, 30)
    await rejects(sweep([d.hash], 97999), "FROST sweep fee capacity")
    await frost.submitFrostDepositSweepProof(sweep([d.hash], 98000))
    expect(await bank.balanceOf(payer.address)).eq(97000)
    expect(await bank.balanceOf(treasury.address)).eq(1000)
  })
  it("retains the captured cap after governance lowers it", async () => {
    const d = await reveal()
    await bridge.updateDepositParameters(10000, 100, 500, 30)
    await frost.submitFrostDepositSweepProof(sweep([d.hash], 98000))
    expect(await bank.balanceOf(payer.address)).eq(97000)
  })
  it("charges the fee remainder to the last deposit and consumes each only once", async () => {
    const a = await reveal()
    const b = await reveal(second, ZERO, "0x0102030405060709")
    const request = sweep([a.hash, b.hash], 198999)
    await frost.submitFrostDepositSweepProof(request)
    expect(await bank.balanceOf(payer.address)).eq(98500)
    expect(await bank.balanceOf(second.address)).eq(98499)
    expect(await bank.balanceOf(treasury.address)).eq(2000)
    expect(
      (await frost.frostCustodyOutput(outpoint(txHash(request.transaction))))
        .value
    ).eq(198999)
    await rejects(request, "FROST sweep main required")
    const repeated = sweep([a.hash, txHash(request.transaction)], 198000)
    await rejects(
      { ...repeated, includeMain: true },
      "FROST sweep input consumed"
    )
  })
  it("rejects the last deposit's remainder exceeding its own captured cap", async () => {
    const a = await reveal()
    await bridge.updateDepositParameters(10000, 100, 500, 30)
    const b = await reveal(second, ZERO, "0x0102030405060709")
    await rejects(sweep([a.hash, b.hash], 198999), "FROST sweep fee capacity")
  })
  it("binds the requested vault, mints through the actual trusted Vault, and rolls replay back", async () => {
    const d = await reveal(payer, vault.address)
    await rejects(sweep([d.hash]), "FROST sweep deposit")
    const request = sweep([d.hash], 99000, vault.address)
    await frost.submitFrostDepositSweepProof(request)
    expect(await bank.balanceOf(vault.address)).eq(98000)
    expect(await bank.balanceOf(payer.address)).eq(0)
    expect(await token.balanceOf(payer.address)).eq(
      ethers.BigNumber.from(98000).mul("10000000000")
    )
    expect(await bank.balanceOf(treasury.address)).eq(1000)
    await rejects(request, "FROST sweep main required")
  })
  it("falls back to depositor Bank credit after vault trust is revoked", async () => {
    const d = await reveal(payer, vault.address)
    await bridge.setVaultStatus(vault.address, false)
    await frost.submitFrostDepositSweepProof(
      sweep([d.hash], 99000, vault.address)
    )
    expect(await bank.balanceOf(payer.address)).eq(98000)
    expect(await bank.balanceOf(vault.address)).eq(0)
    expect(await token.totalSupply()).eq(0)
  })
  it("rolls back effects and Bank credit when the actual Vault callback cannot mint", async () => {
    const d = await reveal(payer, vault.address)
    await network.provider.send("hardhat_impersonateAccount", [vault.address])
    await network.provider.send("hardhat_setBalance", [
      vault.address,
      "0x1000000000000000000",
    ])
    await token
      .connect(await ethers.getSigner(vault.address))
      .transferOwnership(owner.address)
    await network.provider.send("hardhat_stopImpersonatingAccount", [
      vault.address,
    ])
    await rejects(
      sweep([d.hash], 99000, vault.address),
      "Ownable: caller is not the owner"
    )
  })
  const cases: [string, (d: any) => any, string][] = [
    [
      "version",
      (d) => sweep([d.hash], 99000, ZERO, { version: "0x01000000" }),
      "FROST sweep version",
    ],
    // BitcoinTx.validateVin has already validated every entry's wire length.
    // An empty-script input has the minimum width: 32 hash + 4 index + 1 length
    // + 4 sequence = 41 bytes. Any nonempty or extended script length increases
    // that width, so the fixed offset + count * 41 guard must fail first. No
    // valid shorter input can compensate. The subsequent scriptSig guard cannot
    // independently fail under these preceding checks; keep production intact.
    [
      "nonempty scriptSig via the earlier fixed-length guard",
      (d) =>
        sweep([d.hash], 99000, ZERO, {
          inputVector: `0x01${entry(d.hash, 0, "0151")}`,
        }),
      "FROST sweep input length",
    ],
    [
      "empty input set",
      (d) => sweep([d.hash], 99000, ZERO, { inputVector: "0x00" }),
      "Invalid input vector provided",
    ],
    [
      "truncated input",
      (d) =>
        sweep([d.hash], 99000, ZERO, {
          inputVector: `0x01${entry(d.hash).slice(0, -2)}`,
        }),
      "Invalid input vector provided",
    ],
    [
      "trailing input bytes",
      (d) =>
        sweep([d.hash], 99000, ZERO, { inputVector: `0x01${entry(d.hash)}00` }),
      "Invalid input vector provided",
    ],
    [
      "nonminimal input count",
      (d) =>
        sweep([d.hash], 99000, ZERO, {
          inputVector: `0xfd0100${entry(d.hash)}`,
        }),
      "FROST sweep count encoding",
    ],
    ...["fe01000000", "ff0100000000000000"].map(
      (encoding): [string, (d: any) => any, string] => [
        `nonminimal one-input count ${encoding}`,
        (d) =>
          sweep([d.hash], 99000, ZERO, {
            inputVector: `0x${encoding}${entry(d.hash)}`,
          }),
        "FROST sweep count encoding",
      ]
    ),
    [
      "129 inputs above the 128-input cap",
      (d) =>
        sweep([d.hash], 99000, ZERO, {
          inputVector: `0x81${entry(d.hash).repeat(129)}`,
        }),
      "FROST sweep inputs bound",
    ],
    // The bound precedes canonical CompactSize checking. Counts 253+ cannot
    // reach count encoding under the 128-input cap, whether minimally encoded
    // with fd or nonminimally encoded with fe/ff. Preserve these explicit forms
    // and expect the earlier bound rather than claim count-encoding coverage.
    ...["fdfd00", "fefd000000", "fffd00000000000000"].map(
      (encoding): [string, (d: any) => any, string] => [
        `253-input CompactSize ${encoding} via the earlier input bound`,
        (d) =>
          sweep([d.hash], 99000, ZERO, {
            inputVector: `0x${encoding}${entry(d.hash).repeat(253)}`,
          }),
        "FROST sweep inputs bound",
      ]
    ),
    [
      "257 inputs",
      (d) =>
        sweep([d.hash], 99000, ZERO, {
          inputVector: `0xfd0101${entry(d.hash).repeat(257)}`,
        }),
      "FROST sweep inputs bound",
    ],
    [
      "128 repeated inputs after passing the canonical count boundary",
      (d) =>
        sweep([d.hash], 99000, ZERO, {
          inputVector: `0x80${entry(d.hash).repeat(128)}`,
        }),
      "FROST sweep input consumed",
    ],
    [
      "unknown input",
      () => sweep([ethers.utils.id("unknown")]),
      "FROST sweep deposit",
    ],
    [
      "wrong outpoint index",
      (d) =>
        sweep([d.hash], 99000, ZERO, {
          inputVector: `0x01${entry(d.hash, 1)}`,
        }),
      "FROST sweep deposit",
    ],
    [
      "duplicate deposit input",
      (d) => sweep([d.hash, d.hash], 198000),
      "FROST sweep input consumed",
    ],
    [
      "unknown second input after writing the first deposit's consumption",
      (d) => sweep([d.hash, ethers.utils.id("unknown")]),
      "FROST sweep deposit",
    ],
    [
      "empty output set",
      (d) => sweep([d.hash], 99000, ZERO, { outputVector: "0x00" }),
      "Invalid output vector provided",
    ],
    [
      "two outputs",
      (d) =>
        sweep([d.hash], 99000, ZERO, {
          outputVector: `0x02${output(98000)}${output(1000)}`,
        }),
      "FROST sweep output count",
    ],
    [
      "wrong output key",
      (d) =>
        sweep([d.hash], 99000, ZERO, {
          outputVector: `0x01${output(99000, ethers.utils.id("wrong Q"))}`,
        }),
      "FROST sweep output key",
    ],
    [
      "wrong witness version",
      (d) =>
        sweep([d.hash], 99000, ZERO, {
          outputVector: `0x01${output(99000).replace("225120", "225020")}`,
        }),
      "FROST sweep output key",
    ],
    ["zero value", (d) => sweep([d.hash], 0), "FROST sweep value"],
    [
      "value above Bitcoin supply",
      (d) => sweep([d.hash], 2100000000000001),
      "FROST sweep value",
    ],
    ["inflation", (d) => sweep([d.hash], 100001), "FROST sweep inflation"],
    [
      "vault override",
      (d) => sweep([d.hash], 99000, vault.address),
      "FROST sweep deposit",
    ],
  ]
  for (const [name, request, reason] of cases)
    it(`rejects ${name} with the complete financial frame unchanged`, async () => {
      const d = await reveal()
      await rejects(request(d), reason)
    })
  it("rejects an includeMain claim without recognized main custody", async () => {
    const d = await reveal()
    await rejects(
      { ...sweep([d.hash, ethers.utils.id("fake main")]), includeMain: true },
      "FROST sweep main reserved"
    )
  })
  it("keeps FROST receipts absent from legacy records and rejects optimistic minting", async () => {
    const d = await reveal(payer, vault.address)
    expect((await bridge.deposits(d.key)).revealedAt).eq(0)
    const before = await frame()
    await expect(vault.requestOptimisticMint(d.hash, 0)).revertedWith(
      "The deposit has not been revealed"
    )
    expect(await frame()).deep.eq(before)
    await frost.submitFrostDepositSweepProof(
      sweep([d.hash], 99000, vault.address)
    )
    const afterSweep = await frame()
    await expect(vault.requestOptimisticMint(d.hash, 0)).revertedWith(
      "The deposit has not been revealed"
    )
    expect(await frame()).deep.eq(afterSweep)
  })
  it("rejects a synthetic legacy claim at the FROST reveal identity boundary", async () => {
    const d = await reveal(payer, ZERO, "0x0102030405060708", false)
    await occupy(["deposits"], d.key, "revealedAt")
    const before = await frame()
    await expect(
      frost.connect(payer).revealFrostDeposit(d.terms, d.tx, 0)
    ).revertedWith("FROST funding identity occupied")
    expect(await frame()).deep.eq(before)
  })
  it("rejects a synthetic legacy overlap after recognizing the sweep deposit", async () => {
    const d = await reveal()
    await occupy(["deposits"], d.key, "revealedAt")
    await rejects(sweep([d.hash]), "FROST sweep legacy identity")
  })
  it("rejects a synthetic spent funding input without minting or consumption effects", async () => {
    const d = await reveal()
    await occupy(["spentMainUTXOs"], d.key)
    await rejects(sweep([d.hash]), "FROST sweep input consumed")
  })
  it("rolls back deposit consumption when a synthetic output tombstone already exists", async () => {
    const d = await reveal()
    const request = sweep([d.hash])
    await occupy(["spentMainUTXOs"], outpoint(txHash(request.transaction)))
    await rejects(request, "FROST sweep output consumed")
  })
  it("rejects legacy reveal of a FROST funding output at its legacy script check", async () => {
    const d = await reveal()
    const y =
      "0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8"
    await bridge.__ecdsaWalletCreatedCallback(
      ethers.utils.id("F3 legacy wallet"),
      Q,
      y
    )
    const label = ethers.utils.ripemd160(
      ethers.utils.sha256(`0x02${Q.slice(2)}`)
    )
    legacyLabels.add(label)
    const before = await frame()
    await expect(
      bridge.connect(payer).revealDeposit(d.tx, {
        fundingOutputIndex: 0,
        blindingFactor: d.terms.blinding,
        walletPubKeyHash: label,
        refundPubKeyHash: label,
        refundLocktime: toHex(unsigned(d.terms.refundLocktime, 4, true)),
        vault: ZERO,
      })
    ).revertedWith("Wrong script hash length")
    expect(await frame()).deep.eq(before)
    expect((await bridge.deposits(d.key)).revealedAt).eq(0)
  })
  it("rejects legacy P2WSH on FROST routes and a synthetic FROST claim on legacy reveal", async () => {
    const d = await reveal()
    const y =
      "0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8"
    await bridge.__ecdsaWalletCreatedCallback(
      ethers.utils.id("F3 legacy wallet"),
      Q,
      y
    )
    const label = ethers.utils.ripemd160(
      ethers.utils.sha256(`0x02${Q.slice(2)}`)
    )
    legacyLabels.add(label)
    const locktime = toHex(unsigned(d.terms.refundLocktime, 4, true))
    const script = `0x14${payer.address.slice(2)}7508${d.terms.blinding.slice(
      2
    )}7576a914${label.slice(2)}8763ac6776a914${label.slice(
      2
    )}8804${locktime.slice(2)}b175ac68`
    const legacy = {
      ...d.tx,
      outputVector: `0x01${toHex(unsigned(100000, 8, true)).slice(
        2
      )}220020${ethers.utils.sha256(script).slice(2)}`,
    }
    const hash = txHash(legacy)
    const key = outpoint(hash)
    tracked.add(key)
    await bridge.connect(payer).revealDeposit(legacy, {
      fundingOutputIndex: 0,
      blindingFactor: d.terms.blinding,
      walletPubKeyHash: label,
      refundPubKeyHash: label,
      refundLocktime: locktime,
      vault: ZERO,
    })
    expect((await bridge.deposits(key)).revealedAt).not.eq(0)
    const before = await frame()
    await expect(
      frost.connect(payer).revealFrostDeposit(d.terms, legacy, 0)
    ).revertedWith("FROST funding script")
    expect(await frame()).deep.eq(before)
    await rejects(sweep([hash]), "FROST sweep deposit")
    // Isolate the legacy shared-claim guard with a synthetic FROST tombstone on
    // this real legacy deposit. Valid legacy script checks execute first.
    await occupy(["frostFunding", "deposits"], key, "revealedAt")
    const occupied = await frame()
    await expect(
      bridge.connect(payer).revealDeposit(legacy, {
        fundingOutputIndex: 0,
        blindingFactor: d.terms.blinding,
        walletPubKeyHash: label,
        refundPubKeyHash: label,
        refundLocktime: locktime,
        vault: ZERO,
      })
    ).revertedWith("Funding outpoint claimed by FROST")
    expect(await frame()).deep.eq(occupied)
  })
})
