/* eslint-disable no-await-in-loop, no-restricted-syntax, no-bitwise */
// Mutation batch M9 (tbtc-v2 redemption and cancellation), 2026-11-10
// campaign, MUTATION-REPORT sections 3 and 4: Bridge-level C-04 guards that
// no unit judge reached with a failing assertion. Every case names the guard
// it holds; each guard has a case that fails at its own assertion when the
// guard is removed or its operator is changed.
//
// Invariants (KC-SF-V3 C-04; FrostRedemptionRequests, FrostRedemptions,
// FrostRedemptionLedger, FrostRedemptionSettlement,
// FrostCancellationAdmissions, FrostCancellationCertificate):
// - Configuration: only while disabled; genesis fixed once set; finality
//   and certificate windows positive; a watchtower has code, and a legacy
//   watchtower forces a FROST watchtower.
// - Quarantine: needs the expected state version, funded custody and
//   nonzero reason and evidence hashes; once.
// - Request: only to a Live, unquarantined wallet; gross at least the dust
//   threshold (inclusive), a supported script, the watchtower's nonzero
//   policy and a delay strictly below the redemption timeout; net liability
//   up to the recognized custody, inclusive. A zero treasury divisor means
//   no treasury fee.
// - Reservation: enabled, Live wallet, certificate window [now, now + max]
//   inclusive, maximum fee up to redemptionTxMaxTotalFee inclusive, request
//   delay elapsed (inclusive), fee allocation equal to the transaction fee,
//   a valid operator certificate, one active reservation per wallet at the
//   next generation, conflict = main, every input recognized custody, each
//   request reservable once and before its deadline (exclusive), bound to
//   its script, with a per-request fee share in [0, maximumBitcoinFee].
// - Settlement: only the reserved transaction pays; remaining custody may
//   equal remaining liabilities. A cancellation is admitted only inside its
//   window (inclusive), for the transaction it names, under a valid
//   certificate (seats strictly ascending within the roster, the last seat
//   and every seat allowed, a full roster of 100 and a threshold equal to
//   the roster allowed), and only if its fee does not strand other pending
//   liabilities (equality allowed). A sweep resolution resolves only the
//   transaction its authorization names. A resolved-refund needs a
//   Refundable request.
// - Reentry: no FROST redemption entrypoint runs inside another FROST call
//   (a trusted vault's balance callback during a deposit sweep).
//
// Real: the Bridge proxy and its FROST libraries, the Bank, the
// FrostVerifier, the FrostExposureController, reveals, deposit sweeps,
// requests, reservations, payments, cancellations and resolutions through
// public entrypoints. Certificates are signed by the descriptor operators.
// FIXTURES: the movement world (FrostRegistryFixture readiness, synthetic
// two-leaf regtest inclusion proofs, the controlled enterMovingFunds marker
// of C-06), FrostCapturedWatchtowerFixture (a controlled policy service),
// FrostVaultCallbackFixture (an adversarial trusted vault that calls the
// Bridge from its balance callback), and FrostReservationCertificateFixture,
// used only to re-derive the bindings of a deliberately altered
// certificate before it is re-signed. No Bridge storage is written except
// by the enterMovingFunds marker.
import { ethers, network } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { AssertionError, expect } from "chai"
import { BigNumber, BigNumberish, Contract } from "ethers"
import { createHash } from "crypto"
import {
  ZERO,
  State,
  TYPE,
  movementWorld,
  transaction,
  inclusion,
  p2tr,
  p2wpkh,
  raw,
  deploy,
  ascending,
  split,
  World,
  Wallet,
  Tx,
} from "../helpers/frost-movement-world"
import { reservationProposal } from "../helpers/frost-reservation-proposal"

const GENESIS = ethers.utils.id("C06 synthetic regtest domain")
const SCRIPT = `0x0014${"11".repeat(20)}`
const OTHER_SCRIPT = `0x0014${"22".repeat(20)}`
const EVIDENCE = ethers.utils.id("UNQUALIFIED M9 redemption guard tests")
const DUST = 3000
const TX_MAX_FEE = 2000
const TX_MAX_TOTAL_FEE = 5000
const TIMEOUT = 3600
const MAX_CERTIFICATE_BLOCKS = 1000
const FUNDED = 600000
// x's custody after funding (sweep fee 1,000).
const CUSTODY = FUNDED - 1000
const Intent = { Reserved: 1, Paid: 2, Cancelled: 3, ConflictResolved: 6 }
const Request = { Requested: 1, Reserved: 2, Paid: 4, Refunded: 5 }
const CANCELLATION_TYPE =
  "tuple(bytes32 reservationId,bytes32 snapshot,bytes32 transactionHash,uint64 fee,uint64 validUntilBlock)"
const RESOLUTION_TYPE =
  "tuple(bytes32 reservationId,bytes32 transactionHash,address vault,uint64 validUntilBlock)"

/// Awaits a step that must succeed: a refusal fails as a named assertion
/// whose stack starts at the call site, rather than as an uncaught revert.
async function ok<T>(step: Promise<T>, label: string): Promise<T> {
  const site: { stack?: string } = {}
  Error.captureStackTrace(site, ok)
  try {
    const result = await step
    const sent = result as unknown as { wait?: () => Promise<unknown> }
    if (typeof sent?.wait === "function") await sent.wait()
    return result
  } catch (error) {
    const { reason, message } = error as { reason?: string; message?: string }
    const failure: Error = new AssertionError(
      `${label} was refused: ${reason ?? message}`
    )
    failure.stack = `AssertionError: ${failure.message}\n${(site.stack ?? "")
      .split("\n")
      .slice(1)
      .join("\n")}`
    throw failure
  }
}

async function refused(step: Promise<unknown>, label: string) {
  await expect(step, label).to.be.reverted
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest()
const le = (value: BigNumberish, width: number) => {
  let n = BigInt(value.toString())
  const b = Buffer.alloc(width)
  for (let i = 0; i < width; i += 1) {
    b[i] = Number(n & 255n)
    n >>= 8n
  }
  return b
}
type Info = Tx["tx"]
type Input = {
  txHash: string
  txOutputIndex: number
  txOutputValue: BigNumberish
}
const rawOf = (t: Info) =>
  Buffer.concat([t.version, t.inputVector, t.outputVector, t.locktime].map(raw))
const hashOf = (t: Info) => `0x${sha(sha(rawOf(t))).toString("hex")}`
/// An unsigned custody-preserving transaction: the given inputs to one
/// output paying Q (the cancellation shape), in the helper's wire format.
const toQ = (
  inputs: Input[],
  value: BigNumberish,
  q: string,
  locktime = 0
) => ({
  version: "0x02000000",
  inputVector: `0x${Buffer.concat([
    Buffer.from([inputs.length]),
    ...inputs.flatMap((i) => [
      raw(i.txHash),
      le(i.txOutputIndex, 4),
      Buffer.from([0]),
      le(0xfffffffd, 4),
    ]),
  ]).toString("hex")}`,
  outputVector: `0x01${le(value, 8).toString("hex")}225120${q.slice(2)}`,
  locktime: `0x${le(locktime, 4).toString("hex")}`,
})
/// Independent keep-core taproot snapshot (prefix ‖ Q ‖ raw ‖ prevouts).
const snapshotOf = (t: Info, inputs: Input[], q: string) =>
  `0x${sha(
    Buffer.concat([
      Buffer.from("keep-core/taproot-snapshot/v1"),
      raw(q),
      rawOf(t),
      ...inputs.flatMap((i) => [
        le(i.txOutputValue, 8),
        Buffer.from([0x22]),
        raw(`0x5120${q.slice(2)}`),
      ]),
    ])
  ).toString("hex")}`

describe("M9 redemption Bridge guards (C-04 through the public Bridge)", function bridgeGuards() {
  this.timeout(180000)
  let w: World
  let x: Wallet
  let y: Wallet
  let z: Wallet
  let chainId: number
  let certificates: Contract
  let root: string
  // Each wallet's current main as a reservation input.
  const mains = new Map<string, Input>()
  let fundedMain: Input

  const custody = (wallet: Wallet = x) => w.frost.frostWalletCustody(wallet.id)
  const block = () => ethers.provider.getBlockNumber()
  const fund = async (wallet: Wallet, amount = FUNDED) => {
    const main = await ok(w.fund(wallet, amount), "setup: funding sweep")
    mains.set(wallet.id, {
      txHash: main.hash,
      txOutputIndex: 0,
      txOutputValue: amount - 1000,
    })
  }
  const mainOf = (wallet: Wallet = x) => {
    const m = mains.get(wallet.id)
    if (!m) throw Error("wallet has no main")
    return m
  }
  const requestCall = (
    wallet: Wallet,
    gross: BigNumberish,
    options: { script?: string; from?: SignerWithAddress } = {}
  ) =>
    w.frost
      .connect(options.from ?? w.depositor)
      .requestFrostRedemption(
        wallet.id,
        options.script ?? SCRIPT,
        gross,
        (options.from ?? w.depositor).address
      )
  const request = async (
    wallet: Wallet,
    gross: BigNumberish,
    options: { script?: string; from?: SignerWithAddress } = {}
  ) => {
    const from = options.from ?? w.depositor
    await w.bank.connect(from).approveBalance(w.frost.address, 0)
    await w.bank.connect(from).approveBalance(w.frost.address, gross)
    const id = await ok(
      w.frost
        .connect(from)
        .callStatic.requestFrostRedemption(
          wallet.id,
          options.script ?? SCRIPT,
          gross,
          from.address
        ),
      `request of ${gross} (static call)`
    )
    await ok(requestCall(wallet, gross, options), `request of ${gross}`)
    return id as string
  }
  const net = (gross: number) => gross - Math.floor(gross / 100)
  type Payee = { id: string; value: BigNumberish; script?: string }
  const propose = async (
    wallet: Wallet,
    payees: Payee[],
    fee: BigNumberish,
    options: {
      validUntilBlock?: number
      maximumFee?: BigNumberish
      inputs?: Input[]
      generationDelta?: number
    } = {}
  ) => {
    const c = await custody(wallet)
    return reservationProposal({
      bridge: w.frost.address,
      chainId,
      walletId: wallet.id,
      descriptorHash: wallet.descriptorHash,
      genesis: GENESIS,
      outputKey: wallet.q,
      generation: c.generation.add(options.generationDelta ?? 1),
      stateVersion: c.stateVersion,
      validUntilBlock: options.validUntilBlock ?? (await block()) + 100,
      inputs: options.inputs ?? [mainOf(wallet)],
      requests: payees.map((p) => ({
        id: p.id,
        value: p.value,
        script: p.script ?? SCRIPT,
      })),
      fee,
      maximumFee: options.maximumFee ?? TX_MAX_TOTAL_FEE,
      operators: [w.operator, w.owner],
    })
  }
  type Proposal = Awaited<ReturnType<typeof propose>>
  /// Re-derive the bindings of an altered certificate and re-sign it.
  const resign = async (
    p: Proposal,
    change: Record<string, unknown>,
    signers: SignerWithAddress[] = [w.operator, w.owner],
    seats: number[] = [1, 2]
  ): Promise<Proposal> => {
    const certificate = { ...p.certificate, ...change }
    const derived = await ok(
      certificates.derive(certificate, {
        snapshot: p.snapshot,
        genesis: GENESIS,
        requests: p.requests,
      }),
      "setup: re-deriving an altered certificate"
    )
    certificate.intentCommitment = derived.intentCommitment
    certificate.requestIdsHash = derived.requestIdsHash
    const digest = await certificates.digest(w.frost.address, certificate)
    const signatures = ethers.utils.hexConcat(
      await Promise.all(
        signers.map((s) => s.signMessage(ethers.utils.arrayify(digest)))
      )
    )
    return { ...p, certificate, seats, signatures }
  }
  /// The logical reservation ID (KC-SF-V3 C-04), computed independently.
  const reservationId = (p: Proposal) =>
    ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        [
          "bytes32",
          "uint256",
          "address",
          "bytes32",
          "bytes32",
          "uint64",
          "uint64",
          "bytes32",
        ],
        [
          ethers.utils.id("tbtc-v2/frost-reservation-id/v1"),
          chainId,
          w.frost.address,
          p.certificate.walletId,
          p.certificate.descriptorHash,
          p.certificate.generation,
          p.certificate.stateVersion,
          p.certificate.intentCommitment,
        ]
      )
    )
  const reserve = async (p: Proposal, label = "reservation") => {
    await ok(w.frost.reserveFrostRedemption(p), label)
    const id = reservationId(p)
    expect(
      (
        await custody(
          w.wallets.find((v) => v.id === p.certificate.walletId) ??
            ({ id: p.certificate.walletId } as Wallet)
        )
      ).activeReservation,
      `${label}: the active reservation`
    ).to.equal(id)
    return id
  }
  /// Pay a reservation with its exact transaction; track the change main.
  const pay = async (
    wallet: Wallet,
    id: string,
    p: Proposal,
    label = "payment"
  ) => {
    await ok(
      w.frost.submitFrostRedemptionProof(
        id,
        p.transaction,
        inclusion(hashOf(p.transaction))
      ),
      label
    )
    mains.set(wallet.id, {
      txHash: hashOf(p.transaction),
      txOutputIndex: p.requests.length,
      txOutputValue: p.change.toString(),
    })
  }
  const signAll = async (digest: string, signers: SignerWithAddress[]) =>
    ethers.utils.hexConcat(
      await Promise.all(
        signers.map((s) => s.signMessage(ethers.utils.arrayify(digest)))
      )
    )
  /// A cancellation of a reservation: its inputs back to Q less `fee`.
  const cancellation = async (
    wallet: Wallet,
    id: string,
    p: Proposal,
    fee: number,
    options: {
      validUntilBlock?: number
      seats?: number[]
      signers?: SignerWithAddress[]
      locktime?: number
    } = {}
  ) => {
    const inputs = p.inputs as Input[]
    const total = inputs.reduce(
      (s, i) => s + BigInt(i.txOutputValue.toString()),
      0n
    )
    const tx = toQ(inputs, total - BigInt(fee), wallet.q, options.locktime)
    const authorization = {
      reservationId: id,
      snapshot: snapshotOf(tx, inputs, wallet.q),
      transactionHash: hashOf(tx),
      fee,
      validUntilBlock: options.validUntilBlock ?? (await block()) + 100,
    }
    const digest = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", "uint256", "address", CANCELLATION_TYPE],
        [
          ethers.utils.id("tbtc-v2/frost-reservation-cancellation/v1"),
          chainId,
          w.frost.address,
          authorization,
        ]
      )
    )
    const seats = options.seats ?? [1, 2]
    const signatures = await signAll(
      digest,
      options.signers ?? [w.operator, w.owner]
    )
    return { tx, authorization, seats, signatures }
  }
  type Cancellation = Awaited<ReturnType<typeof cancellation>>
  const authorize = async (
    c: Cancellation,
    from: SignerWithAddress = w.depositor
  ) => {
    await w.bank.connect(from).approveBalance(w.frost.address, 0)
    await w.bank
      .connect(from)
      .approveBalance(w.frost.address, c.authorization.fee)
    return w.frost
      .connect(from)
      .authorizeFrostCancellation(c.authorization, c.tx, c.seats, c.signatures)
  }
  const cancellations = async (id: string) =>
    (await w.frost.frostCancellationCount(id)).toNumber()
  /// Register a wallet with its own roster through the registry fixture.
  const register = async (
    secret: number,
    operators: string[],
    threshold: number
  ): Promise<Wallet> => {
    const pub = ethers.utils.computePublicKey(
      ethers.utils.hexZeroPad(ethers.utils.hexlify(secret), 32),
      true
    )
    const q = `0x${pub.slice(4)}`
    const descriptor = {
      scheme: 2,
      profile: 1,
      chainId,
      registry: w.registry.address,
      epoch: await block(),
      members: operators.map((_, i) => i + 1),
      operators,
      threshold,
      snowfallDescriptor: ethers.utils.id(`M9 wallet ${secret}`),
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
    await w.registry.created(
      ethers.utils.defaultAbiCoder.encode([TYPE], [descriptor]),
      (await block()) + 100000
    )
    await w.registry.ready(id, descriptorHash)
    return {
      q,
      id,
      label: id.slice(0, 42),
      descriptor,
      descriptorHash,
      value: 0,
    }
  }
  const escrowOf = async (wallet: Wallet = x) =>
    (await w.frost.frostRedemptionEscrow(wallet.id)).map((v: BigNumber) =>
      v.toString()
    )

  before(async () => {
    w = await movementWorld(3)
    ;[x, y, z] = w.wallets
    chainId = (await ethers.provider.getNetwork()).chainId
    certificates = await deploy("FrostReservationCertificateFixture")
    // Redemption dust must exceed the moving-funds dust; lower that first.
    const movement = Array.from(await w.bridge.movingFundsParameters())
    movement[1] = 500
    await w.bridge.updateMovingFundsParameters(...movement)
    // dust, treasury divisor, tx max fee, tx max total fee, timeout,
    // slashing, notifier reward multiplier.
    await w.bridge.updateRedemptionParameters(
      DUST,
      100,
      TX_MAX_FEE,
      TX_MAX_TOTAL_FEE,
      TIMEOUT,
      0,
      0
    )
    await w.frost.configureFrostRedemptions(
      GENESIS,
      2,
      MAX_CERTIFICATE_BLOCKS,
      ethers.constants.AddressZero,
      EVIDENCE
    )
    await w.frost.setFrostRedemptionsEnabled(true)
    await fund(x)
    fundedMain = { ...mainOf(x) }
    root = await network.provider.send("evm_snapshot")
  })
  beforeEach(async () => {
    expect(await network.provider.send("evm_revert", [root])).to.equal(true)
    root = await network.provider.send("evm_snapshot")
    for (const wallet of w.wallets) {
      wallet.main = undefined
      wallet.value = 0
    }
    x.value = CUSTODY
    mains.clear()
    mains.set(x.id, { ...fundedMain })
  })

  describe("configuration (FrostRedemptionRequests.configure, setEnabled)", () => {
    const configure = (
      overrides: Partial<{
        genesis: string
        finality: number
        blocks: number
        watchtower: string
      }> = {}
    ) =>
      w.frost.configureFrostRedemptions(
        overrides.genesis ?? GENESIS,
        overrides.finality ?? 2,
        overrides.blocks ?? MAX_CERTIFICATE_BLOCKS,
        overrides.watchtower ?? ethers.constants.AddressZero,
        EVIDENCE
      )

    it("refuses configuration while enabled, with a zero window, a changed genesis or a watchtower without code (FrostRedemptionRequests.sol:139-153)", async () => {
      await refused(configure(), "configuration while enabled was accepted")
      await ok(w.frost.setFrostRedemptionsEnabled(false), "disable")
      await refused(
        configure({ finality: 0 }),
        "zero finality blocks were accepted"
      )
      await refused(
        configure({ blocks: 0 }),
        "zero maximum certificate blocks were accepted"
      )
      await refused(
        configure({ genesis: ethers.utils.id("M9 other network") }),
        "a changed genesis was accepted"
      )
      await refused(
        configure({ watchtower: w.signers[7].address }),
        "a watchtower without code was accepted"
      )
      expect(
        (await w.frost.frostRedemptionConfiguration()).finalityBlocks,
        "configuration unchanged"
      ).to.equal(2)
      await ok(configure({ finality: 3 }), "a valid reconfiguration")
    })

    it("requires a FROST watchtower once a legacy watchtower is set (FrostRedemptionRequests.sol:156)", async () => {
      await ok(w.frost.setFrostRedemptionsEnabled(false), "disable")
      await ok(
        w.bridge.setRedemptionWatchtower(w.signers[7].address),
        "set the legacy watchtower"
      )
      await refused(
        configure(),
        "no FROST watchtower was accepted beside a legacy one"
      )
      const watchtower = await deploy("FrostCapturedWatchtowerFixture", [
        ethers.utils.id("M9 policy"),
        0,
      ])
      await ok(
        configure({ watchtower: watchtower.address }),
        "a FROST watchtower beside the legacy one"
      )
    })
  })

  describe("quarantine (FrostRedemptionRequests.quarantine)", () => {
    const reason = ethers.utils.id("M9 quarantine reason (test value)")
    const evidence = ethers.utils.id("M9 quarantine evidence (test value)")
    it("needs the expected state version and nonzero reason and evidence, once (FrostRedemptionRequests.sol:64, :73)", async () => {
      const version = (await custody()).stateVersion
      await refused(
        w.frost.quarantineFrostWallet(x.id, version.add(1), reason, evidence),
        "a quarantine at a stale state version was accepted"
      )
      await refused(
        w.frost.quarantineFrostWallet(x.id, version, ZERO, evidence),
        "a quarantine with a zero reason was accepted"
      )
      await refused(
        w.frost.quarantineFrostWallet(x.id, version, reason, ZERO),
        "a quarantine with zero evidence was accepted"
      )
      expect((await custody()).stateVersion, "no version change").to.equal(
        version
      )
      await ok(
        w.frost.quarantineFrostWallet(x.id, version, reason, evidence),
        "the quarantine"
      )
      await refused(
        w.frost.quarantineFrostWallet(x.id, version.add(1), reason, evidence),
        "a second quarantine was accepted"
      )
    })

    it("refuses to quarantine a wallet whose custody has moved out (FrostRedemptionRequests.sol:68)", async () => {
      await w.enterMovingFunds(x)
      const targets = ascending([y, z])
      await ok(
        w.frost.connect(w.operator).submitFrostMovingFundsCommitment(
          x.id,
          0,
          targets.map((t) => t.label)
        ),
        "setup: movement commitment"
      )
      const values = split(CUSTODY - 3000, 2)
      const move = transaction(
        [[mainOf().txHash, 0]],
        targets.map((t, i) => ({ value: values[i], script: p2tr(t.q) }))
      )
      await ok(
        w.frost.submitFrostMovingFundsProof(
          x.id,
          move.tx,
          inclusion(move.hash)
        ),
        "setup: movement proof"
      )
      const c = await custody()
      expect(c.value, "setup: x holds no custody").to.equal(0)
      expect(c.stateVersion, "setup: x has a state version").to.be.gt(0)
      await refused(
        w.frost.quarantineFrostWallet(x.id, c.stateVersion, reason, evidence),
        "an empty wallet was quarantined"
      )
    })
  })

  describe("request admission (FrostRedemptionRequests.request)", () => {
    it("admits gross at the dust threshold and refuses one below or an unsupported script (FrostRedemptionRequests.sol:227, :228)", async () => {
      await w.bank.connect(w.depositor).approveBalance(w.frost.address, 100000)
      await refused(
        requestCall(x, DUST - 1),
        "a gross below the dust threshold was requested"
      )
      await refused(
        requestCall(x, DUST, { script: "0x6a" }),
        "an unsupported script was requested"
      )
      await request(x, DUST)
      expect((await escrowOf())[0], "escrow of the dust request").to.equal(
        String(DUST)
      )
    })

    it("charges no treasury fee with a zero divisor (FrostRedemptionRequests.sol:239)", async () => {
      await w.bridge.updateRedemptionParameters(
        DUST,
        0,
        TX_MAX_FEE,
        TX_MAX_TOTAL_FEE,
        TIMEOUT,
        0,
        0
      )
      const id = await request(x, 10000)
      expect(
        (await w.frost.frostRedemptionRequest(id)).treasuryFee,
        "treasury fee"
      ).to.equal(0)
    })

    it("admits net liability up to the recognized custody, inclusive (FrostRedemptionLedger.sol:243, :244)", async () => {
      await fund(y) // Bank credit for the depositor only.
      // net(605,050) = 605,050 - 6,050 = 599,000 = x's custody.
      expect(net(605050), "setup: exact net").to.equal(CUSTODY)
      await w.bank.connect(w.depositor).approveBalance(w.frost.address, 0)
      await w.bank.connect(w.depositor).approveBalance(w.frost.address, 605051)
      await refused(
        requestCall(x, 605051),
        "a net liability one satoshi above custody was admitted"
      )
      await request(x, 605050)
      expect((await escrowOf())[1], "net liability").to.equal(String(CUSTODY))
    })

    it("refuses requests to a quarantined or moving wallet (FrostRedemptionRequests.sol:205)", async () => {
      await w.bank.connect(w.depositor).approveBalance(w.frost.address, 100000)
      const version = (await custody()).stateVersion
      await ok(
        w.frost.quarantineFrostWallet(
          x.id,
          version,
          ethers.utils.id("M9 reason"),
          ethers.utils.id("M9 evidence")
        ),
        "setup: quarantine x"
      )
      await refused(
        requestCall(x, 10000),
        "a request to a quarantined wallet was admitted"
      )
      await fund(y)
      await w.enterMovingFunds(y)
      await refused(
        requestCall(y, 10000),
        "a request to a MovingFunds wallet was admitted"
      )
      expect((await escrowOf(x))[0], "no escrow on x").to.equal("0")
      expect((await escrowOf(y))[0], "no escrow on y").to.equal("0")
    })

    it("applies the watchtower policy, delay and request delay (FrostRedemptionRequests.sol:264-270; FrostRedemptions.sol:114)", async () => {
      const policy = ethers.utils.id("M9 watchtower policy")
      const watchtower = await deploy("FrostCapturedWatchtowerFixture", [
        policy,
        TIMEOUT,
      ])
      await ok(w.frost.setFrostRedemptionsEnabled(false), "disable")
      await ok(
        w.frost.configureFrostRedemptions(
          GENESIS,
          2,
          MAX_CERTIFICATE_BLOCKS,
          watchtower.address,
          EVIDENCE
        ),
        "configure the watchtower"
      )
      await ok(w.frost.setFrostRedemptionsEnabled(true), "enable")
      await w.bank.connect(w.depositor).approveBalance(w.frost.address, 100000)
      await refused(
        requestCall(x, 10000),
        "a delay equal to the redemption timeout was admitted"
      )
      await watchtower.changeRequestPolicy(ZERO, 0)
      await refused(
        requestCall(x, 10000),
        "a zero watchtower policy was admitted"
      )
      await watchtower.changeRequestPolicy(policy, 600)
      const id = await request(x, 10000)
      const { notBefore } = await w.frost.frostRedemptionPolicy(id)
      const p = await propose(x, [{ id, value: net(10000) - 1000 }], 1000)
      await network.provider.send("evm_setNextBlockTimestamp", [
        notBefore.toNumber() - 1,
      ])
      await refused(
        w.frost.reserveFrostRedemption(p),
        "a reservation before the request delay was admitted"
      )
      await network.provider.send("evm_setNextBlockTimestamp", [
        notBefore.toNumber(),
      ])
      await reserve(p, "a reservation exactly at the request delay")
    })
  })

  describe("reservation admission (FrostRedemptions.reserve, FrostRedemptionLedger.reserve)", () => {
    let a: string
    beforeEach(async () => {
      a = await request(x, 20000)
    })
    const share = (value: number) => net(20000) - value

    it("reserves the baseline and refuses a second active reservation (FrostRedemptionLedger.sol:117)", async () => {
      const id = await reserve(
        await propose(x, [{ id: a, value: share(1000) }], 1000)
      )
      expect((await custody()).activeReservation, "active").to.equal(id)
      const b = await request(x, 20000)
      const second = await propose(x, [{ id: b, value: share(1000) }], 1000)
      await refused(
        w.frost.reserveFrostRedemption(second),
        "a second reservation of the reserved main was admitted"
      )
      expect((await custody()).activeReservation, "still the first").to.equal(
        id
      )
    })

    it("refuses a stale generation, a non-main conflict and an unrecognized input (FrostRedemptionLedger.sol:122, :127, :148)", async () => {
      await refused(
        w.frost.reserveFrostRedemption(
          await propose(x, [{ id: a, value: share(1000) }], 1000, {
            generationDelta: 2,
          })
        ),
        "a certificate two generations ahead was admitted"
      )
      const p = await propose(x, [{ id: a, value: share(1000) }], 1000)
      await refused(
        w.frost.reserveFrostRedemption(
          await resign(p, { conflictOutputIndex: 1 })
        ),
        "a certificate naming a non-main conflict was admitted"
      )
      const foreign = {
        txHash: ethers.utils.id("M9 unrecognized custody"),
        txOutputIndex: 0,
        txOutputValue: 5000,
      }
      await refused(
        w.frost.reserveFrostRedemption(
          await propose(x, [{ id: a, value: share(1000) }], 1000, {
            inputs: [mainOf(), foreign],
          })
        ),
        "an unrecognized input was admitted"
      )
      expect((await custody()).activeReservation, "nothing reserved").to.equal(
        ZERO
      )
    })

    it("refuses a disabled route, a quarantined wallet and a bad certificate (FrostRedemptions.sol:26, :56, :130)", async () => {
      const p = await propose(x, [{ id: a, value: share(1000) }], 1000)
      await refused(
        w.frost.reserveFrostRedemption(
          await resign(p, {}, [w.operator, w.depositor])
        ),
        "a certificate signed by the wrong seat-2 operator was admitted"
      )
      await ok(w.frost.setFrostRedemptionsEnabled(false), "disable")
      await refused(
        w.frost.reserveFrostRedemption(p),
        "a reservation while disabled was admitted"
      )
      await ok(w.frost.setFrostRedemptionsEnabled(true), "enable")
      const version = (await custody()).stateVersion
      await ok(
        w.frost.quarantineFrostWallet(
          x.id,
          version,
          ethers.utils.id("M9 reason"),
          ethers.utils.id("M9 evidence")
        ),
        "setup: quarantine x"
      )
      await refused(
        w.frost.reserveFrostRedemption(
          await propose(x, [{ id: a, value: share(1000) }], 1000)
        ),
        "a reservation of a quarantined wallet was admitted"
      )
    })

    it("holds the certificate window [now, now + maximum] inclusively (FrostRedemptions.sol:39-41)", async () => {
      await refused(
        w.frost.reserveFrostRedemption(
          await propose(x, [{ id: a, value: share(1000) }], 1000, {
            validUntilBlock: (await block()) + 1 + MAX_CERTIFICATE_BLOCKS + 1,
          })
        ),
        "a certificate beyond the maximum window was admitted"
      )
      const edge = await propose(x, [{ id: a, value: share(1000) }], 1000, {
        validUntilBlock: (await block()) + 1 + MAX_CERTIFICATE_BLOCKS,
      })
      await reserve(edge, "a certificate at exactly now + maximum")
    })

    it("admits a certificate valid until the inclusion block (FrostRedemptions.sol:40)", async () => {
      const p = await propose(x, [{ id: a, value: share(1000) }], 1000, {
        validUntilBlock: (await block()) + 1,
      })
      await reserve(p, "a certificate valid until its inclusion block")
    })

    it("admits a maximum fee equal to redemptionTxMaxTotalFee and refuses one above (FrostRedemptions.sol:65, :66)", async () => {
      await refused(
        w.frost.reserveFrostRedemption(
          await propose(x, [{ id: a, value: share(1000) }], 1000, {
            maximumFee: TX_MAX_TOTAL_FEE + 1,
          })
        ),
        "a maximum fee above redemptionTxMaxTotalFee was admitted"
      )
      await reserve(
        await propose(x, [{ id: a, value: share(1000) }], 1000, {
          maximumFee: TX_MAX_TOTAL_FEE,
        }),
        "a maximum fee equal to redemptionTxMaxTotalFee"
      )
    })

    it("holds each request's fee share in [0, maximumBitcoinFee] and the allocation equal to the fee (FrostRedemptions.sol:101, :124; FrostRedemptionLedger.sol:196-199)", async () => {
      await refused(
        w.frost.reserveFrostRedemption(
          await propose(
            x,
            [{ id: a, value: share(TX_MAX_FEE + 1) }],
            TX_MAX_FEE + 1
          )
        ),
        "a fee share above maximumBitcoinFee was admitted"
      )
      // Allocation 500 against a 1,000 transaction fee.
      const shifted = await propose(x, [{ id: a, value: share(500) }], 1000)
      await refused(
        w.frost.reserveFrostRedemption(shifted),
        "a fee allocation unequal to the transaction fee was admitted"
      )
      const b = await request(x, 20000)
      // a pays nothing toward the fee; b's share is the maximum.
      await reserve(
        await propose(
          x,
          [
            { id: a, value: share(0) },
            { id: b, value: share(TX_MAX_FEE) },
          ],
          TX_MAX_FEE
        ),
        "a zero share beside a share of exactly maximumBitcoinFee"
      )
    })

    it("reserves a batch of exactly 64 requests, the maximum (FrostRedemptionLedger.sol:172)", async () => {
      // a plus 63 more dust requests; a carries the whole 1,000 fee.
      const ids = [a]
      for (let i = 1; i < 64; i++) ids.push(await request(x, DUST))
      const payees = ids.map((id, i) => ({
        id,
        value: i === 0 ? share(1000) : net(DUST),
      }))
      await reserve(
        await propose(x, payees, 1000),
        "a reservation of 64 requests"
      )
    })

    it("refuses a duplicate request, one past its deadline and one bound to another script (FrostRedemptionLedger.sol:182, :186, :189)", async () => {
      await refused(
        w.frost.reserveFrostRedemption(
          await propose(
            x,
            [
              { id: a, value: share(500) },
              { id: a, value: share(500) },
            ],
            1000
          )
        ),
        "a plan paying one request twice was admitted"
      )
      await refused(
        w.frost.reserveFrostRedemption(
          await propose(
            x,
            [{ id: a, value: share(1000), script: OTHER_SCRIPT }],
            1000
          )
        ),
        "a payout to a script other than the request's was admitted"
      )
      const { deadline } = await w.frost.frostRedemptionRequest(a)
      const p = await propose(x, [{ id: a, value: share(1000) }], 1000)
      await network.provider.send("evm_setNextBlockTimestamp", [
        deadline.toNumber(),
      ])
      await refused(
        w.frost.reserveFrostRedemption(p),
        "a request was reserved at its deadline"
      )
      expect(
        (await w.frost.frostRedemptionRequest(a)).state,
        "the request is still Requested"
      ).to.equal(Request.Requested)
    })
  })

  describe("payment (FrostRedemptionSettlement.submitPayment, FrostRedemptionLedger.pay)", () => {
    it("pays only the reserved transaction, leaving change equal to the remaining liabilities (FrostRedemptionSettlement.sol:117; FrostRedemptionLedger.sol:515)", async () => {
      await fund(y) // Bank credit for the depositor only.
      const a = await request(x, 20000)
      // b uses the remaining capacity exactly: 19,800 + 579,200 = 599,000.
      expect(net(20000) + net(585050), "setup: full capacity").to.equal(CUSTODY)
      const b = await request(x, 585050)
      const p = await propose(x, [{ id: a, value: net(20000) - 1000 }], 1000)
      const id = await reserve(p)
      const other = { ...p.transaction, locktime: "0x01000000" }
      await refused(
        w.frost.submitFrostRedemptionProof(id, other, inclusion(hashOf(other))),
        "a payment by a transaction other than the reserved one was accepted"
      )
      expect(
        (await w.frost.frostReservation(id)).state,
        "still Reserved"
      ).to.equal(Intent.Reserved)
      await pay(x, id, p, "the payment leaving change equal to b's liability")
      const c = await custody()
      expect(c.value, "change").to.equal(net(585050))
      expect((await escrowOf())[1], "b's liability").to.equal(
        String(net(585050))
      )
      expect(
        (await w.frost.frostRedemptionRequest(b)).state,
        "b pending"
      ).to.equal(Request.Requested)
    })

    it("refunds a resolved request only when it is Refundable (FrostRedemptionLedger.sol:453)", async () => {
      const a = await request(x, 20000)
      const before = await w.bank.balanceOf(w.depositor.address)
      await refused(
        w.frost.refundResolvedFrostRedemption(a),
        "a Requested request was refunded as resolved"
      )
      expect(
        await w.bank.balanceOf(w.depositor.address),
        "no refund paid"
      ).to.equal(before)
      expect((await escrowOf())[0], "escrow kept").to.equal("20000")
    })
  })

  describe("cancellation (FrostCancellationAdmissions, FrostCancellationCertificate)", () => {
    let a: string
    let id: string
    let p: Proposal
    beforeEach(async () => {
      a = await request(x, 20000)
      p = await propose(x, [{ id: a, value: net(20000) - 1000 }], 1000)
      id = await reserve(p)
    })

    it("authorizes and proves the baseline cancellation", async () => {
      const c = await cancellation(x, id, p, 1000)
      await ok(authorize(c), "the baseline authorization")
      expect(await cancellations(id), "one alternative").to.equal(1)
      await ok(
        w.frost.submitFrostCancellationProof(id, c.tx, inclusion(hashOf(c.tx))),
        "the baseline cancellation proof"
      )
      expect((await w.frost.frostReservation(id)).state, "Cancelled").to.equal(
        Intent.Cancelled
      )
      expect((await custody()).value, "custody less the fee").to.equal(
        CUSTODY - 1000
      )
    })

    it("holds the authorization window [now, now + maximum] inclusively (FrostCancellationAdmissions.sol:31-33; FrostCancellationCertificate.sol:59)", async () => {
      await refused(
        authorize(
          await cancellation(x, id, p, 1000, {
            validUntilBlock: (await block()) + 3 + MAX_CERTIFICATE_BLOCKS + 1,
          })
        ),
        "an authorization beyond the maximum window was admitted"
      )
      // authorize() sends two approvals first: inclusion is block + 3.
      await ok(
        authorize(
          await cancellation(x, id, p, 1100, {
            validUntilBlock: (await block()) + 3,
          })
        ),
        "an authorization valid until its inclusion block"
      )
      await ok(
        authorize(
          await cancellation(x, id, p, 1200, {
            validUntilBlock: (await block()) + 3 + MAX_CERTIFICATE_BLOCKS,
          })
        ),
        "an authorization at exactly now + maximum"
      )
      expect(await cancellations(id), "two alternatives").to.equal(2)
    })

    it("refuses an authorization naming another transaction, or signed wrongly (FrostCancellationAdmissions.sol:75, :100)", async () => {
      const signed = await cancellation(x, id, p, 1000)
      const other = await cancellation(x, id, p, 1000, { locktime: 1 })
      await refused(
        authorize({ ...signed, tx: other.tx }),
        "an authorization for one transaction admitted another"
      )
      await refused(
        authorize(
          await cancellation(x, id, p, 1000, {
            signers: [w.operator, w.depositor],
          })
        ),
        "a certificate signed by the wrong seat-2 operator was admitted"
      )
      expect(await cancellations(id), "no alternative").to.equal(0)
    })

    it("admits the last seat and every seat, and refuses repeated or descending seats (FrostCancellationCertificate.sol:52, :68-71)", async () => {
      await ok(
        authorize(
          await cancellation(x, id, p, 1000, {
            seats: [1, 3],
            signers: [w.operator, w.depositor],
          })
        ),
        "seats [1, 3] (the last seat)"
      )
      await ok(
        authorize(
          await cancellation(x, id, p, 1100, {
            seats: [1, 2, 3],
            signers: [w.operator, w.owner, w.depositor],
          })
        ),
        "seats [1, 2, 3] (every seat)"
      )
      await refused(
        authorize(
          await cancellation(x, id, p, 1200, {
            seats: [1, 1],
            signers: [w.operator, w.operator],
          })
        ),
        "a repeated seat was admitted"
      )
      await refused(
        authorize(
          await cancellation(x, id, p, 1200, {
            seats: [2, 1],
            signers: [w.owner, w.operator],
          })
        ),
        "descending seats were admitted"
      )
      expect(await cancellations(id), "two alternatives").to.equal(2)
    })
  })

  describe("cancellation exposure (FrostRedemptionLedger.cancellationExposureFor)", () => {
    it("refuses a fee that strands other pending liabilities and admits the equality (FrostRedemptionLedger.sol:260, :265)", async () => {
      await fund(y) // Bank credit for the depositor only.
      const a = await request(x, DUST) // net 2,970
      const p = await propose(x, [{ id: a, value: net(DUST) - 1000 }], 1000)
      const id = await reserve(p)
      // b pending: 2,970 + 596,030 = 599,000 = custody.
      const b = await request(x, 602050)
      expect(net(602050), "setup: b's net").to.equal(CUSTODY - net(DUST))
      // Fee 4,000: custody - fee = 595,000 < 596,030 strands b.
      await refused(
        authorize(await cancellation(x, id, p, 4000)),
        "a cancellation fee stranding a pending liability was admitted"
      )
      // Fee 2,970: custody - fee = 596,030 = b's liability exactly.
      await ok(
        authorize(await cancellation(x, id, p, net(DUST))),
        "a cancellation fee leaving custody equal to b's liability"
      )
      expect(
        (await w.frost.frostRedemptionRequest(b)).state,
        "b pending"
      ).to.equal(Request.Requested)
    })
  })

  describe("rosters at their bounds (FrostCancellationCertificate.sol:47, :50)", () => {
    it("reserves and cancels with a 100-seat roster whose threshold is 100", async () => {
      // One operator holds every seat and signs for each (the documented
      // rule); registration admits n = 100 and threshold = n.
      const wide = await register(
        4242,
        Array(100).fill(w.operator.address),
        100
      )
      await fund(wide, 100000)
      const a = await request(wide, 20000)
      const seats = Array.from({ length: 100 }, (_, i) => i + 1)
      const signers = Array(100).fill(w.operator)
      const p = await resign(
        await propose(wide, [{ id: a, value: net(20000) - 1000 }], 1000),
        {},
        signers,
        seats
      )
      const id = await reserve(p, "a 100-of-100 reservation")
      await ok(
        authorize(await cancellation(wide, id, p, 1000, { seats, signers })),
        "a 100-of-100 cancellation"
      )
      expect(await cancellations(id), "one alternative").to.equal(1)
    })
  })

  describe("sweep resolution (FrostRedemptionLedger.resolveSweep)", () => {
    it("resolves only the transaction its authorization names (FrostRedemptionLedger.sol:395, :431)", async () => {
      const a = await request(x, 20000)
      const p = await propose(x, [{ id: a, value: net(20000) - 1000 }], 1000)
      const id = await reserve(p)
      const d = await ok(w.reveal(x, 50000), "setup: reveal")
      const main = mainOf()
      const sweep = (value: number) =>
        transaction(
          [
            [d.hash, 0],
            [main.txHash, main.txOutputIndex],
          ],
          [{ value, script: p2tr(x.q) }]
        )
      const named = sweep(CUSTODY + 49000)
      const unnamed = sweep(CUSTODY + 48900)
      const authorization = {
        reservationId: id,
        transactionHash: named.hash,
        vault: ethers.constants.AddressZero,
        validUntilBlock: (await block()) + 100,
      }
      const digest = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ["bytes32", "uint256", "address", RESOLUTION_TYPE],
          [
            ethers.utils.id("tbtc-v2/frost-reservation-sweep-resolution/v1"),
            chainId,
            w.frost.address,
            authorization,
          ]
        )
      )
      const signatures = await signAll(digest, [w.operator, w.owner])
      const resolution = (t: Tx) => ({
        sweep: {
          walletId: x.id,
          transaction: t.tx,
          proof: inclusion(t.hash),
          includeMain: true,
          vault: ethers.constants.AddressZero,
        },
        authorization,
        seats: [1, 2],
        signatures,
      })
      await refused(
        w.frost.submitFrostSweepResolutionProof(resolution(unnamed)),
        "a sweep other than the authorized one resolved the reservation"
      )
      expect(
        (await w.frost.frostReservation(id)).state,
        "still Reserved"
      ).to.equal(Intent.Reserved)
      // No cancellation was authorized: nothing to return to a sponsor.
      await ok(
        w.frost.submitFrostSweepResolutionProof(resolution(named)),
        "the authorized sweep resolution"
      )
      expect(
        (await w.frost.frostReservation(id)).state,
        "ConflictResolved"
      ).to.equal(Intent.ConflictResolved)
    })
  })

  describe("legacy redemption proof (Redemption.submitRedemptionProof)", () => {
    it("completes a legacy redemption with no FROST drain committed (Redemption.sol:736)", async () => {
      // A legacy wallet through the real registry callback, funded by a
      // real legacy deposit reveal and sweep proof (synthetic inclusion).
      const pub = ethers.utils.computePublicKey(
        ethers.utils.hexZeroPad(ethers.utils.hexlify(7001), 32)
      )
      await ok(
        w.legacyRegistry.publish(
          ethers.utils.id("M9 legacy wallet"),
          `0x${pub.slice(4, 68)}`,
          `0x${pub.slice(68)}`
        ),
        "setup: legacy wallet"
      )
      const pkh = ethers.utils.ripemd160(
        ethers.utils.sha256(ethers.utils.computePublicKey(pub, true))
      )
      const now = (await ethers.provider.getBlock("latest")).timestamp
      const locktime = le(now + 30 * 86400, 4)
      const blinding = ethers.utils.hexZeroPad("0x4d39", 8)
      const script = `0x14${w.depositor.address.slice(2)}7508${blinding.slice(
        2
      )}7576a914${pkh.slice(2)}8763ac6776a914${pkh.slice(
        2
      )}8804${locktime.toString("hex")}b175ac68`
      const funding = transaction(
        [[ethers.utils.id("M9 legacy funding"), 0]],
        [
          {
            value: 300000,
            script: Buffer.from(
              `220020${ethers.utils.sha256(script).slice(2)}`,
              "hex"
            ),
          },
        ]
      )
      await ok(
        w.bridge.connect(w.depositor).revealDeposit(funding.tx, {
          fundingOutputIndex: 0,
          blindingFactor: blinding,
          walletPubKeyHash: pkh,
          refundPubKeyHash: pkh,
          refundLocktime: `0x${locktime.toString("hex")}`,
          vault: ethers.constants.AddressZero,
        }),
        "setup: legacy deposit reveal"
      )
      const funded = transaction(
        [[funding.hash, 0]],
        [{ value: 299000, script: p2wpkh(pkh) }]
      )
      await ok(
        w.bridge.submitDepositSweepProof(
          funded.tx,
          inclusion(funded.hash),
          { txHash: ZERO, txOutputIndex: 0, txOutputValue: 0 },
          ethers.constants.AddressZero
        ),
        "setup: legacy deposit sweep"
      )
      const main = {
        txHash: funded.hash,
        txOutputIndex: 0,
        txOutputValue: 299000,
      }
      const redeemer = `0x160014${ethers.utils
        .id("M9 legacy redeemer")
        .slice(2, 42)}`
      await w.bank.connect(w.depositor).approveBalance(w.bridge.address, 100000)
      await ok(
        w.bridge
          .connect(w.depositor)
          .requestRedemption(pkh, main, redeemer, 100000),
        "setup: legacy redemption request"
      )
      // 100,000 less the 1,000 treasury fee and a 1,000 fee share.
      const payment = transaction(
        [[main.txHash, 0]],
        [
          { value: 98000, script: Buffer.from(redeemer.slice(2), "hex") },
          { value: 200000, script: p2wpkh(pkh) },
        ]
      )
      expect(
        await w.frost.frostDrainTargets(pkh),
        "setup: no FROST drain committed"
      ).to.deep.equal([])
      await ok(
        w.bridge.submitRedemptionProof(
          payment.tx,
          inclusion(payment.hash),
          main,
          pkh
        ),
        "the legacy redemption proof with no drain"
      )
      expect(
        (await w.bridge.wallets(pkh)).mainUtxoHash,
        "the change is the new legacy main"
      ).to.equal(
        ethers.utils.solidityKeccak256(
          ["bytes32", "uint32", "uint64"],
          [payment.hash, 1, 200000]
        )
      )
    })
  })

  describe("reentry through a trusted vault callback (FROST redemption entry guards)", () => {
    let vault: Contract
    const sweepThroughVault = async (payload: string) => {
      await vault.configure([payload], false)
      const d = await ok(
        w.reveal(y, 50000, 86400, vault.address),
        "setup: vault reveal"
      )
      const t = transaction(
        [[d.hash, 0]],
        [{ value: 49000, script: p2tr(y.q) }]
      )
      await ok(
        w.frost.submitFrostDepositSweepProof({
          walletId: y.id,
          transaction: t.tx,
          proof: inclusion(t.hash),
          includeMain: false,
          vault: vault.address,
        }),
        "setup: the vault deposit sweep"
      )
      expect(await vault.calls(), "setup: one callback").to.equal(1)
      expect(
        await vault.callbackSuccess(0),
        "the reentrant FROST call succeeded inside the deposit sweep"
      ).to.equal(false)
    }
    beforeEach(async () => {
      vault = await deploy("FrostVaultCallbackFixture", [
        w.bank.address,
        w.frost.address,
      ])
      await w.bridge.setVaultStatus(vault.address, true)
    })

    it("refuses a reentrant request (FrostRedemptionRequests.sol:119)", async () => {
      await sweepThroughVault(
        w.frost.interface.encodeFunctionData("requestFrostRedemption", [
          x.id,
          SCRIPT,
          DUST,
          vault.address,
        ])
      )
      expect((await escrowOf())[0], "no escrow").to.equal("0")
    })

    it("refuses a reentrant reservation (FrostRedemptions.sol:12)", async () => {
      const a = await request(x, 20000)
      const p = await propose(x, [{ id: a, value: net(20000) - 1000 }], 1000)
      await sweepThroughVault(
        w.frost.interface.encodeFunctionData("reserveFrostRedemption", [p])
      )
      expect((await custody()).activeReservation, "nothing reserved").to.equal(
        ZERO
      )
    })

    it("refuses a reentrant payment proof (FrostRedemptionSettlement.sol:28)", async () => {
      const a = await request(x, 20000)
      const p = await propose(x, [{ id: a, value: net(20000) - 1000 }], 1000)
      const id = await reserve(p)
      // Proofs are SPV-maintainer only; the vault is made one so that only
      // the reentry guard can refuse its call.
      await ok(
        w.bridge.setSpvMaintainerStatus(vault.address, true),
        "setup: the vault is an SPV maintainer"
      )
      await sweepThroughVault(
        w.frost.interface.encodeFunctionData("submitFrostRedemptionProof", [
          id,
          p.transaction,
          inclusion(hashOf(p.transaction)),
        ])
      )
      expect(
        (await w.frost.frostReservation(id)).state,
        "still Reserved"
      ).to.equal(Intent.Reserved)
    })

    it("refuses a reentrant cancellation authorization (FrostCancellationAdmissions.sol:19)", async () => {
      const a = await request(x, 20000)
      const p = await propose(x, [{ id: a, value: net(20000) - 1000 }], 1000)
      const id = await reserve(p)
      const c = await cancellation(x, id, p, 1000)
      await sweepThroughVault(
        w.frost.interface.encodeFunctionData("authorizeFrostCancellation", [
          c.authorization,
          c.tx,
          c.seats,
          c.signatures,
        ])
      )
      expect(await cancellations(id), "no alternative").to.equal(0)
    })
  })
})
