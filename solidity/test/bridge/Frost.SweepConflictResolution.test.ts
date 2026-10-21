/* eslint-disable no-await-in-loop, no-restricted-syntax, no-bitwise */
// Controlled real Bridge proxy, Bank and verifier component. The transaction,
// inclusion and deployment helpers below reuse the MainRequired test setup.
// SYNTHETIC two-leaf regtest proofs: no Core execution, Bitcoin consensus,
// threshold signing, production chain-work or eventual-inclusion qualification.
// Requests/reservations and every custody/Bank credit use public entrypoints.
// No active-reservation, custody, escrow or Bank storage is seeded.
// Parent-owned A3 API; run only against the parent-confirmed compiled artifacts.
import { artifacts, ethers, network } from "hardhat"
import { expect } from "chai"
import { createHash } from "crypto"
import { reservationProposal } from "../helpers/frost-reservation-proposal"
import { fundingStorageFrame } from "../helpers/frost-public-vault-callback"

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

const RESOLUTION_TYPE =
  "tuple(bytes32 reservationId,bytes32 transactionHash,address vault,uint64 validUntilBlock)"
const CANCELLATION_TYPE =
  "tuple(bytes32 reservationId,bytes32 snapshot,bytes32 transactionHash,uint64 fee,uint64 validUntilBlock)"
const SCRIPT = `0x0014${"11".repeat(20)}`
const OTHER_Q =
  "0xc6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"

type Tx = ReturnType<typeof transaction>

describe("C-04 approved sweep conflict resolution (synthetic inclusion component)", () => {
  let bridge: any
  let frost: any
  let bank: any
  let vault: any
  let signers: any[]
  let payer: any
  let treasury: any
  let descriptor: any
  let descriptorHash: string
  let genesis: string
  let terms: any
  let main: Tx
  let other: Tx
  let deposits: Tx[]
  let bootstrapId: string
  let bootstrapRequest: string
  let snapshot: string
  let serial = 0

  const utxo = (t: Tx, value: number) => ({
    txHash: t.hash,
    txOutputIndex: t.index,
    txOutputValue: value,
  })
  const sweep = (
    t: Tx,
    includeMain = true,
    target = ethers.constants.AddressZero
  ) => ({
    walletId: ID,
    transaction: t.tx,
    proof: inclusion(t.hash),
    includeMain,
    vault: target,
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

  async function reveal(target = ethers.constants.AddressZero) {
    serial += 1
    const t = {
      ...terms,
      vault: target,
      blinding: ethers.utils.hexZeroPad(ethers.utils.hexlify(serial), 8),
    }
    const output = await frost.frostDepositOutput(t)
    const d = transaction(
      [ethers.utils.id(`A3 synthetic funding ${serial}`)],
      output.key,
      100000
    )
    await frost.connect(payer).revealFrostDeposit(t, d.tx, 0)
    deposits.push(d)
    return d
  }

  async function request(gross = 20000) {
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

  async function reserve(ids: string[], inputs: ReturnType<typeof utxo>[]) {
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
      inputs,
      requests: ids.map((id) => ({
        id,
        value: ids.length === 1 ? 18800 : 19300,
        script: SCRIPT,
      })),
      fee: 1000,
      operators: signers.slice(0, 3),
    })
    const id = await frost.callStatic.reserveFrostRedemption(p)
    await frost.reserveFrostRedemption(p)
    return { id, p }
  }

  async function signatures(
    domain: string,
    type: string,
    authorization: any,
    options: { chainId?: number; bridge?: string; operators?: any[] } = {}
  ) {
    const digest = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", "uint256", "address", type],
        [
          ethers.utils.id(domain),
          options.chainId ?? descriptor.chainId,
          options.bridge ?? bridge.address,
          authorization,
        ]
      )
    )
    return ethers.utils.hexConcat(
      await Promise.all(
        (options.operators ?? signers.slice(0, 2)).map((s) =>
          s.signMessage(ethers.utils.arrayify(digest))
        )
      )
    )
  }

  async function resolution(
    id: string,
    t: Tx,
    target = ethers.constants.AddressZero,
    overrides: Record<string, unknown> = {}
  ) {
    const authorization = {
      reservationId: id,
      transactionHash: t.hash,
      vault: target,
      validUntilBlock: (await ethers.provider.getBlockNumber()) + 100,
      ...overrides,
    }
    return {
      sweep: sweep(t, true, target),
      authorization,
      seats: [1, 2],
      signatures: await signatures(
        "tbtc-v2/frost-reservation-sweep-resolution/v1",
        RESOLUTION_TYPE,
        authorization
      ),
    }
  }

  async function cancellation(id: string) {
    // Both captured R inputs, unlike S which spends only captured main + new deposit.
    const t = transaction([main.hash, other.hash], Q, 177200, [1, 0])
    const validator = await deploy("FrostRedemptionTransactionFixture")
    const result = await validator.validateCancellation(t.tx, Q, [
      utxo(main, 79200),
      utxo(other, 99000),
    ])
    const authorization = {
      reservationId: id,
      snapshot: result.snapshot,
      transactionHash: t.hash,
      fee: 1000,
      validUntilBlock: (await ethers.provider.getBlockNumber()) + 100,
    }
    const signed = await signatures(
      "tbtc-v2/frost-reservation-cancellation/v1",
      CANCELLATION_TYPE,
      authorization
    )
    await bank.connect(treasury).approveBalance(bridge.address, 0)
    await bank.connect(treasury).approveBalance(bridge.address, 1000)
    await frost
      .connect(treasury)
      .authorizeFrostCancellation(authorization, t.tx, [1, 2], signed)
    return { t, authorization, signatures: signed }
  }

  // Public getters retain all dynamic request/intent/certificate archives.
  // Compiler-layout reads cover guards, pending reveals, request nonce and spent flags.
  async function frame(ids: string[], intentId: string, keys: string[] = []) {
    const outpoints = Array.from(
      new Set([...deposits.map((d) => d.key), main.key, other.key, ...keys])
    )
    // Signers 0-5 are every account the suite uses. All 560 Hardhat accounts
    // would make the allowance matrix about 317,000 calls per frame.
    const actors = [
      ...signers.slice(0, 6).map((s) => s.address),
      bridge.address,
      bank.address,
      vault.address,
    ]
    return JSON.stringify(
      await Promise.all([
        fundingStorageFrame(bridge.address, ID, outpoints),
        frost.frostWalletCustody(ID),
        frost.walletDescriptor(ID.slice(0, 42)),
        frost.frostRedemptionConfiguration(),
        frost.frostRedemptionEscrow(ID),
        frost.frostReservation(intentId),
        frost.frostReservation(bootstrapId),
        Promise.all(
          [...ids, bootstrapRequest].map((id) =>
            frost.frostRedemptionRequest(id)
          )
        ),
        Promise.all(ids.map((id) => frost.frostRedemptionPolicy(id))),
        Promise.all(outpoints.map((key) => frost.frostCustodyOutput(key))),
        Promise.all(deposits.map((d) => frost.frostDeposit(d.key))),
        Promise.all(actors.map((a) => bank.balanceOf(a))),
        Promise.all(actors.map((a) => bank.nonces(a))),
        Promise.all(
          actors.flatMap((a) => actors.map((b) => bank.allowance(a, b)))
        ),
        bank.owner(),
        bank.bridge(),
        bank.DOMAIN_SEPARATOR(),
        bridge.isVaultTrusted(vault.address),
        vault.calls(),
        vault.observedBankBalance(),
        vault.received(payer.address),
        Promise.all([0, 1, 2, 3, 4].map((i) => vault.callbackSuccess(i))),
        Promise.all([0, 1, 2, 3, 4].map((i) => vault.callbackResult(i))),
        vault.revertAfterCallbacks(),
      ])
    )
  }

  async function refuses(
    a: any,
    payload: any,
    keys: string[] = [],
    reason?: string
  ) {
    const before = await frame(a.ids, a.id, keys)
    const attempt = frost.submitFrostSweepResolutionProof(payload)
    if (reason) await expect(attempt).revertedWith(reason)
    else await expect(attempt).reverted
    expect(await frame(a.ids, a.id, keys)).eq(before)
  }

  async function claimResolved(a: any) {
    // Proof releases the conflict, not the request escrow or its net liability.
    const beforeWallet = await frost.frostWalletCustody(ID)
    const beforeIntent = await frost.frostReservation(a.id)
    const claimant = signers[4]
    const claimantBalance = await bank.balanceOf(claimant.address)
    let held = 40000
    let liability = 39600
    const pending = await frost.frostRedemptionEscrow(ID)
    expect(pending[0]).eq(held)
    expect(pending[1]).eq(liability)
    expect(await bank.balanceOf(bridge.address)).eq(held)
    for (const id of a.ids)
      expect((await frost.frostRedemptionRequest(id)).state).eq(6)
    for (const id of a.ids) {
      const beforeBalance = await bank.balanceOf(payer.address)
      await frost.connect(claimant).refundResolvedFrostRedemption(id)
      held -= 20000
      liability -= 19800
      expect((await frost.frostRedemptionRequest(id)).state).eq(5)
      expect(await bank.balanceOf(payer.address)).eq(beforeBalance.add(20000))
      expect(await bank.balanceOf(claimant.address)).eq(claimantBalance)
      expect(await bank.balanceOf(bridge.address)).eq(held)
      const remaining = await frost.frostRedemptionEscrow(ID)
      expect(remaining[0]).eq(held)
      expect(remaining[1]).eq(liability)
      expect(await frost.frostWalletCustody(ID)).deep.eq(beforeWallet)
      expect(await frost.frostReservation(a.id)).deep.eq(beforeIntent)
    }
  }

  async function admitted(
    constructedBefore = true,
    target = ethers.constants.AddressZero
  ) {
    const d =
      target === ethers.constants.AddressZero
        ? deposits[2]
        : await reveal(target)
    // Construction order is explicit; synthetic inclusion does not assert a real signing/broadcast history.
    let t: Tx | undefined
    if (constructedBefore)
      t = transaction([d.hash, main.hash], Q, 178200, [0, 1])
    const ids = [await request(), await request()]
    const r = await reserve(ids, [utxo(main, 79200), utxo(other, 99000)])
    if (!t) t = transaction([d.hash, main.hash], Q, 178200, [0, 1])
    const c = await cancellation(r.id)
    const late = transaction([deposits[3].hash], Q, 99000)
    const beforeLate = await frost.frostWalletCustody(ID)
    await frost.submitFrostDepositSweepProof(sweep(late, false))
    const afterLate = await frost.frostWalletCustody(ID)
    expect(afterLate.stateVersion).eq(beforeLate.stateVersion)
    expect(afterLate.mainOutpoint).eq(main.key)
    return {
      ...r,
      ids,
      t,
      c,
      late,
      d,
      approval: await resolution(r.id, t, target),
    }
  }

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
    const movement = Array.from(await bridge.movingFundsParameters())
    movement[1] = 500
    await bridge.updateMovingFundsParameters(...movement)
    await bridge.updateRedemptionParameters(3000, 100, 2000, 2000, 3600, 0, 0)
    const registry = await deploy("FrostRegistryFixture", [proxy.address])
    await frost.configureFrostRegistry(registry.address)
    descriptor = {
      scheme: 2,
      profile: 1,
      chainId: (await ethers.provider.getNetwork()).chainId,
      registry: registry.address,
      epoch: await ethers.provider.getBlockNumber(),
      members: [1, 2, 3],
      operators: signers.slice(0, 3).map((s) => s.address),
      threshold: 2,
      snowfallDescriptor: ethers.utils.id(
        "UNQUALIFIED A3 controlled registry descriptor"
      ),
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
      descriptor.epoch + 10000
    )
    await registry.ready(ID, descriptorHash)
    const verifier = await deploy("FrostVerifier")
    genesis = ethers.utils.id("UNQUALIFIED A3 synthetic regtest domain")
    await frost.configureFrostFunding(
      verifier.address,
      ethers.utils.keccak256(await ethers.provider.getCode(verifier.address)),
      ethers.utils.id("UNQUALIFIED A3 synthetic-proof component"),
      genesis
    )
    // C-10: the exposure controller with test ceilings (D-10 values OPEN).
    const exposure = await deploy("FrostExposureController", [
      proxy.address,
      (await ethers.getSigners())[0].address,
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
      ethers.utils.id("UNQUALIFIED A3 local D08 fixture reference")
    )
    await frost.setFrostRedemptionsEnabled(true)
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
    for (let i = 0; i < 4; i++) await reveal()
    const initialMain = transaction([deposits[0].hash], Q, 99000)
    await frost.submitFrostDepositSweepProof(sweep(initialMain, false))
    expect(await bank.balanceOf(payer.address)).eq(98000)
    // An actual bootstrap R permits the public deposit-only recognition of other.
    // Paying R then leaves other as non-main, independently recognized custody.
    bootstrapRequest = await request()
    const bootstrap = await reserve(
      [bootstrapRequest],
      [utxo(initialMain, 99000)]
    )
    bootstrapId = bootstrap.id
    other = transaction([deposits[1].hash], Q, 99000)
    await frost.submitFrostDepositSweepProof(sweep(other, false))
    await frost.submitFrostRedemptionProof(
      bootstrap.id,
      bootstrap.p.transaction,
      inclusion(hashOf(bootstrap.p.transaction))
    )
    const paymentHash = hashOf(bootstrap.p.transaction)
    main = {
      tx: bootstrap.p.transaction,
      hash: paymentHash,
      key: outpoint(paymentHash),
      index: 1,
    }
    // Redemption change is output index 1, unlike one-output sweeps.
    main.key = ethers.utils.solidityKeccak256(
      ["bytes32", "uint32"],
      [main.hash, 1]
    )
    expect((await frost.frostCustodyOutput(main.key)).value).eq(79200)
    expect((await frost.frostCustodyOutput(other.key)).spent).eq(false)
    expect((await frost.frostWalletCustody(ID)).value).eq(178200)
    vault = await deploy("FrostVaultCallbackFixture", [
      bank.address,
      bridge.address,
    ])
    await bridge.setVaultStatus(vault.address, true)
    snapshot = await network.provider.send("evm_snapshot")
  })

  beforeEach(async () => {
    expect(await network.provider.send("evm_revert", [snapshot])).eq(true)
    snapshot = await network.provider.send("evm_snapshot")
    // Restore the JS inventory as well as EVM state after vault-specific reveals.
    deposits = deposits.slice(0, 4)
  })

  // C-10 (adversarial review of #14): withdrawals stay reachable under
  // containment and change no exposure counter. Containment stops only new
  // exposure (reveals, reservations, unreserved credit).
  async function containedFrame() {
    const exposure = await ethers.getContractAt(
      "FrostExposureController",
      await frost.frostExposureController()
    )
    await exposure.contain(ethers.utils.id("C-10 exits under containment"))
    const read = async () =>
      JSON.stringify(
        await Promise.all(
          [
            "custodyReserved",
            "custodyReleased",
            "custodyAdmitted",
            "issuanceReserved",
            "issued",
            "depositsOutstanding",
            "remainingCustody",
            "remainingIssuance",
          ].map(async (name) => (await exposure[name]()).toString())
        )
      )
    return { exposure, read, before: await read() }
  }

  it("C-10: requests, reserves and pays a FROST redemption under containment, counters unchanged", async () => {
    const { exposure, read, before } = await containedFrame()
    expect(await exposure.contained()).eq(true)
    await expect(reveal()).revertedWith("FROST exposure contained")
    const id = await request()
    const r = await reserve([id], [utxo(main, 79200)])
    await frost.submitFrostRedemptionProof(
      r.id,
      r.p.transaction,
      inclusion(hashOf(r.p.transaction))
    )
    expect((await frost.frostReservation(r.id)).state).not.eq(1)
    expect(await read()).eq(before)
  })

  it("C-10: cancels a reserved FROST redemption and times out another under containment, counters unchanged", async () => {
    const ids = [await request(), await request()]
    const r = await reserve(ids, [utxo(main, 79200), utxo(other, 99000)])
    const c = await cancellation(r.id)
    const { read, before } = await containedFrame()
    await frost.submitFrostCancellationProof(r.id, c.t.tx, inclusion(c.t.hash))
    expect((await frost.frostReservation(r.id)).state).eq(3)
    for (const id of ids)
      expect((await frost.frostRedemptionRequest(id)).state).eq(5)
    const late = await request()
    const deadline = (await frost.frostRedemptionRequest(late)).deadline
    await network.provider.send("evm_setNextBlockTimestamp", [
      deadline.toNumber() + 1,
    ])
    await frost.notifyFrostRedemptionTimeout(late)
    expect(await read()).eq(before)
  })

  const orderingCases = [true, false]
  orderingCases.forEach((constructedBefore) => {
    it(`${
      constructedBefore
        ? "S constructed before R"
        : "R before S construction/confirmation"
    }: refunds and credits once, retaining captured extra inputs, late custody and archives`, async () => {
      const a = await admitted(constructedBefore)
      const historical = await frost.frostReservation(a.id)
      const custody = await frost.frostWalletCustody(ID)
      const payerBefore = await bank.balanceOf(payer.address)
      const treasuryBefore = await bank.balanceOf(treasury.address)
      const bootstrapBefore = JSON.stringify(
        await frost.frostReservation(bootstrapId)
      )
      expect(await bank.balanceOf(bridge.address)).eq(41000)
      expect(historical.inputs.length).eq(2)
      expect(historical.inputs[1].txHash).eq(other.hash)
      // The ordinary C05 selector must still refuse the same reserved-main sweep.
      const beforeOrdinary = await frame(a.ids, a.id, [a.t.key, a.late.key])
      await expect(
        frost.submitFrostDepositSweepProof(a.approval.sweep)
      ).revertedWith("FROST sweep main reserved")
      expect(await frame(a.ids, a.id, [a.t.key, a.late.key])).eq(beforeOrdinary)
      const beforePrematureClaim = await frame(a.ids, a.id, [
        a.t.key,
        a.late.key,
      ])
      await expect(
        frost.connect(signers[4]).refundResolvedFrostRedemption(a.ids[0])
      ).revertedWith("FROST resolved refund state")
      expect(await frame(a.ids, a.id, [a.t.key, a.late.key])).eq(
        beforePrematureClaim
      )
      const receipt = await (
        await frost.submitFrostSweepResolutionProof(a.approval)
      ).wait()
      const intent = await frost.frostReservation(a.id)
      expect(intent.state).eq(6) // ConflictResolved, distinct from payment/cancellation.
      expect(intent.sweepResolutionHash).eq(a.t.hash)
      expect(intent.sweepResolutionBlock).eq(receipt.blockNumber)
      expect(intent.sweepResolutionValidUntilBlock).eq(
        a.approval.authorization.validUntilBlock
      )
      expect(intent.sweepResolutionSeats).deep.eq([1, 2])
      expect(intent.sweepResolutionSignaturesHash).eq(
        ethers.utils.keccak256(a.approval.signatures)
      )
      const authorizationHash = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ["bytes32", "uint256", "address", RESOLUTION_TYPE],
          [
            ethers.utils.id("tbtc-v2/frost-reservation-sweep-resolution/v1"),
            descriptor.chainId,
            bridge.address,
            a.approval.authorization,
          ]
        )
      )
      expect(intent.sweepResolutionAuthorizationHash).eq(authorizationHash)
      // Full historical bytes depend on canonical transaction/receipt archival;
      // the on-chain hashes authenticate retrieval, not permanent data availability.
      const approvalEvents = new ethers.utils.Interface([
        "event FrostSweepResolutionApproved(bytes32 indexed reservationId,bytes32 indexed transactionHash,address vault,uint64 validUntilBlock,uint16[] seats,bytes signatures)",
      ])
      const logs = receipt.logs.filter(
        (log: any) =>
          log.address.toLowerCase() === bridge.address.toLowerCase() &&
          log.topics[0] ===
            approvalEvents.getEventTopic("FrostSweepResolutionApproved")
      )
      expect(logs.length).eq(1)
      const approved = approvalEvents.parseLog(logs[0]).args
      expect(approved.reservationId).eq(a.id)
      expect(approved.transactionHash).eq(a.t.hash)
      expect(approved.vault).eq(a.approval.authorization.vault)
      expect(approved.validUntilBlock).eq(
        a.approval.authorization.validUntilBlock
      )
      expect(approved.seats).deep.eq(a.approval.seats)
      expect(approved.signatures).eq(a.approval.signatures)
      expect(ethers.utils.keccak256(approved.signatures)).eq(
        intent.sweepResolutionSignaturesHash
      )
      const canonical = await ethers.provider.getTransaction(
        receipt.transactionHash
      )
      const decoded = frost.interface.decodeFunctionData(
        "submitFrostSweepResolutionProof",
        canonical.data
      )[0]
      expect(decoded.signatures).eq(approved.signatures)
      expect(decoded.seats).deep.eq(approved.seats)
      for (const name of [
        "certificate",
        "admittedBlock",
        "snapshot",
        "transactionHash",
        "requestIds",
        "payouts",
        "inputs",
        "seats",
        "signatures",
        "cancellationHash",
        "cancellationSnapshot",
        "cancellationFee",
        "cancellationSponsor",
        "cancellationAdmittedBlock",
        "cancellationSeats",
        "cancellationSignatures",
        "reservedNet",
        "cancellationValidUntilBlock",
      ]) {
        expect(JSON.stringify(intent[name]), `archive ${name}`).eq(
          JSON.stringify(historical[name])
        )
      }
      expect(JSON.stringify(await frost.frostReservation(bootstrapId))).eq(
        bootstrapBefore
      )
      for (const id of a.ids) {
        const r = await frost.frostRedemptionRequest(id)
        expect(r.state).eq(6)
        expect(r.reservationId).eq(a.id)
        expect(r.gross).eq(20000)
        expect(r.treasuryFee).eq(200)
      }
      const after = await frost.frostWalletCustody(ID)
      expect(after.stateVersion).eq(custody.stateVersion.add(1))
      expect(after.generation).eq(custody.generation)
      expect(after.value).eq(custody.value.sub(79200).add(178200))
      expect(after.value).eq(376200)
      expect(after.mainOutpoint).eq(a.t.key)
      expect(after.activeReservation).eq(ZERO)
      expect(after.cancellationExposure).eq(0)
      expect((await frost.frostCustodyOutput(main.key)).spent).eq(true)
      expect(await bridge.spentMainUTXOs(main.key)).eq(true)
      for (const t of [other, a.late]) {
        const output = await frost.frostCustodyOutput(t.key)
        expect(output.walletId).eq(ID)
        expect(output.value).eq(99000)
        expect(output.spent).eq(false)
        expect(await bridge.spentMainUTXOs(t.key)).eq(false)
      }
      expect((await frost.frostCustodyOutput(a.t.key)).value).eq(178200)
      expect(await bridge.spentMainUTXOs(a.d.key)).eq(true)
      expect(await bridge.spentMainUTXOs(a.t.key)).eq(false)
      expect(await bank.balanceOf(payer.address)).eq(payerBefore.add(98000))
      await claimResolved(a)
      expect(await bank.balanceOf(payer.address)).eq(
        payerBefore.add(40000).add(98000)
      )
      // 1,000 deposit treasury credit + 1,000 returned cancellation sponsorship.
      expect(await bank.balanceOf(treasury.address)).eq(
        treasuryBefore.add(2000)
      )
      expect(await bank.balanceOf(bridge.address)).eq(0)
      const escrow = await frost.frostRedemptionEscrow(ID)
      expect(escrow[0]).eq(0)
      expect(escrow[1]).eq(0)
      expect(
        (await bank.balanceOf(payer.address)).add(
          await bank.balanceOf(treasury.address)
        )
      ).eq(after.value)
      const settled = await frame(a.ids, a.id, [a.t.key, a.late.key])
      const attempts = [
        () => frost.submitFrostSweepResolutionProof(a.approval),
        () => frost.submitFrostDepositSweepProof(a.approval.sweep),
        () =>
          frost.submitFrostRedemptionProof(
            a.id,
            a.p.transaction,
            inclusion(hashOf(a.p.transaction))
          ),
        () =>
          frost.submitFrostCancellationProof(
            a.id,
            a.c.t.tx,
            inclusion(a.c.t.hash)
          ),
        () =>
          frost.authorizeFrostCancellation(
            a.c.authorization,
            a.c.t.tx,
            [1, 2],
            a.c.signatures
          ),
        ...a.ids.map((id) => () => frost.refundUnreservedFrostRedemption(id)),
        ...a.ids.map(
          (id) => () =>
            frost.connect(signers[4]).refundResolvedFrostRedemption(id)
        ),
      ]
      for (const attempt of attempts) {
        await expect(attempt()).reverted
        expect(await frame(a.ids, a.id, [a.t.key, a.late.key])).eq(settled)
      }
    })
  })

  const historicalCases = [false, true]
  historicalCases.forEach((contained) => {
    it(`recovers historical ${
      contained ? "quarantined" : "timeout"
    } intent after reservation expiry with fresh resolution authority and admissions disabled`, async () => {
      const a = await admitted()
      const registryWallet = async () =>
        ethers.utils.defaultAbiCoder.decode(
          [
            `tuple(${TYPE} descriptor,bytes32 id,bytes32 descriptorHash,uint64 deadline,uint8 state,bool quarantined,uint32 generation,uint32 capabilityVersion)`,
          ],
          await frost.walletDescriptor(ID.slice(0, 42))
        )[0]
      const original = await frost.frostReservation(a.id)
      const oldCustody = await frost.frostWalletCustody(ID)
      let quarantineRecord: any
      let quarantineVersion: any
      if (contained) {
        await frost.quarantineFrostWallet(
          ID,
          oldCustody.stateVersion,
          ethers.utils.id("A3 historical containment"),
          ethers.utils.id("A3 retained incident evidence")
        )
        quarantineVersion = oldCustody.stateVersion.add(1)
        quarantineRecord = await frost.frostWalletQuarantine(
          ID,
          quarantineVersion
        )
        expect(quarantineRecord.reservationId).eq(a.id)
        expect(quarantineRecord.previousStateVersion).eq(
          oldCustody.stateVersion
        )
        expect((await registryWallet()).quarantined).eq(true)
        expect((await frost.frostReservation(a.id)).state).eq(5)
      } else {
        const deadlines = await Promise.all(
          a.ids.map(async (id) =>
            (await frost.frostRedemptionRequest(id)).deadline.toNumber()
          )
        )
        await network.provider.send("evm_setNextBlockTimestamp", [
          Math.max(...deadlines) + 1,
        ])
        for (const id of a.ids) await frost.notifyFrostRedemptionTimeout(id)
        expect((await frost.frostReservation(a.id)).state).eq(4)
        for (const id of a.ids)
          expect((await frost.frostRedemptionRequest(id)).state).eq(3)
      }
      const staleAt = Math.max(
        Number(a.p.certificate.validUntilBlock),
        Number(a.c.authorization.validUntilBlock)
      )
      const current = await ethers.provider.getBlockNumber()
      if (current <= staleAt)
        await network.provider.send("hardhat_mine", [
          ethers.utils.hexValue(staleAt - current + 1),
        ])
      expect(await ethers.provider.getBlockNumber()).gt(staleAt)
      await frost.setFrostFundingGates(false, false)
      await frost.setFrostRedemptionsEnabled(false)
      const beforeRefusal = await frame(a.ids, a.id, [a.t.key, a.late.key])
      await expect(
        frost
          .connect(payer)
          .requestFrostRedemption(ID, SCRIPT, 3000, payer.address)
      ).reverted
      expect(await frame(a.ids, a.id, [a.t.key, a.late.key])).eq(beforeRefusal)
      const fresh = await resolution(a.id, a.t)
      expect(fresh.authorization.validUntilBlock).gt(
        await ethers.provider.getBlockNumber()
      )
      const before = await frost.frostWalletCustody(ID)
      const payerBefore = await bank.balanceOf(payer.address)
      const treasuryBefore = await bank.balanceOf(treasury.address)
      if (contained) expect(before.stateVersion).eq(quarantineVersion)
      const receipt = await (
        await frost.submitFrostSweepResolutionProof(fresh)
      ).wait()
      const after = await frost.frostWalletCustody(ID)
      const intent = await frost.frostReservation(a.id)
      expect(intent.state).eq(6)
      expect(intent.certificate).deep.eq(original.certificate)
      expect(intent.snapshot).eq(original.snapshot)
      expect(intent.transactionHash).eq(original.transactionHash)
      expect(intent.cancellationHash).eq(original.cancellationHash)
      expect(intent.cancellationSignatures).eq(original.cancellationSignatures)
      expect(intent.sweepResolutionHash).eq(a.t.hash)
      expect(intent.sweepResolutionBlock).eq(receipt.blockNumber)
      expect(intent.sweepResolutionValidUntilBlock).eq(
        fresh.authorization.validUntilBlock
      )
      expect(intent.sweepResolutionSignaturesHash).eq(
        ethers.utils.keccak256(fresh.signatures)
      )
      expect(after.stateVersion).eq(before.stateVersion.add(1))
      expect(after.generation).eq(before.generation)
      expect(after.activeReservation).eq(ZERO)
      expect(after.mainOutpoint).eq(a.t.key)
      expect(after.value).eq(376200)
      expect(after.cancellationExposure).eq(0)
      for (const id of a.ids)
        expect((await frost.frostRedemptionRequest(id)).state).eq(6)
      expect(await bank.balanceOf(payer.address)).eq(payerBefore.add(98000))
      await claimResolved(a)
      for (const id of a.ids)
        expect((await frost.frostRedemptionRequest(id)).state).eq(5)
      const escrow = await frost.frostRedemptionEscrow(ID)
      expect(escrow[0]).eq(0)
      expect(escrow[1]).eq(0)
      expect(await bank.balanceOf(bridge.address)).eq(0)
      expect(await bank.balanceOf(payer.address)).eq(payerBefore.add(138000))
      expect(await bank.balanceOf(treasury.address)).eq(
        treasuryBefore.add(2000)
      )
      for (const t of [other, a.late]) {
        expect((await frost.frostCustodyOutput(t.key)).spent).eq(false)
        expect((await frost.frostCustodyOutput(t.key)).value).eq(99000)
        expect(await bridge.spentMainUTXOs(t.key)).eq(false)
      }
      if (contained) {
        expect((await registryWallet()).quarantined).eq(true)
        expect(
          await frost.frostWalletQuarantine(ID, quarantineVersion)
        ).deep.eq(quarantineRecord)
        expect(await frost.isFrostFundingTarget(ID.slice(0, 42))).eq(false)
      }
      expect((await frost.frostRedemptionConfiguration()).enabled).eq(false)
    })
  })

  it("rejects wrong conflict input, key, proof, deposit set and fee with complete rollback", async () => {
    const a = await admitted()
    const wrongInput = transaction(
      [a.d.hash, ethers.utils.id("not the captured main")],
      Q,
      178200
    )
    const wrongKey = transaction([a.d.hash, main.hash], OTHER_Q, 178200, [0, 1])
    const duplicate = transaction(
      [a.d.hash, main.hash, a.d.hash],
      Q,
      278200,
      [0, 1, 0]
    )
    const excessiveFee = transaction([a.d.hash, main.hash], Q, 176199, [0, 1])
    for (const t of [wrongInput, wrongKey, duplicate, excessiveFee]) {
      await refuses(a, await resolution(a.id, t), [t.key, a.t.key, a.late.key])
    }
    await refuses(
      a,
      { ...a.approval, sweep: { ...a.approval.sweep, includeMain: false } },
      [a.t.key, a.late.key]
    )
    await refuses(
      a,
      {
        ...a.approval,
        sweep: {
          ...a.approval.sweep,
          proof: { ...a.approval.sweep.proof, merkleProof: ZERO },
        },
      },
      [a.t.key, a.late.key]
    )
    const unrelated = transaction([a.d.hash, main.hash], Q, 178199, [0, 1])
    await refuses(a, { ...a.approval, sweep: sweep(unrelated) }, [
      a.t.key,
      unrelated.key,
      a.late.key,
    ])
  })

  it("requires the separate exact resolution certificate and rejects replayed/foreign authority atomically", async () => {
    const a = await admitted()
    const auth = a.approval.authorization
    const keys = [a.t.key, a.late.key]
    for (const overrides of [
      { reservationId: ethers.utils.id("foreign reservation") },
      { transactionHash: ethers.utils.id("foreign transaction") },
      { vault: vault.address },
      { validUntilBlock: (await ethers.provider.getBlockNumber()) - 1 },
      { validUntilBlock: (await ethers.provider.getBlockNumber()) + 2000 },
    ])
      await refuses(
        a,
        await resolution(a.id, a.t, ethers.constants.AddressZero, overrides),
        keys
      )
    const invalidSignatures = [
      "0x",
      a.p.signatures,
      a.c.signatures,
      await signatures(
        "tbtc-v2/frost-reservation-sweep-resolution/v1",
        RESOLUTION_TYPE,
        auth,
        { chainId: descriptor.chainId + 1 }
      ),
      await signatures(
        "tbtc-v2/frost-reservation-sweep-resolution/v1",
        RESOLUTION_TYPE,
        auth,
        { bridge: bank.address }
      ),
      await signatures(
        "tbtc-v2/frost-reservation-sweep-resolution/v1",
        RESOLUTION_TYPE,
        auth,
        { operators: signers.slice(4, 6) }
      ),
    ]
    for (const signed of invalidSignatures)
      await refuses(a, { ...a.approval, signatures: signed }, keys)
    for (const seats of [[1], [1, 1], [2, 1], [1, 4]]) {
      await refuses(a, { ...a.approval, seats }, keys)
    }
    await frost.submitFrostSweepResolutionProof(a.approval)
  })

  it("rolls back refunds, sponsorship, archives, custody and deposit credits when the real Bank refuses issuance", async () => {
    const a = await admitted()
    // Public Bank-owner fault, no forged balance or Bridge storage.
    await bank.updateBridge(signers[0].address)
    await refuses(
      a,
      a.approval,
      [a.t.key, a.late.key],
      "Caller is not the bridge"
    )
    await bank.updateBridge(bridge.address)
    await frost.submitFrostSweepResolutionProof(a.approval)
    expect((await frost.frostReservation(a.id)).state).eq(6)
    await claimResolved(a)
    expect(await bank.balanceOf(bridge.address)).eq(0)
  })

  it("keeps the unauthorized-caller negative separate from cross-entrypoint reentry", async () => {
    const a = await admitted()
    const keys = [a.t.key, a.late.key]
    const before = await frame(a.ids, a.id, keys)
    await expect(
      frost.connect(signers[4]).submitFrostSweepResolutionProof(a.approval)
    ).revertedWith("Caller is not SPV maintainer")
    expect(await frame(a.ids, a.id, keys)).eq(before)
  })

  it("rejects cross-entrypoint reentry from the trusted Vault after real Bank credit", async () => {
    const a = await admitted(true, vault.address)
    // Exercise the shared guard past the public proof-caller check; otherwise
    // a non-maintainer callback refuses before reaching the reentry boundary.
    await bridge.setSpvMaintainerStatus(vault.address, true)
    const payloads = [
      frost.interface.encodeFunctionData("submitFrostSweepResolutionProof", [
        a.approval,
      ]),
      frost.interface.encodeFunctionData("submitFrostDepositSweepProof", [
        a.approval.sweep,
      ]),
      frost.interface.encodeFunctionData("submitFrostRedemptionProof", [
        a.id,
        a.p.transaction,
        inclusion(hashOf(a.p.transaction)),
      ]),
      frost.interface.encodeFunctionData("submitFrostCancellationProof", [
        a.id,
        a.c.t.tx,
        inclusion(a.c.t.hash),
      ]),
      frost.interface.encodeFunctionData("refundResolvedFrostRedemption", [
        a.ids[0],
      ]),
    ]
    await vault.configure(payloads, false)
    const payerBefore = await bank.balanceOf(payer.address)
    await frost.submitFrostSweepResolutionProof(a.approval)
    expect(await vault.calls()).eq(1)
    expect(await vault.observedBankBalance()).eq(98000)
    expect(await vault.received(payer.address)).eq(98000)
    expect(await bank.balanceOf(vault.address)).eq(98000)
    expect(await bank.balanceOf(payer.address)).eq(payerBefore)
    for (let i = 0; i < payloads.length; i++) {
      expect(await vault.callbackSuccess(i)).eq(false)
      const result = await vault.callbackResult(i)
      expect(result.slice(0, 10)).eq("0x08c379a0")
      const [reason] = ethers.utils.defaultAbiCoder.decode(
        ["string"],
        `0x${result.slice(10)}`
      )
      expect(reason).match(/reentry/)
    }
    expect((await frost.frostReservation(a.id)).state).eq(6)
    await claimResolved(a)
    expect(await bank.balanceOf(bridge.address)).eq(0)
  })

  it("rolls back the entire financial frame on a late Vault failure and permits the same approved proof afterward", async () => {
    const a = await admitted(true, vault.address)
    const payload = frost.interface.encodeFunctionData(
      "submitFrostSweepResolutionProof",
      [a.approval]
    )
    await vault.configure([payload], true)
    await refuses(a, a.approval, [a.t.key, a.late.key], "Vault late failure")
    expect(await vault.calls()).eq(0)
    expect(await bank.balanceOf(vault.address)).eq(0)
    await vault.configure([payload], false)
    await frost.submitFrostSweepResolutionProof(a.approval)
    expect((await frost.frostReservation(a.id)).state).eq(6)
    await claimResolved(a)
    expect(await bank.balanceOf(bridge.address)).eq(0)
  })
})
