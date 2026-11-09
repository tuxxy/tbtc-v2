/* eslint-disable no-await-in-loop, no-restricted-syntax, no-underscore-dangle */
// Remediation batch 14. Refs tuxxy/tbtc-v2#63 (FSM analysis F-1, P3;
// K-09-restart/fsm-analysis/contracts.md, "One canonical view already exists").
//
// Invariant: for every FROST wallet, `isFrostFundingTarget(label)` answers
// exactly the wallet-level part of FROST deposit admission, through one helper
// shared with admission.
//
// The wallet-level part (what the view covers) is
//   state in {ReadyUnfunded, Live} && !quarantined && capabilityVersion > 0.
// The per-deposit part (what the view does NOT cover, because it depends on the
// deposit's terms or on global configuration) is: the full 32-byte wallet id
// and descriptor hash in the terms, chain/bridge/genesis binding, vault trust,
// refund locktime, verifier identity, curve-key validity of the refund and
// wallet keys under the configured verifier, the tap tweak, and the global
// address/reveal gates and exposure containment.
//
// Cases:
// - REAL: wallets reached through the public registry callbacks (FIXTURE
//   registry, as every FROST component test): RegisteredPendingReady,
//   ReadyUnfunded, Closed (expired).
// - MATRIX: every FrostWallets.State value x quarantined {false, true} x
//   capabilityVersion {0, 1, 2^32-1}. FIXTURE: the three fields are written
//   into the real ReadyUnfunded wallet's storage (slot from the compiler's
//   storage layout); both the view and admission read the same storage, and no
//   success claim rests on the injected state being reachable.
// - Admission is the reference: both admission entrypoints that run the wallet
//   check (`frostDepositOutput`, `revealFrostDeposit` via eth_call) must answer
//   the rule above, so making the two agree by narrowing admission fails.
// - SHARED: the view's dispatch branch and `validateTerms` call one common FROST
//   library function and neither compares wallet states inline.
// - CONSTRAINTS (issue and brief): no Bridge or MovingFunds bytes added, Bridge
//   storage layout unchanged.
import { artifacts, ethers, network } from "hardhat"
import { expect } from "chai"
import fs from "fs"
import path from "path"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import * as secp from "@noble/secp256k1"
import {
  baseTerms,
  encodeProfile,
  fromHex,
  NUMS,
  tagged,
  Terms,
  toHex,
  unsigned,
} from "../data/frost/deposit-profile"

const TYPE =
  "tuple(uint8 scheme,uint8 profile,uint256 chainId,address registry,uint64 epoch,uint32[] members,address[] operators,uint16 threshold,bytes32 snowfallDescriptor,bytes32 outputKey)"
const WALLET_TYPE = `tuple(${TYPE} descriptor,bytes32 id,bytes32 descriptorHash,uint64 deadline,uint8 state,bool quarantined,uint32 generation,uint32 capabilityVersion)`
const Q = "0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
const ID = ethers.utils.keccak256(
  ethers.utils.concat([ethers.utils.id("tbtc-v2/frost-wallet-id/v1"), Q])
)
const LABEL = ID.slice(0, 42)
const STATES = [
  "Unknown",
  "Candidate",
  "RegisteredPendingReady",
  "ReadyUnfunded",
  "Live",
  "MovingFunds",
  "Closing",
  "Closed",
  "Terminated",
]
const CAPABILITY_VERSIONS = [0, 1, 2 ** 32 - 1]
const WALLET_REFUSAL = "FROST deposit wallet"
// Sizes at tbtc-v2 integration/frost-base 39412825 (REMEDIATION.md, batch 8
// fix): the fix must not add bytes to either (55 B and 43 B spare).
const BRIDGE_BYTES = 24521
const MOVING_FUNDS_BYTES = 24533
const LAYOUT_FILE = path.join(
  __dirname,
  "bridge-storage-layout.base-39412825.json"
)
const SOLIDITY = path.join(__dirname, "..", "..")

// The wallet-level admission rule (FrostDepositAdmission.validateTerms at
// 39412825, lines 220-227, minus the per-deposit id/descriptor terms).
function rule(state: number, quarantined: boolean, capabilityVersion: number) {
  return (
    (STATES[state] === "ReadyUnfunded" || STATES[state] === "Live") &&
    !quarantined &&
    capabilityVersion > 0
  )
}

// The P2TR deposit output key: NUMS internal key tweaked by the profile root.
function depositOutputKey(t: Terms): string {
  const profile = encodeProfile(t, Q)
  const tweak = BigInt(
    toHex(
      tagged("TapTweak", Buffer.concat([fromHex(NUMS), fromHex(profile.root)]))
    )
  )
  if (tweak >= secp.CURVE.n) throw Error("harness: tweak out of range")
  const point = secp.Point.fromHex(`02${NUMS.slice(2)}`).add(
    secp.Point.BASE.multiply(tweak)
  )
  return `0x${point.x.toString(16).padStart(64, "0")}`
}

// Real recursive library links under the EIP-170 limit (as
// Frost.FundingDispatch.test.ts).
async function deploy(
  name: string,
  args: unknown[] = [],
  cache = new Map<string, string>()
): Promise<any> {
  const artifact = await artifacts.readArtifact(name)
  let { bytecode } = artifact
  for (const [source, libraries] of Object.entries(artifact.linkReferences)) {
    for (const [library, positions] of Object.entries(libraries)) {
      const key = `${source}:${library}`
      if (!cache.has(key))
        cache.set(key, (await deploy(key, [], cache)).address)
      for (const position of positions)
        bytecode =
          bytecode.slice(0, 2 + position.start * 2) +
          cache.get(key)!.slice(2) +
          bytecode.slice(2 + (position.start + position.length) * 2)
    }
  }
  const [signer] = await ethers.getSigners()
  const contract = await new ethers.ContractFactory(
    artifact.abi,
    bytecode,
    signer
  ).deploy(...args)
  await contract.deployed()
  expect(
    (await ethers.provider.getCode(contract.address)).length / 2 - 1,
    name
  ).to.be.at.most(24576)
  return contract
}

async function bridgeLayout() {
  const info: any = await artifacts.getBuildInfo(
    "contracts/bridge/Bridge.sol:Bridge"
  )
  return info.output.contracts["contracts/bridge/Bridge.sol"].Bridge
    .storageLayout
}

// Canonical Bridge storage layout without compiler AST ids, so that a source
// change that keeps storage keeps the same description.
function canonicalLayout(layout: any) {
  const seen = new Map<string, any>()
  const describe = (id: string): any => {
    if (seen.has(id)) return seen.get(id)
    const t = layout.types[id]
    const out: any = {
      label: t.label,
      encoding: t.encoding,
      numberOfBytes: t.numberOfBytes,
    }
    seen.set(id, out)
    if (t.members)
      out.members = t.members.map((m: any) => ({
        label: m.label,
        slot: m.slot,
        offset: m.offset,
        type: describe(m.type),
      }))
    if (t.key) out.key = describe(t.key)
    if (t.value) out.value = describe(t.value)
    if (t.base) out.base = describe(t.base)
    return out
  }
  return layout.storage.map((s: any) => ({
    label: s.label,
    slot: s.slot,
    offset: s.offset,
    type: describe(s.type),
  }))
}

// FIXTURE: storage writer for the wallet-level fields of the FROST wallet at
// LABEL, located through the compiler's storage layout (no hard-coded slots).
async function walletFieldWriter(bridgeAddress: string) {
  const layout = await bridgeLayout()
  const self = layout.storage.find((s: any) => s.label === "self")
  const bridgeState = layout.types[self.type]
  const frost = bridgeState.members.find((m: any) => m.label === "frost")
  const frostStorage = layout.types[frost.type]
  const wallets = frostStorage.members.find((m: any) => m.label === "wallets")
  const wallet = layout.types[layout.types[wallets.type].value]
  const mappingSlot = ethers.BigNumber.from(self.slot)
    .add(frost.slot)
    .add(wallets.slot)
  const entry = ethers.BigNumber.from(
    ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes20", "uint256"],
        [LABEL, mappingSlot]
      )
    )
  )
  return async (field: string, value: number | boolean) => {
    const member = wallet.members.find((m: any) => m.label === field)
    const bytes = Number(layout.types[member.type].numberOfBytes)
    const slot = ethers.utils.hexZeroPad(
      entry.add(member.slot).toHexString(),
      32
    )
    const original = ethers.BigNumber.from(
      await ethers.provider.getStorageAt(bridgeAddress, slot)
    )
    const mask = ethers.BigNumber.from(2)
      .pow(bytes * 8)
      .sub(1)
      .shl(member.offset * 8)
    const next = original
      .and(ethers.constants.MaxUint256.xor(mask))
      .or(ethers.BigNumber.from(Number(value)).shl(member.offset * 8))
    await network.provider.send("hardhat_setStorageAt", [
      bridgeAddress,
      slot,
      ethers.utils.hexZeroPad(next.toHexString(), 32),
    ])
  }
}

type Answer = { admitted: boolean; reason?: string }

function revertReason(error: any): string {
  const text = String(error?.message ?? error)
  const match = text.match(/reverted with reason string ['"]([^'"]*)['"]/)
  return match ? match[1] : text.slice(0, 200)
}

describe("B14 isFrostFundingTarget agrees with FROST deposit admission (tuxxy/tbtc-v2#63)", () => {
  let frost: any
  let bridgeAddress: string
  let registry: any
  let depositor: SignerWithAddress
  let terms: Terms
  let fundingTx: any
  let write: (field: string, value: number | boolean) => Promise<void>
  let pendingSnapshot: string
  let descriptorHash: string
  let deadline: number

  before(async function world() {
    this.timeout(60000)
    const [governance, other, treasury, seedDepositor] =
      await ethers.getSigners()
    depositor = seedDepositor
    const bank = await deploy("Bank")
    const implementation = await deploy("Bridge")
    const admin = await deploy("ProxyAdmin")
    // Placeholder relay/wallet registry/reimbursement pool: no legacy path runs.
    const data = implementation.interface.encodeFunctionData("initialize", [
      bank.address,
      other.address,
      treasury.address,
      other.address,
      other.address,
      1,
    ])
    const proxy = await deploy("TransparentUpgradeableProxy", [
      implementation.address,
      admin.address,
      data,
    ])
    await bank.updateBridge(proxy.address)
    bridgeAddress = proxy.address
    frost = await ethers.getContractAt("IFrostBridge", proxy.address)

    // Funding configured and open before any wallet exists.
    const verifier = await deploy("FrostVerifier")
    const genesis = ethers.utils.id("b14 local bitcoin genesis")
    await frost.configureFrostFunding(
      verifier.address,
      ethers.utils.keccak256(await ethers.provider.getCode(verifier.address)),
      ethers.utils.id("UNQUALIFIED b14 local installation reference"),
      genesis
    )
    const exposure = await deploy("FrostExposureController", [
      proxy.address,
      governance.address,
    ])
    const maxUint64 = ethers.BigNumber.from(2).pow(64).sub(1)
    await exposure.openBudgetPeriod(
      maxUint64,
      maxUint64,
      ethers.utils.id("b14 test budget; D-10 OPEN")
    )
    await frost.installFrostExposureController(exposure.address)
    await frost.setFrostFundingGates(true, true)

    // FIXTURE registry (callback boundary only), real Bridge callbacks.
    registry = await deploy(
      "contracts/test/FrostRegistryFixture.sol:FrostRegistryFixture",
      [proxy.address]
    )
    await frost.configureFrostRegistry(registry.address)
    const [a, b, c] = await ethers.getSigners()
    const d = {
      scheme: 2,
      profile: 1,
      chainId: (await ethers.provider.getNetwork()).chainId,
      registry: registry.address,
      epoch: await ethers.provider.getBlockNumber(),
      members: [1, 2, 3],
      operators: [a.address, b.address, c.address],
      threshold: 2,
      snowfallDescriptor: ethers.utils.id("b14-local-vector"),
      outputKey: Q,
    }
    deadline = (await ethers.provider.getBlockNumber()) + 20
    await registry.created(
      ethers.utils.defaultAbiCoder.encode([TYPE], [d]),
      deadline
    )
    descriptorHash = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", TYPE],
        [ethers.utils.id("tbtc-v2/frost-descriptor/v1"), d]
      )
    )
    terms = {
      ...baseTerms,
      chainId: (await ethers.provider.getNetwork()).chainId.toString(),
      bridge: proxy.address,
      bitcoinGenesis: genesis,
      fullWalletId: ID,
      descriptorHash,
      depositor: depositor.address,
      vault: ethers.constants.AddressZero,
      amount: "10000000",
      refundKey: Q,
      refundLocktime:
        (await ethers.provider.getBlock("latest")).timestamp + 30 * 86400,
    }
    pendingSnapshot = await ethers.provider.send("evm_snapshot", [])
    // The funding transaction pays the exact deposit output for these terms,
    // computed independently of the contract (as Frost.DepositAdmission.test.ts).
    const key = depositOutputKey(terms)
    fundingTx = {
      version: "0x02000000",
      inputVector: `0x01${"11".repeat(32)}0000000000ffffffff`,
      outputVector: `0x01${toHex(unsigned(terms.amount, 8, true)).slice(
        2
      )}225120${key.slice(2)}`,
      locktime: "0x00000000",
    }
    write = await walletFieldWriter(proxy.address)
  })

  // One snapshot (wallet RegisteredPendingReady); "ready" replays the real
  // ready callback on top of it.
  async function restore(which: "pending" | "ready") {
    expect(
      await ethers.provider.send("evm_revert", [pendingSnapshot]),
      "harness: snapshot revert"
    ).eq(true)
    pendingSnapshot = await ethers.provider.send("evm_snapshot", [])
    if (which === "ready") await registry.ready(ID, descriptorHash)
  }

  async function wallet() {
    return ethers.utils.defaultAbiCoder.decode(
      [WALLET_TYPE],
      await frost.walletDescriptor(LABEL)
    )[0]
  }

  async function admission(): Promise<Record<string, Answer>> {
    const answers: Record<string, Answer> = {}
    const calls: [string, () => Promise<unknown>][] = [
      ["frostDepositOutput", () => frost.frostDepositOutput(terms)],
      [
        "revealFrostDeposit",
        () =>
          frost
            .connect(depositor)
            .callStatic.revealFrostDeposit(terms, fundingTx, 0),
      ],
    ]
    for (const [name, call] of calls) {
      try {
        await call()
        answers[name] = { admitted: true }
      } catch (error) {
        answers[name] = { admitted: false, reason: revertReason(error) }
      }
    }
    return answers
  }

  // Checks one wallet: admission answers the wallet-level rule (admission is
  // the reference), then the view agrees with it.
  async function agree() {
    const w = await wallet()
    const label = `state=${STATES[w.state]}, quarantined=${
      w.quarantined
    }, capabilityVersion=${w.capabilityVersion}`
    const expected = rule(w.state, w.quarantined, w.capabilityVersion)
    const answers = await admission()
    for (const [name, answer] of Object.entries(answers)) {
      if (!answer.admitted)
        expect(
          answer.reason,
          `harness: ${name} refused for a non-wallet reason at ${label}`
        ).eq(WALLET_REFUSAL)
      expect(
        answer.admitted,
        `F-1 admission rule: ${name} answered ${answer.admitted} for ${label}, the wallet-level rule says ${expected}`
      ).eq(expected)
    }
    const view = await frost.isFrostFundingTarget(LABEL)
    expect(
      view,
      `F-1: isFrostFundingTarget disagrees with FROST deposit admission for ${label}: view=${view}, admission=${expected}`
    ).eq(expected)
  }

  describe("REAL: wallets reached through the registry callbacks", () => {
    it("RegisteredPendingReady (capabilityVersion 0): refused by both", async () => {
      await restore("pending")
      expect((await wallet()).state).eq(2)
      await agree()
    })

    it("ReadyUnfunded after the ready callback: admitted by both", async () => {
      await restore("ready")
      const w = await wallet()
      expect(w.state, "setup: ready callback").eq(3)
      expect(w.capabilityVersion, "setup: ready callback").eq(1)
      expect(w.quarantined, "setup: ready callback").eq(false)
      await agree()
    })

    it("Closed after expiry: refused by both", async () => {
      await restore("pending")
      const now = await ethers.provider.getBlockNumber()
      await network.provider.send("hardhat_mine", [
        `0x${(deadline - now).toString(16)}`,
      ])
      await registry.expire(ID)
      expect((await wallet()).state, "setup: expiry callback").eq(7)
      await agree()
    })
  })

  describe("MATRIX (FIXTURE: storage-injected state, quarantined, capabilityVersion)", () => {
    const cases = STATES.flatMap((_, state) =>
      [false, true].flatMap((quarantined) =>
        CAPABILITY_VERSIONS.map((capabilityVersion) => ({
          state,
          quarantined,
          capabilityVersion,
        }))
      )
    )
    cases.forEach(({ state, quarantined, capabilityVersion }) =>
      it(`${STATES[state]}, quarantined=${quarantined}, capabilityVersion=${capabilityVersion}`, async () => {
        await restore("ready")
        await write("state", state)
        await write("quarantined", quarantined)
        await write("capabilityVersion", capabilityVersion)
        const w = await wallet()
        expect(
          [w.state, w.quarantined, w.capabilityVersion],
          "FIXTURE: injected wallet fields did not read back"
        ).deep.eq([state, quarantined, capabilityVersion])
        expect(w.id, "FIXTURE: wallet identity changed").eq(ID)
        await agree()
      })
    )
  })

  describe("SHARED: one helper", () => {
    function source(file: string) {
      return fs.readFileSync(path.join(SOLIDITY, "contracts", file), "utf8")
    }
    // Function names declared in the FROST contracts (contracts/frost).
    function declared() {
      const dir = path.join(SOLIDITY, "contracts", "frost")
      const names = new Set<string>()
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sol")))
        for (const m of source(path.join("frost", f)).matchAll(
          /\bfunction\s+(\w+)\s*\(/g
        ))
          names.add(m[1])
      return names
    }
    // The FROST functions called in a code excerpt, by name.
    function calls(text: string) {
      const frostNames = declared()
      return new Set(
        [...text.matchAll(/\b(\w+)\s*\(/g)]
          .map((m) => m[1])
          .filter((name) => frostNames.has(name))
      )
    }

    it("the view's dispatch branch and validateTerms call one common FROST library function and compare no wallet state inline", async () => {
      // The view stays in a FROST library dispatch (no Bridge bytes may be
      // added), so it is found by its selector in contracts/frost.
      const frostDir = path.join(SOLIDITY, "contracts", "frost")
      const hits = fs
        .readdirSync(frostDir)
        .filter((f) => f.endsWith(".sol"))
        .map((f) => [f, source(path.join("frost", f))])
        .filter(([, text]) => text.includes("isFrostFundingTarget.selector"))
      expect(hits.length, "SHARED: isFrostFundingTarget dispatch").eq(1)
      const [viewFile, viewText] = hits[0]
      const start = viewText.indexOf("isFrostFundingTarget.selector")
      const tail = viewText.slice(
        start + "isFrostFundingTarget.selector".length
      )
      const next = tail.search(/\}\s*else|\.selector|\n {4}function |\n}/)
      const viewBranch = tail.slice(0, next < 0 ? undefined : next)

      const admissionText = source("frost/FrostDepositAdmission.sol")
      const vt = admissionText.indexOf("function validateTerms(")
      expect(vt, "SHARED: validateTerms present").gte(0)
      const vtTail = admissionText.slice(vt + 1)
      const vtEnd = vtTail.search(/\n {4}function |\n}/)
      const validateTerms = vtTail.slice(0, vtEnd < 0 ? undefined : vtEnd)

      const inline =
        /State\s*\.\s*(Unknown|Candidate|RegisteredPendingReady|ReadyUnfunded|Live|MovingFunds|Closing|Closed|Terminated)\b/
      expect(
        inline.test(viewBranch),
        `F-1 shared helper: the isFrostFundingTarget branch in ${viewFile} compares wallet states inline instead of calling the helper admission uses`
      ).eq(false)
      expect(
        inline.test(validateTerms),
        "F-1 shared helper: FrostDepositAdmission.validateTerms compares wallet states inline instead of calling the helper the view uses"
      ).eq(false)
      const viewCalls = calls(viewBranch)
      const shared = [...calls(validateTerms)].filter((name) =>
        viewCalls.has(name)
      )
      expect(
        shared.length,
        "F-1 shared helper: the view and validateTerms call no common function"
      ).gt(0)
    })
  })

  describe("CONSTRAINTS", () => {
    it("adds no Bridge or MovingFunds bytes", async () => {
      for (const [name, limit] of [
        ["contracts/bridge/Bridge.sol:Bridge", BRIDGE_BYTES],
        ["contracts/bridge/MovingFunds.sol:MovingFunds", MOVING_FUNDS_BYTES],
      ] as [string, number][]) {
        const a = await artifacts.readArtifact(name)
        expect(
          (a.deployedBytecode.length - 2) / 2,
          `F-1 constraint: ${name} grew past its 39412825 size`
        ).at.most(limit)
      }
    })

    it("keeps the Bridge storage layout", async () => {
      const actual = canonicalLayout(await bridgeLayout())
      if (process.env.B14_WRITE_LAYOUT === "true")
        fs.writeFileSync(LAYOUT_FILE, `${JSON.stringify(actual, null, 1)}\n`)
      const recorded = JSON.parse(fs.readFileSync(LAYOUT_FILE, "utf8"))
      expect(
        actual,
        "F-1 constraint: the Bridge storage layout differs from 39412825"
      ).deep.eq(recorded)
    })
  })
})
