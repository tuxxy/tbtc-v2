/* eslint-disable no-await-in-loop, no-restricted-syntax */
// Refs tuxxy/tbtc-v2#33 (C-04 re-review comment 6191973086, L3).
//
// Invariant (KC-SF-V3 C-04; FrostRedemptionLedger.resolveSweep): a
// reservation resolved by an approved conflicting sweep no longer holds
// cancellation exposure. Once the sweep resolution is accepted, the wallet's
// cancellationExposure is zero and its request capacity is exactly
// value - netLiability: a request of that net is admitted and one satoshi
// more is refused. Before the resolution, an admitted cancellation whose fee
// exceeds the reserved batch net (fee > reservedNet) holds exposure
// fee - reservedNet, and capacity is value - exposure - netLiability.
//
// The existing resolution cases use a 1,000 sat cancellation fee, below
// reservedNet, so their exposure is already zero and the reset is never
// observed. Here the fee is reservedNet (exposure 0, boundary), reservedNet + 1
// and reservedNet + 25,000.
//
// Real: the Bridge proxy and its FROST libraries, the Bank, the FrostVerifier,
// every request, reservation, cancellation, sweep and resolution through
// public entrypoints, operator certificates signed by the descriptor's
// operators. No custody, escrow, exposure or Bank storage is written.
// FIXTURE: FrostRegistryFixture (wallet registration without DKG) and
// synthetic two-leaf regtest inclusion proofs (no Bitcoin Core), as in
// Frost.SweepConflictResolution.test.ts, whose deploy/transaction/inclusion
// helpers are copied here.
// A second FROST wallet funds the redeemer's Bank balance only, so the
// capacity probe can request the full remaining capacity of the first.
import { artifacts, ethers, network } from "hardhat"
import { expect } from "chai"
import { createHash } from "crypto"
import { reservationProposal } from "../helpers/frost-reservation-proposal"

const ZERO = ethers.constants.HashZero
const Q = "0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
const Q2 = "0xc6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"
const idOf = (q: string) =>
  ethers.utils.keccak256(
    ethers.utils.concat([ethers.utils.id("tbtc-v2/frost-wallet-id/v1"), q])
  )
const ID = idOf(Q)
const ID2 = idOf(Q2)
const TYPE =
  "tuple(uint8 scheme,uint8 profile,uint256 chainId,address registry,uint64 epoch,uint32[] members,address[] operators,uint16 threshold,bytes32 snowfallDescriptor,bytes32 outputKey)"
const RESOLUTION_TYPE =
  "tuple(bytes32 reservationId,bytes32 transactionHash,address vault,uint64 validUntilBlock)"
const CANCELLATION_TYPE =
  "tuple(bytes32 reservationId,bytes32 snapshot,bytes32 transactionHash,uint64 fee,uint64 validUntilBlock)"
const SCRIPT = `0x0014${"11".repeat(20)}`
const sha = (value: Buffer) => createHash("sha256").update(value).digest()
const sha256d = (value: Buffer) => sha(sha(value))
const hex = (value: Buffer) => `0x${value.toString("hex")}`
const raw = (value: string) => Buffer.from(value.slice(2), "hex")
const le = (value: number, width: number) => {
  const b = Buffer.alloc(width)
  b.writeUIntLE(value, 0, width)
  return b
}
const outpoint = (hash: string, index = 0) =>
  ethers.utils.solidityKeccak256(["bytes32", "uint32"], [hash, index])

async function deploy(
  name: string,
  args: unknown[] = [],
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

function transaction(
  inputs: string[],
  outputKey: string,
  amount: number,
  indices: number[] = []
) {
  const tx = {
    version: "0x02000000",
    inputVector: hex(
      Buffer.concat([
        Buffer.from([inputs.length]),
        ...inputs.map((hash, i) =>
          Buffer.concat([
            raw(hash),
            le(indices[i] ?? 0, 4),
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
  return { tx, hash, key: outpoint(hash), index: 0 }
}
type Tx = ReturnType<typeof transaction>

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

describe("C-04 sweep resolution releases cancellation exposure (tbtc-v2#33)", () => {
  // One reserved request: reservedNet is its gross (treasury fee divisor 0).
  const GROSS = 20000
  const RESERVATION_FEE = 1000
  const MAX_FEE = 60000

  let bridge: any
  let frost: any
  let bank: any
  let signers: any[]
  let payer: any
  let descriptor: any
  let descriptorHash: string
  let genesis: string
  let main: Tx
  let other: Tx
  let conflictDeposit: Tx
  let snapshot: string
  let serial = 0

  const utxo = (t: Tx, index: number, value: number) => ({
    txHash: t.hash,
    txOutputIndex: index,
    txOutputValue: value,
  })
  const sweep = (walletId: string, t: Tx, includeMain: boolean) => ({
    walletId,
    transaction: t.tx,
    proof: inclusion(t.hash),
    includeMain,
    vault: ethers.constants.AddressZero,
  })
  const hashOf = (tx: any) =>
    hex(
      sha256d(
        Buffer.concat([
          raw(tx.version),
          raw(tx.inputVector),
          raw(tx.outputVector),
          raw(tx.locktime),
        ])
      )
    )

  async function register(q: string, label: string) {
    const registry = await ethers.getContractAt(
      "FrostRegistryFixture",
      await frost.frostRegistry()
    )
    const d = {
      ...descriptor,
      epoch: await ethers.provider.getBlockNumber(),
      snowfallDescriptor: ethers.utils.id(label),
      outputKey: q,
    }
    const h = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", TYPE],
        [ethers.utils.id("tbtc-v2/frost-descriptor/v1"), d]
      )
    )
    await registry.created(
      ethers.utils.defaultAbiCoder.encode([TYPE], [d]),
      d.epoch + 10000
    )
    await registry.ready(idOf(q), h)
    return { d, h }
  }

  async function reveal(
    walletId: string,
    hash: string,
    q: string,
    amount: number
  ) {
    serial += 1
    const t = {
      chainId: descriptor.chainId,
      bridge: bridge.address,
      bitcoinGenesis: genesis,
      fullWalletId: walletId,
      descriptorHash: hash,
      depositor: payer.address,
      vault: ethers.constants.AddressZero,
      blinding: ethers.utils.hexZeroPad(ethers.utils.hexlify(serial), 8),
      amount,
      refundKey: q,
      refundLocktime:
        (await ethers.provider.getBlock("latest")).timestamp + 86400,
      extraData: ZERO,
    }
    const output = await frost.frostDepositOutput(t)
    const d = transaction(
      [ethers.utils.id(`L3 synthetic funding ${serial}`)],
      output.key,
      amount
    )
    await frost.connect(payer).revealFrostDeposit(t, d.tx, 0)
    return d
  }

  async function request(gross: number) {
    await bank.connect(payer).approveBalance(bridge.address, 0)
    await bank.connect(payer).approveBalance(bridge.address, gross)
    const caller = frost.connect(payer)
    const id = await caller.callStatic.requestFrostRedemption(
      ID,
      SCRIPT,
      gross,
      payer.address
    )
    await caller.requestFrostRedemption(ID, SCRIPT, gross, payer.address)
    return id
  }

  async function signatures(domain: string, type: string, authorization: any) {
    const digest = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", "uint256", "address", type],
        [
          ethers.utils.id(domain),
          descriptor.chainId,
          bridge.address,
          authorization,
        ]
      )
    )
    return ethers.utils.hexConcat(
      await Promise.all(
        signers
          .slice(0, 2)
          .map((s) => s.signMessage(ethers.utils.arrayify(digest)))
      )
    )
  }

  async function reserve(id: string) {
    const custody = await frost.frostWalletCustody(ID)
    const p = await reservationProposal({
      bridge: bridge.address,
      chainId: descriptor.chainId,
      walletId: ID,
      descriptorHash,
      genesis,
      outputKey: Q,
      generation: custody.generation.add(1),
      stateVersion: custody.stateVersion,
      validUntilBlock: (await ethers.provider.getBlockNumber()) + 100,
      inputs: [utxo(main, 1, 79000), utxo(other, 0, 99000)],
      requests: [{ id, value: GROSS - RESERVATION_FEE, script: SCRIPT }],
      fee: RESERVATION_FEE,
      minimumFee: 100,
      maximumFee: MAX_FEE,
      maximumSatPerVByte: 1000,
      operators: signers.slice(0, 3),
    })
    const reservationId = await frost.callStatic.reserveFrostRedemption(p)
    await frost.reserveFrostRedemption(p)
    return reservationId
  }

  /// An admitted cancellation of both captured inputs, sponsored by the payer.
  async function cancel(reservationId: string, fee: number) {
    const t = transaction([main.hash, other.hash], Q, 178000 - fee, [1, 0])
    const validator = await deploy("FrostRedemptionTransactionFixture")
    const result = await validator.validateCancellation(t.tx, Q, [
      utxo(main, 1, 79000),
      utxo(other, 0, 99000),
    ])
    const authorization = {
      reservationId,
      snapshot: result.snapshot,
      transactionHash: t.hash,
      fee,
      validUntilBlock: (await ethers.provider.getBlockNumber()) + 100,
    }
    await bank.connect(payer).approveBalance(bridge.address, 0)
    await bank.connect(payer).approveBalance(bridge.address, fee)
    await frost
      .connect(payer)
      .authorizeFrostCancellation(
        authorization,
        t.tx,
        [1, 2],
        await signatures(
          "tbtc-v2/frost-reservation-cancellation/v1",
          CANCELLATION_TYPE,
          authorization
        )
      )
  }

  async function resolve(reservationId: string) {
    const t = transaction([conflictDeposit.hash, main.hash], Q, 178000, [0, 1])
    const authorization = {
      reservationId,
      transactionHash: t.hash,
      vault: ethers.constants.AddressZero,
      validUntilBlock: (await ethers.provider.getBlockNumber()) + 100,
    }
    await frost.submitFrostSweepResolutionProof({
      sweep: sweep(ID, t, true),
      authorization,
      seats: [1, 2],
      signatures: await signatures(
        "tbtc-v2/frost-reservation-sweep-resolution/v1",
        RESOLUTION_TYPE,
        authorization
      ),
    })
  }

  /// value - exposure - netLiability, from the public views.
  async function capacity() {
    const custody = await frost.frostWalletCustody(ID)
    const [, net] = await frost.frostRedemptionEscrow(ID)
    return {
      value: custody.value.toNumber(),
      exposure: custody.cancellationExposure.toNumber(),
      net: net.toNumber(),
    }
  }

  /// A request of exactly `net` is admitted and `net + 1` is refused; both
  /// are rolled back afterwards.
  async function probe(net: number, label: string) {
    const balance = (await bank.balanceOf(payer.address)).toNumber()
    expect(
      balance,
      "fixture: the redeemer cannot fund the capacity probe"
    ).to.be.at.least(net + 1)
    const s = await network.provider.send("evm_snapshot")
    try {
      await request(net)
    } catch (error: any) {
      expect.fail(
        `${label}: a request of the full capacity (${net}) was refused: ${
          error?.reason ?? error?.message
        }`
      )
    }
    expect(await network.provider.send("evm_revert", [s])).to.equal(true)
    const t = await network.provider.send("evm_snapshot")
    await expect(
      request(net + 1),
      `${label}: a request one satoshi over capacity was admitted`
    ).to.be.revertedWith("FROST insufficient recognized custody")
    expect(await network.provider.send("evm_revert", [t])).to.equal(true)
  }

  before(async () => {
    signers = await ethers.getSigners()
    const [owner, depositor, treasury] = signers
    payer = depositor
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
    const movement = Array.from(await bridge.movingFundsParameters())
    movement[1] = 500
    await bridge.updateMovingFundsParameters(...movement)
    // Treasury fee divisor 0 (net = gross); total fee cap above every
    // cancellation fee used here. Test values.
    await bridge.updateRedemptionParameters(3000, 0, 2000, MAX_FEE, 3600, 0, 0)
    const registry = await deploy("FrostRegistryFixture", [proxy.address])
    await frost.configureFrostRegistry(registry.address)
    descriptor = {
      scheme: 2,
      profile: 1,
      chainId: (await ethers.provider.getNetwork()).chainId,
      registry: registry.address,
      epoch: 0,
      members: [1, 2, 3],
      operators: signers.slice(0, 3).map((s) => s.address),
      threshold: 2,
      snowfallDescriptor: ZERO,
      outputKey: Q,
    }
    const first = await register(Q, "UNQUALIFIED L3 controlled descriptor")
    descriptor = first.d
    descriptorHash = first.h
    const second = await register(Q2, "UNQUALIFIED L3 liquidity descriptor")
    const verifier = await deploy("FrostVerifier")
    genesis = ethers.utils.id("UNQUALIFIED L3 synthetic regtest domain")
    await frost.configureFrostFunding(
      verifier.address,
      ethers.utils.keccak256(await ethers.provider.getCode(verifier.address)),
      ethers.utils.id("UNQUALIFIED L3 synthetic-proof component"),
      genesis
    )
    const exposure = await deploy("FrostExposureController", [
      proxy.address,
      owner.address,
    ])
    await exposure.openBudgetPeriod(
      ethers.BigNumber.from(2).pow(64).sub(1),
      ethers.BigNumber.from(2).pow(64).sub(1),
      ethers.utils.id("C-10 test budget; D-10 OPEN")
    )
    await frost.installFrostExposureController(exposure.address)
    await frost.setFrostFundingGates(true, true)
    await frost.configureFrostRedemptions(
      genesis,
      2,
      1000,
      ethers.constants.AddressZero,
      ethers.utils.id("UNQUALIFIED L3 local D08 fixture reference")
    )
    await frost.setFrostRedemptionsEnabled(true)

    // Wallet custody, as in the A3 setup: a main from a bootstrap redemption's
    // change (79,000) plus an independently recognized deposit output (99,000).
    const d0 = await reveal(ID, descriptorHash, Q, 100000)
    const d1 = await reveal(ID, descriptorHash, Q, 100000)
    conflictDeposit = await reveal(ID, descriptorHash, Q, 100000)
    const initialMain = transaction([d0.hash], Q, 99000)
    await frost.submitFrostDepositSweepProof(sweep(ID, initialMain, false))
    const bootstrapRequest = await request(20000)
    const custody = await frost.frostWalletCustody(ID)
    const bootstrap = await reservationProposal({
      bridge: bridge.address,
      chainId: descriptor.chainId,
      walletId: ID,
      descriptorHash,
      genesis,
      outputKey: Q,
      generation: custody.generation.add(1),
      stateVersion: custody.stateVersion,
      validUntilBlock: (await ethers.provider.getBlockNumber()) + 100,
      inputs: [utxo(initialMain, 0, 99000)],
      requests: [{ id: bootstrapRequest, value: 19000, script: SCRIPT }],
      fee: 1000,
      operators: signers.slice(0, 3),
    })
    const bootstrapId = await frost.callStatic.reserveFrostRedemption(bootstrap)
    await frost.reserveFrostRedemption(bootstrap)
    other = transaction([d1.hash], Q, 99000)
    await frost.submitFrostDepositSweepProof(sweep(ID, other, false))
    await frost.submitFrostRedemptionProof(
      bootstrapId,
      bootstrap.transaction,
      inclusion(hashOf(bootstrap.transaction))
    )
    const paymentHash = hashOf(bootstrap.transaction)
    main = {
      tx: bootstrap.transaction,
      hash: paymentHash,
      key: outpoint(paymentHash, 1),
      index: 1,
    }
    expect((await frost.frostCustodyOutput(main.key)).value).eq(79000)
    expect((await frost.frostWalletCustody(ID)).value).eq(178000)

    // Liquidity only: the second wallet's deposit credits the redeemer's Bank
    // balance without changing the first wallet's custody.
    const liquidity = await reveal(ID2, second.h, Q2, 1000000)
    await frost.submitFrostDepositSweepProof(
      sweep(ID2, transaction([liquidity.hash], Q2, 999000), false)
    )
    expect((await frost.frostWalletCustody(ID)).value).eq(178000)
    snapshot = await network.provider.send("evm_snapshot")
  })

  beforeEach(async () => {
    expect(await network.provider.send("evm_revert", [snapshot])).eq(true)
    snapshot = await network.provider.send("evm_snapshot")
  })

  const cases = [
    { over: 0, name: "fee equal to reservedNet (no exposure; boundary)" },
    { over: 1, name: "fee one satoshi above reservedNet" },
    { over: 25000, name: "fee 25,000 above reservedNet" },
  ]
  cases.forEach((c) => {
    it(`releases the exposure of a cancellation with ${c.name} when the sweep resolution is proven`, async () => {
      const reservedNet = GROSS
      const fee = reservedNet + c.over
      const reservationId = await reserve(await request(GROSS))
      await cancel(reservationId, fee)

      // Precondition: the admitted cancellation holds fee - reservedNet and
      // that exposure is enforced on new requests.
      const held = await capacity()
      expect(held.exposure, "precondition: cancellation exposure").to.equal(
        c.over
      )
      expect(held.net).to.equal(reservedNet)
      await probe(
        held.value - held.exposure - held.net,
        "precondition (cancellation admitted)"
      )

      await resolve(reservationId)
      expect((await frost.frostReservation(reservationId)).state).to.equal(6)

      const after = await capacity()
      expect(
        after.exposure,
        "C-04 sweep resolution: the resolved reservation's cancellation exposure was not released"
      ).to.equal(0)
      await probe(
        after.value - after.net,
        "C-04 sweep resolution: request capacity after the resolution"
      )
    })
  })
})
