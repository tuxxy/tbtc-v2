/* eslint-disable no-await-in-loop, no-restricted-syntax */
import { ethers } from "hardhat"
import { expect } from "chai"
import { Contract } from "ethers"
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

// Component scope: wallets/configuration are seeded, while key validation and
// output construction execute the real C-07 FrostVerifier, never a predicate stub.
describe("C-05 deposit admission component (seeded readiness/configuration)", () => {
  const Q = "0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
  const id = ethers.utils.id("admission-wallet")
  const descriptor = ethers.utils.id("admission-descriptor")
  const genesis = ethers.utils.id("component-bitcoin-genesis")
  const gasLimit = 12000000
  let f: Contract
  let v: Contract
  let depositor: SignerWithAddress
  let other: SignerWithAddress
  let terms: Terms
  let snapshot: string

  before(async () => {
    const [seedDepositor, seedOther] = await ethers.getSigners()
    depositor = seedDepositor
    other = seedOther
    v = await (await ethers.getContractFactory("FrostVerifier")).deploy()
    await v.deployed()
    const library = await (
      await ethers.getContractFactory("FrostDepositAdmission")
    ).deploy()
    await library.deployed()
    f = await (
      await ethers.getContractFactory("FrostDepositAdmissionFixture", {
        libraries: { FrostDepositAdmission: library.address },
      })
    ).deploy()
    await f.deployed()
    await f.seedConfiguration(v.address, genesis)
    await f.seedWallet(id, descriptor, Q, 3, false, 1)
    terms = {
      ...baseTerms,
      chainId: (await ethers.provider.getNetwork()).chainId.toString(),
      bridge: f.address,
      bitcoinGenesis: genesis,
      fullWalletId: id,
      descriptorHash: descriptor,
      depositor: depositor.address,
      vault: ethers.constants.AddressZero,
      amount: "100000",
      refundKey: Q,
      refundLocktime:
        (await ethers.provider.getBlock("latest")).timestamp + 86400,
    }
    snapshot = await ethers.provider.send("evm_snapshot", [])
  })
  beforeEach(async () => {
    await ethers.provider.send("evm_revert", [snapshot])
    snapshot = await ethers.provider.send("evm_snapshot", [])
  })

  function expected(t = terms) {
    const profile = encodeProfile(t, Q)
    const tweak = BigInt(
      toHex(
        tagged(
          "TapTweak",
          Buffer.concat([fromHex(NUMS), fromHex(profile.root)])
        )
      )
    )
    if (tweak >= secp.CURVE.n) throw Error("independent tweak out of range")
    const p = secp.Point.fromHex(`02${NUMS.slice(2)}`)
    const point = tweak === 0n ? p : p.add(secp.Point.BASE.multiply(tweak))
    if (point.equals(secp.Point.ZERO)) throw Error("independent infinity")
    return {
      ...profile,
      key: `0x${point.x.toString(16).padStart(64, "0")}`,
      parity: Number(point.y % 2n),
    }
  }
  function transaction(t = terms, script?: string, amount = t.amount) {
    return {
      version: "0x02000000",
      inputVector: `0x01${"11".repeat(32)}0000000000ffffffff`,
      outputVector: `0x01${toHex(unsigned(amount, 8, true)).slice(2)}${
        script || `225120${expected(t).key.slice(2)}`
      }`,
      locktime: "0x00000000",
    }
  }
  function identity(tx: ReturnType<typeof transaction>, index = 0) {
    const txHash = ethers.utils.sha256(
      ethers.utils.sha256(
        ethers.utils.hexConcat([
          tx.version,
          tx.inputVector,
          tx.outputVector,
          tx.locktime,
        ])
      )
    )
    return {
      txHash,
      outpoint: ethers.utils.solidityKeccak256(
        ["bytes32", "uint32"],
        [txHash, index]
      ),
    }
  }
  async function rejects(
    t: Terms,
    tx: ReturnType<typeof transaction>,
    reason: string,
    index = 0,
    signer = depositor
  ) {
    const { outpoint } = identity(tx, index)
    const before = await f.frame(outpoint, t.fullWalletId)
    await expect(
      f.connect(signer).reveal(t, tx, index, { gasLimit })
    ).revertedWith(reason)
    expect(await f.frame(outpoint, t.fullWalletId)).eq(before)
    // The whole frame includes the complete deposit, pending counter and entered.
  }

  it("admits the independently computed exact P2TR output and captures every receipt/fee field", async () => {
    const e = expected()
    const result = await f.output(terms, { gasLimit })
    expect(result.key).eq(e.key)
    expect(result.root).eq(e.root)
    expect(result.parity).eq(e.parity)
    const tx = transaction()
    const { outpoint, txHash } = identity(tx)
    // Library event is emitted at the fixture's delegatecall address.
    const mined = await (
      await f.connect(depositor).reveal(terms, tx, 0, { gasLimit })
    ).wait()
    const iface = (await ethers.getContractFactory("FrostDepositAdmission"))
      .interface
    const event = iface.parseLog(mined.logs[0])
    expect(event.name).eq("FrostDepositRevealed")
    expect(event.args.outpoint).eq(outpoint)
    expect(event.args.walletId).eq(id)
    expect(event.args.depositor).eq(depositor.address)
    expect(event.args.receipt).eq(e.receipt)
    expect(event.args.amount).eq(100000)
    const d = await f.deposit(outpoint)
    for (const [key, value] of Object.entries(terms)) {
      const actual = d.terms[key]
      expect(actual.toString().toLowerCase(), key).eq(
        value.toString().toLowerCase()
      )
    }
    expect(d.receipt).eq(e.receipt)
    expect(d.fundingTransactionHash).eq(txHash)
    expect(d.fundingOutputIndex).eq(0)
    expect(d.depositOutputKey).eq(e.key)
    expect(d.merkleRoot).eq(e.root)
    expect(d.outputParity).eq(e.parity)
    expect(d.treasuryFee).eq(1000)
    expect(d.maximumSweepFee).eq(100)
    expect(d.revealedAt).eq(
      (await ethers.provider.getBlock(mined.blockNumber)).timestamp
    )
    expect(d.sweptAt).eq(0)
    expect(await f.pending(id)).eq(1)
    expect(await f.entered()).eq(false)
    await f.fees(1000, 2, 999)
    expect((await f.deposit(outpoint)).treasuryFee).eq(1000)
    expect((await f.deposit(outpoint)).maximumSweepFee).eq(100)
  })

  function checkConstruction(
    c: Awaited<ReturnType<typeof f.construction>>,
    e = expected()
  ) {
    expect(c.output.key).eq(e.key)
    expect(c.output.root).eq(e.root)
    expect(c.output.parity).eq(e.parity)
    expect(c.receipt).eq(e.receipt)
    expect(c.walletLeaf).eq(e.walletLeaf)
    expect(c.refundLeaf).eq(e.refundLeaf)
    expect(c.walletControl).eq(
      e.parity === 0 ? e.walletControlEven : e.walletControlOdd
    )
    expect(c.refundControl).eq(
      e.parity === 0 ? e.refundControlEven : e.refundControlOdd
    )
    expect(ethers.utils.hexDataLength(c.walletControl)).eq(65)
    expect(ethers.utils.hexDataLength(c.refundControl)).eq(65)
  }

  it("exposes exact reference leaves and parity-bound control blocks before funding", async () => {
    const tx = transaction()
    const { outpoint } = identity(tx)
    const before = await f.frame(outpoint, id)
    checkConstruction(await f.construction(terms, { gasLimit }))
    expect(await f.frame(outpoint, id)).eq(before)
    expect((await f.deposit(outpoint)).revealedAt).eq(0)
    expect(await f.pending(id)).eq(0)
    await expect(f.refundConstruction(outpoint)).revertedWith(
      "FROST deposit unknown"
    )
  })

  it("keeps captured refund construction available with all gates paused and verifier zero", async () => {
    const tx = transaction()
    const { outpoint } = identity(tx)
    const advertised = await f.construction(terms, { gasLimit })
    await f.reveal(terms, tx, 0, { gasLimit })
    expect((await f.deposit(outpoint)).walletKey).eq(Q)
    checkConstruction(await f.refundConstruction(outpoint))
    await f.gates(false, false)
    await f.verifierIdentity(
      ethers.constants.AddressZero,
      ethers.constants.HashZero
    )
    // Current descriptor key/eligibility changes must not rewrite historical leaves.
    await f.seedWallet(
      id,
      ethers.utils.id("replacement-descriptor"),
      `0x${"ff".repeat(32)}`,
      7,
      true,
      0
    )
    await expect(f.construction(terms, { gasLimit })).revertedWith(
      "FROST addresses disabled"
    )
    await rejects(terms, tx, "FROST reveal disabled")
    const before = await f.frame(outpoint, id)
    const historical = await f.connect(other).refundConstruction(outpoint)
    checkConstruction(historical)
    expect(historical).deep.eq(advertised)
    expect(await f.frame(outpoint, id)).eq(before)
    expect((await f.deposit(outpoint)).walletKey).eq(Q)
  })

  it("rejects mismatched values, length, witness version and output key atomically", async () => {
    await rejects(
      terms,
      transaction(terms, undefined, "100001"),
      "FROST funding value"
    )
    await rejects(
      terms,
      transaction(terms, `215120${"11".repeat(31)}`),
      "FROST funding output length"
    )
    await rejects(
      terms,
      transaction(terms, `225020${expected().key.slice(2)}`),
      "FROST funding script"
    )
    await rejects(
      terms,
      transaction(terms, `225120${Q.slice(2)}`),
      "FROST funding script"
    )
  })

  it("rejects reuse of an output after changing receipt or refund terms", async () => {
    const tx = transaction()
    for (const update of [
      { blinding: "0x0102030405060709" },
      { extraData: ethers.utils.id("changed-metadata") },
      { refundLocktime: terms.refundLocktime + 1 },
      {
        refundKey: toHex(
          Buffer.from(secp.schnorr.getPublicKey("03".padStart(64, "0")))
        ),
      },
      { depositor: other.address },
    ]) {
      const t = { ...terms, ...update }
      await rejects(
        t,
        tx,
        "FROST funding script",
        0,
        update.depositor ? other : depositor
      )
    }
  })

  it("binds the selected nonzero output index to its exact funding outpoint", async () => {
    const tx = transaction()
    tx.outputVector = `0x02${toHex(unsigned("1", 8, true)).slice(
      2
    )}0151${tx.outputVector.slice(4)}`
    const first = identity(tx, 0)
    const second = identity(tx, 1)
    await rejects(terms, tx, "FROST funding output length")
    await f.reveal(terms, tx, 1, { gasLimit })
    const d = await f.deposit(second.outpoint)
    expect(d.fundingOutputIndex).eq(1)
    expect(d.fundingTransactionHash).eq(second.txHash)
    expect(d.revealedAt).not.eq(0)
    expect((await f.deposit(first.outpoint)).revealedAt).eq(0)
    expect(await f.pending(id)).eq(1)
  })

  const vectorFields = ["inputVector", "outputVector"] as const
  vectorFields.forEach((field) => {
    it(`rejects nonminimal CompactSize ${field} count/script lengths atomically`, async () => {
      await f.seedPending(id, 7)
      const tx = transaction()
      const scriptOffset = field === "inputVector" ? 37 : 9
      const scriptSize = field === "inputVector" ? 0 : 34
      for (const [offset, value] of [
        [0, 1],
        [scriptOffset, scriptSize],
      ]) {
        for (const [marker, width] of [
          ["fd", 2],
          ["fe", 4],
          ["ff", 8],
        ] as const) {
          const vector = fromHex(tx[field])
          const nonminimal = Buffer.concat([
            vector.subarray(0, offset),
            Buffer.from(marker, "hex"),
            unsigned(value, width, true),
            vector.subarray(offset + 1),
          ])
          await rejects(
            terms,
            { ...tx, [field]: toHex(nonminimal) },
            "FROST compact size noncanonical"
          )
        }
      }
      expect(await f.pending(id)).eq(7)
      expect(await f.entered()).eq(false)
    })

    it(`rejects truncated and trailing ${field} bytes atomically`, async () => {
      await f.seedPending(id, 7)
      const tx = transaction()
      const vector = fromHex(tx[field])
      const prefix = field === "inputVector" ? 36 : 8
      const scriptOffset = 1 + prefix
      const cases: [string, string][] = [
        ["0x", "FROST compact size missing"],
        ["0x00", "FROST empty vector"],
        ["0xfd01", "FROST compact size truncated"],
        ["0xfe010000", "FROST compact size truncated"],
        ["0xff01000000000000", "FROST compact size truncated"],
        // An extended script length missing its remaining width. The five
        // marker/payload bytes keep input's minimum-count check satisfied.
        [
          toHex(
            Buffer.concat([
              vector.subarray(0, scriptOffset),
              Buffer.from("ff01000000", "hex"),
            ])
          ),
          "FROST compact size truncated",
        ],
        [toHex(vector.subarray(0, scriptOffset - 1)), "FROST vector count"],
        [`${tx[field]}00`, "FROST vector trailing bytes"],
        [`${tx[field]}deadbeef`, "FROST vector trailing bytes"],
        // The declared count covers only the first of two complete entries.
        [
          toHex(Buffer.concat([vector, vector.subarray(1)])),
          "FROST vector trailing bytes",
        ],
      ]
      if (field === "inputVector") {
        // Two script bytes plus a truncated sequence: enough for the coarse
        // minimum-count bound, but fewer than the exact declared entry size.
        cases.push([
          toHex(
            Buffer.concat([
              vector.subarray(0, scriptOffset),
              Buffer.from("02aabbffffff", "hex"),
            ])
          ),
          "FROST vector script",
        ])
        cases.push([
          toHex(vector.subarray(0, vector.length - 1)),
          "FROST vector count",
        ])
      } else {
        cases.push([
          toHex(vector.subarray(0, vector.length - 1)),
          "FROST vector script",
        ])
      }
      for (const [malformed, reason] of cases) {
        await rejects(terms, { ...tx, [field]: malformed }, reason)
      }
      expect(await f.pending(id)).eq(7)
      expect(await f.entered()).eq(false)
      // A failed encoding cannot leave the guard set or poison a canonical retry.
      await f.reveal(terms, tx, 0, { gasLimit })
      expect(await f.pending(id)).eq(8)
      expect(await f.entered()).eq(false)
    })
  })

  it("rejects malformed vectors and absent selected output without residual entered state", async () => {
    await rejects(
      terms,
      { ...transaction(), inputVector: "0x01" },
      "FROST vector count"
    )
    await rejects(
      terms,
      { ...transaction(), outputVector: "0x01" },
      "FROST vector count"
    )
    const tx = transaction()
    const before = await f.frame(identity(tx, 1).outpoint, id)
    await expect(f.reveal(terms, tx, 1, { gasLimit })).reverted
    expect(await f.frame(identity(tx, 1).outpoint, id)).eq(before)
  })

  it("binds chain, bridge and Bitcoin network", async () => {
    const tx = transaction()
    for (const update of [
      { chainId: "1" },
      { bridge: other.address },
      { bitcoinGenesis: ethers.utils.id("wrong-genesis") },
    ])
      await rejects({ ...terms, ...update }, tx, "FROST deposit binding")
    await f.seedConfiguration(v.address, ethers.constants.HashZero)
    await rejects(
      { ...terms, bitcoinGenesis: ethers.constants.HashZero },
      tx,
      "FROST deposit binding"
    )
  })

  it("binds full wallet ID beyond its bytes20 label, descriptor and readiness", async () => {
    const tx = transaction()
    await rejects(
      { ...terms, fullWalletId: `${id.slice(0, 42)}${"ff".repeat(12)}` },
      tx,
      "FROST deposit wallet"
    )
    await rejects(
      { ...terms, descriptorHash: ethers.utils.id("wrong-descriptor") },
      tx,
      "FROST deposit wallet"
    )
    for (const [state, quarantined, capability] of [
      [2, false, 1],
      [5, false, 1],
      [3, true, 1],
      [3, false, 0],
    ] as const) {
      await f.seedWallet(id, descriptor, Q, state, quarantined, capability)
      await rejects(terms, tx, "FROST deposit wallet")
    }
    await f.seedWallet(id, descriptor, Q, 4, false, 1)
    await f.reveal(terms, tx, 0, { gasLimit })
    expect(await f.pending(id)).eq(1)
  })

  it("requires depositor authority and a trusted nonzero vault", async () => {
    await rejects(terms, transaction(), "FROST depositor", 0, other)
    const t = { ...terms, vault: other.address }
    await rejects(t, transaction(t), "FROST vault untrusted")
    await f.trustVault(other.address, true)
    await f.reveal(t, transaction(t), 0, { gasLimit })
    expect(await f.pending(id)).eq(1)
  })

  it("enforces the refund boundary at the reveal block timestamp", async () => {
    const next = (await ethers.provider.getBlock("latest")).timestamp + 20
    const early = { ...terms, refundLocktime: next + 3599 }
    await ethers.provider.send("evm_setNextBlockTimestamp", [next])
    await rejects(early, transaction(early), "FROST refund too soon")
    const exact = { ...terms, refundLocktime: next + 1 + 3600 }
    await ethers.provider.send("evm_setNextBlockTimestamp", [next + 1])
    await f.reveal(exact, transaction(exact), 0, { gasLimit })
    expect(await f.pending(id)).eq(1)
  })

  it("gates address distribution and reveal independently", async () => {
    await f.gates(false, true)
    await expect(f.output(terms, { gasLimit })).revertedWith(
      "FROST addresses disabled"
    )
    await f.reveal(terms, transaction(), 0, { gasLimit })
    await f.gates(true, false)
    expect((await f.output(terms, { gasLimit })).key).eq(expected().key)
    const t = { ...terms, blinding: "0x0102030405060709" }
    await rejects(t, transaction(t), "FROST reveal disabled")
  })

  it("rejects repeat FROST reveal and shared legacy/custody/spent outpoint occupation", async () => {
    const tx = transaction()
    const { outpoint } = identity(tx)
    await f.seedOccupied(outpoint, true, false)
    await rejects(terms, tx, "FROST funding identity occupied")
    await f.seedOccupied(outpoint, false, true)
    await rejects(terms, tx, "FROST funding identity occupied")
    await f.seedOccupied(outpoint, false, false)
    await f.seedCustody(outpoint, id)
    await rejects(terms, tx, "FROST funding identity occupied")
    await f.seedCustody(outpoint, ethers.constants.HashZero)
    await f.reveal(terms, tx, 0, { gasLimit })
    await rejects(terms, tx, "FROST funding identity occupied")
    expect(await f.pending(id)).eq(1)
  })

  it("rejects invalid curve keys with the real verifier and pins verifier identity", async () => {
    const tx = transaction()
    await rejects(
      { ...terms, refundKey: ethers.constants.HashZero },
      tx,
      "FROST deposit curve key"
    )
    await f.seedWallet(id, descriptor, `0x${"ff".repeat(32)}`, 3, false, 1)
    await rejects(terms, tx, "FROST deposit curve key")
    await f.seedWallet(id, descriptor, Q, 3, false, 1)
    await f.verifierIdentity(v.address, ethers.constants.HashZero)
    await rejects(terms, tx, "FROST verifier identity")
    await f.verifierIdentity(other.address, ethers.utils.keccak256("0x"))
    await rejects(terms, tx, "FROST verifier identity")
  })

  it("rolls back late rebate and fee-capacity failures and preserves a preexisting guard", async () => {
    const tx = transaction()
    await f.rebate(other.address)
    await rejects(terms, tx, "FROST rebate unsupported")
    await f.rebate(ethers.constants.AddressZero)
    for (const [dust, divisor, maximum] of [
      [100001, 100, 100],
      [1000, 1, 0],
      [1000, 100, 99000],
    ]) {
      await f.fees(dust, divisor, maximum)
      await rejects(terms, tx, "FROST deposit fee capacity")
    }
    await f.fees(1000, 0, 99999)
    await f.setEntered(true)
    await rejects(terms, tx, "FROST funding reentry")
    expect(await f.entered()).eq(true)
    await f.setEntered(false)
    await f.reveal(terms, tx, 0, { gasLimit })
    expect((await f.deposit(identity(tx).outpoint)).treasuryFee).eq(0)
  })

  it("rolls back a counter overflow after writing the receipt", async () => {
    const tx = transaction()
    await f.seedPending(id, "18446744073709551615")
    const before = await f.frame(identity(tx).outpoint, id)
    await expect(f.reveal(terms, tx, 0, { gasLimit })).reverted
    expect(await f.frame(identity(tx).outpoint, id)).eq(before)
    expect(await f.entered()).eq(false)
    expect((await f.deposit(identity(tx).outpoint)).revealedAt).eq(0)
  })
})
