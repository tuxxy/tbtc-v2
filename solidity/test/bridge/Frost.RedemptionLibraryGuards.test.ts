/* eslint-disable no-await-in-loop, no-restricted-syntax, no-bitwise */
// Mutation batch M9 (tbtc-v2 redemption, cancellation and lifecycle fraud),
// 2026-11-10 campaign, MUTATION-REPORT sections 3 and 4: library guards of
// the C-04 redemption path that the judges ran without an assertion failing.
// Every case names the guard it holds and the boundary it pins; each guard
// has a case that fails at its own assertion when the guard is removed or
// its operator is changed.
//
// Invariants (KC-SF-V3 C-04; FrostRedemptionTransaction,
// FrostReservationCertificate, FrostRedemptionLedger,
// FrostCancellationHistory):
// - A redemption transaction pays at least one request; every recognized
//   input carries a nonzero hash and a positive value; every output script
//   has exactly the expected length (no trailing bytes). The fee policy
//   admits its maxima (2.1e15 satoshi fee, 2.1e15 sat/vB rate) inclusively.
// - A reservation certificate's fee domain needs a positive minimum, a
//   maximum at least the minimum and at most 2.1e15, and a positive rate cap
//   at most 2.1e15; the boundary values are admitted. A plan holds 1 to 64
//   requests, both inclusive. A roster of 100 seats, a threshold equal to
//   the roster, all seats signing and the last seat signing are admitted.
// - A request deadline may be exactly the uint64 maximum.
// - Cancellation history: alternatives append only to an unresolved intent
//   without a recorded winner; a winner is a known alternative whose budget
//   is not yet settled; a first-budget return needs a first alternative; a
//   refund names a known alternative.
//
// FIXTURES: the existing library fixtures FrostRedemptionTransactionFixture,
// FrostReservationCertificateFixture, FrostRedemptionLedgerFixture (with its
// controlled test credit, not a Bitcoin witness) and
// FrostCancellationHistoryFixture (synthetic intent state; no Bank, custody,
// SPV or signatures). The INTENT-V2 vector (test/data/frost/intent-v2.json)
// supplies a valid output key and request. Transactions are encoded
// independently here; no fixture hash is used to build an input.
import { ethers, network } from "hardhat"
import { AssertionError, expect } from "chai"
import { Contract } from "ethers"
import vectors from "../data/frost/intent-v2.json"

const MAX_SATOSHI = "2100000000000000"
const UINT64_MAX = ethers.BigNumber.from(2).pow(64).sub(1)
const ZERO = ethers.constants.HashZero

/// Awaits a step that must succeed: a refusal fails as a named assertion
/// whose stack starts at the call site, rather than as an uncaught revert.
async function ok<T>(step: Promise<T>, label: string): Promise<T> {
  const site: { stack?: string } = {}
  Error.captureStackTrace(site, ok)
  try {
    return await step
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

/// A step that must be refused (any revert); acceptance is a named failure.
async function refused(step: Promise<unknown>, label: string) {
  await expect(step, label).to.be.reverted
}

// Independent Bitcoin wire encoding (version 2, empty scriptSigs).
type Input = { txHash: string; txOutputIndex: number; txOutputValue: string }
type Output = { value: string; script: string }
const bytes = (s: string) => Buffer.from(s.replace(/^0x/, ""), "hex")
const hex = (b: Buffer) => `0x${b.toString("hex")}`
const le = (value: string | number | bigint, width: number) => {
  let n = BigInt(value)
  const b = Buffer.alloc(width)
  for (let i = 0; i < width; i += 1) {
    b[i] = Number(n & 255n)
    n >>= 8n
  }
  return b
}
const compact = (n: number) =>
  n < 253 ? le(n, 1) : Buffer.concat([Buffer.from([253]), le(n, 2)])
/// Outputs carry their own script length so a case can declare any length.
const transaction = (
  inputs: Input[],
  outputs: (Output & { length?: number })[]
) => ({
  version: "0x02000000",
  inputVector: hex(
    Buffer.concat([
      compact(inputs.length),
      ...inputs.flatMap((i) => [
        bytes(i.txHash),
        le(i.txOutputIndex, 4),
        Buffer.from([0]),
        le(0xfffffffd, 4),
      ]),
    ])
  ),
  outputVector: hex(
    Buffer.concat([
      compact(outputs.length),
      ...outputs.flatMap((o) => [
        le(o.value, 8),
        compact(o.length ?? bytes(o.script).length),
        bytes(o.script),
      ]),
    ])
  ),
  locktime: "0x00000000",
})

const KEY = `0x${vectors[0].outputKey}`
const CHANGE = `0x5120${vectors[0].outputKey}`
const PAYEE = `0x${vectors[0].requests[0].script}`
const REQUEST = {
  id: `0x${vectors[0].requests[0].id}`,
  value: vectors[0].requests[0].value,
  script: PAYEE,
}
const INPUT = {
  txHash: `0x${vectors[0].conflictHash}`,
  txOutputIndex: 0,
  txOutputValue: "100000",
}

describe("M9 redemption library guards: canonical transactions", () => {
  let tx: Contract
  before(async () => {
    tx = await (
      await ethers.getContractFactory("FrostRedemptionTransactionFixture")
    ).deploy()
  })

  it("validates the INTENT-V2 redemption as the accepted baseline", async () => {
    const t = transaction(
      [INPUT],
      [
        { value: REQUEST.value, script: PAYEE },
        { value: "89000", script: CHANGE },
      ]
    )
    const result = await ok(
      tx.validateRedemption(t, KEY, [INPUT], [REQUEST]),
      "the baseline redemption"
    )
    expect(result.fee, "baseline fee").to.equal(1000)
  })

  it("refuses a redemption that pays no request (FrostRedemptionTransaction.sol:32)", async () => {
    // The custody-preserving shape is a cancellation, never a redemption.
    const t = transaction([INPUT], [{ value: "99000", script: CHANGE }])
    await ok(
      tx.validateCancellation(t, KEY, [INPUT]),
      "the same shape as a cancellation"
    )
    await refused(
      tx.validateRedemption(t, KEY, [INPUT], []),
      "a redemption with no payee was validated"
    )
  })

  it("refuses a recognized input with zero value or zero hash (FrostRedemptionTransaction.sol:135-137)", async () => {
    const second = {
      txHash: ethers.utils.id("M9 second recognized input"),
      txOutputIndex: 3,
      txOutputValue: "50000",
    }
    const outputs = [
      { value: REQUEST.value, script: PAYEE },
      { value: "139000", script: CHANGE },
    ]
    await ok(
      tx.validateRedemption(
        transaction([INPUT, second], outputs),
        KEY,
        [INPUT, second],
        [REQUEST]
      ),
      "the two-input baseline"
    )
    // Zero value: the input total is unchanged when the second value is 0,
    // so only the per-input guard can refuse it.
    const zeroValue = { ...second, txOutputValue: "0" }
    const zeroOutputs = [
      { value: REQUEST.value, script: PAYEE },
      { value: "89000", script: CHANGE },
    ]
    await refused(
      tx.validateRedemption(
        transaction([INPUT, zeroValue], zeroOutputs),
        KEY,
        [INPUT, zeroValue],
        [REQUEST]
      ),
      "a zero-valued recognized input was validated"
    )
    const zeroHash = { ...second, txHash: ZERO }
    await refused(
      tx.validateRedemption(
        transaction([INPUT, zeroHash], outputs),
        KEY,
        [INPUT, zeroHash],
        [REQUEST]
      ),
      "a zero-hash recognized input was validated"
    )
  })

  it("refuses an output script with trailing bytes beyond the expected script (FrostRedemptionTransaction.sol:201)", async () => {
    // The declared length is one byte longer; the first bytes still match.
    for (const [label, outputs] of [
      [
        "change script plus one byte",
        [
          { value: REQUEST.value, script: PAYEE },
          { value: "89000", script: `${CHANGE}00` },
        ],
      ],
      [
        "payee script plus one byte",
        [
          { value: REQUEST.value, script: `${PAYEE}00` },
          { value: "89000", script: CHANGE },
        ],
      ],
    ] as [string, Output[]][]) {
      await refused(
        tx.validateRedemption(
          transaction([INPUT], outputs),
          KEY,
          [INPUT],
          [REQUEST]
        ),
        `${label} was validated`
      )
    }
  })

  it("admits the fee policy maxima inclusively (FrostRedemptionTransaction.sol:67, :69)", async () => {
    const t = transaction(
      [INPUT],
      [
        { value: REQUEST.value, script: PAYEE },
        { value: "89000", script: CHANGE },
      ]
    )
    const result = await ok(
      tx.validateRedemption(t, KEY, [INPUT], [REQUEST]),
      "the baseline redemption"
    )
    await ok(
      tx.validateFees(result, 1, MAX_SATOSHI, 100),
      "maximum fee exactly 2.1e15"
    )
    await ok(
      tx.validateFees(result, 1, 2000, MAX_SATOSHI),
      "maximum rate exactly 2.1e15 sat/vB"
    )
    await refused(
      tx.validateFees(result, 1, "2100000000000001", 100),
      "a maximum fee above 2.1e15 was admitted"
    )
    await refused(
      tx.validateFees(result, 1, 2000, "2100000000000001"),
      "a maximum rate above 2.1e15 was admitted"
    )
  })
})

const descriptorType =
  "tuple(uint8 scheme,uint8 profile,uint256 chainId,address registry,uint64 epoch,uint32[] members,address[] operators,uint16 threshold,bytes32 snowfallDescriptor,bytes32 outputKey)"

describe("M9 redemption library guards: reservation certificates", () => {
  let cert: Contract
  let signers: Awaited<ReturnType<typeof ethers.getSigners>>
  let chainId: number
  before(async () => {
    cert = await (
      await ethers.getContractFactory("FrostReservationCertificateFixture")
    ).deploy()
    signers = await ethers.getSigners()
    chainId = (await ethers.provider.getNetwork()).chainId
  })

  const plan = (requests = [REQUEST]) => ({
    snapshot: `0x${vectors[0].snapshot}`,
    genesis: `0x${vectors[0].genesis}`,
    requests,
  })
  const descriptorOf = (operators: string[], threshold: number) => ({
    scheme: 2,
    profile: 1,
    chainId,
    registry: signers[0].address,
    epoch: 1,
    members: operators.map((_, i) => i + 1),
    operators,
    threshold,
    snowfallDescriptor: ethers.utils.id("M9 certificate descriptor"),
    outputKey: KEY,
  })
  const reservationOf = async (
    descriptor: ReturnType<typeof descriptorOf>,
    fee: Record<string, unknown> = {}
  ) => ({
    walletId: ethers.utils.keccak256(
      ethers.utils.concat([ethers.utils.id("tbtc-v2/frost-wallet-id/v1"), KEY])
    ),
    descriptorHash: ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", descriptorType],
        [ethers.utils.id("tbtc-v2/frost-descriptor/v1"), descriptor]
      )
    ),
    generation: 1,
    stateVersion: 1,
    intentCommitment: ZERO,
    requestIdsHash: ZERO,
    conflictTxHash: INPUT.txHash,
    conflictOutputIndex: 0,
    minimumFee: 100,
    maximumFee: 2000,
    maximumSatPerVByte: 20,
    validUntilBlock: (await ethers.provider.getBlockNumber()) + 1000,
    ...fee,
  })
  /// Derive both bindings, sign with each seat's operator, then validate.
  const signedValidate = async (
    descriptor: ReturnType<typeof descriptorOf>,
    seats: number[]
  ) => {
    const r = await reservationOf(descriptor)
    const derived = await ok(cert.derive(r, plan()), "setup: derive bindings")
    const reservation = {
      ...r,
      intentCommitment: derived.intentCommitment,
      requestIdsHash: derived.requestIdsHash,
    }
    const digest = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        [
          "bytes32",
          "uint256",
          "address",
          "tuple(bytes32 walletId,bytes32 descriptorHash,uint64 generation,uint64 stateVersion,bytes32 intentCommitment,bytes32 requestIdsHash,bytes32 conflictTxHash,uint32 conflictOutputIndex,uint64 minimumFee,uint64 maximumFee,uint64 maximumSatPerVByte,uint64 validUntilBlock)",
        ],
        [
          ethers.utils.id("tbtc-v2/frost-redemption-reservation/v2"),
          chainId,
          signers[0].address,
          reservation,
        ]
      )
    )
    const bySigner = new Map(signers.map((s) => [s.address, s]))
    const signatures = ethers.utils.hexConcat(
      await Promise.all(
        seats.map((seat) => {
          const signer = bySigner.get(descriptor.operators[seat - 1])
          if (!signer) throw Error("unknown operator")
          return signer.signMessage(ethers.utils.arrayify(digest))
        })
      )
    )
    return cert.validate(
      signers[0].address,
      descriptor,
      reservation,
      plan(),
      seats,
      signatures
    )
  }
  const three = () => signers.slice(1, 4).map((s) => s.address)

  it("accepts a 2-of-3 certificate as the baseline", async () => {
    expect(
      await signedValidate(descriptorOf(three(), 2), [1, 2]),
      "baseline"
    ).to.equal(true)
  })

  it("accepts the roster bounds inclusively: 100 seats, threshold = n, all seats, the last seat (FrostReservationCertificate.sol:130, :133, :135, :174)", async () => {
    // One operator may hold several seats and signs for each (the library's
    // documented rule), so a 100-seat roster needs only one key.
    const hundred = Array(100).fill(signers[1].address)
    expect(
      await signedValidate(
        descriptorOf(hundred, 51),
        Array.from({ length: 51 }, (_, i) => i + 1)
      ),
      "a 100-seat roster, the maximum, was refused"
    ).to.equal(true)
    expect(
      await signedValidate(descriptorOf(three(), 3), [1, 2, 3]),
      "a threshold equal to the roster size was refused"
    ).to.equal(true)
    expect(
      await signedValidate(descriptorOf(three(), 2), [1, 2, 3]),
      "every seat signing (seats = n) was refused"
    ).to.equal(true)
    expect(
      await signedValidate(descriptorOf(three(), 2), [2, 3]),
      "the last seat (seat = n) signing was refused"
    ).to.equal(true)
  })

  it("derives a plan of exactly 64 requests and refuses 65 (FrostReservationCertificate.sol:70)", async () => {
    const d = descriptorOf(three(), 2)
    const r = await reservationOf(d)
    const requests = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        ...REQUEST,
        id: ethers.utils.id(`M9 request ${i}`),
      }))
    await ok(cert.derive(r, plan(requests(64))), "a 64-request plan")
    await refused(
      cert.derive(r, plan(requests(65))),
      "a 65-request plan was derived"
    )
  })

  it("holds the fee domain at each bound (FrostReservationCertificate.sol:37-41)", async () => {
    const d = descriptorOf(three(), 2)
    const accepted: [string, Record<string, unknown>][] = [
      [
        "maximum fee equal to the minimum",
        { minimumFee: 700, maximumFee: 700 },
      ],
      ["maximum fee exactly 2.1e15", { maximumFee: MAX_SATOSHI }],
      ["rate cap exactly 2.1e15", { maximumSatPerVByte: MAX_SATOSHI }],
      ["minimum fee 1", { minimumFee: 1 }],
      ["rate cap 1", { maximumSatPerVByte: 1 }],
    ]
    for (const [label, fee] of accepted)
      await ok(cert.derive(await reservationOf(d, fee), plan()), label)
    const refusedCases: [string, Record<string, unknown>][] = [
      ["a zero minimum fee", { minimumFee: 0 }],
      ["a maximum fee below the minimum", { minimumFee: 701, maximumFee: 700 }],
      ["a maximum fee above 2.1e15", { maximumFee: "2100000000000001" }],
      ["a zero rate cap", { maximumSatPerVByte: 0 }],
      ["a rate cap above 2.1e15", { maximumSatPerVByte: "2100000000000001" }],
    ]
    for (const [label, fee] of refusedCases)
      await refused(
        cert.derive(await reservationOf(d, fee), plan()),
        `${label} was in the fee domain`
      )
  })
})

describe("M9 redemption library guards: request deadline", () => {
  it("captures a deadline of exactly the uint64 maximum and refuses one past it (FrostRedemptionLedger.sol:590)", async () => {
    const [owner, payer, redeemer] = await ethers.getSigners()
    const ledger = await (
      await ethers.getContractFactory("FrostRedemptionLedgerFixture", owner)
    ).deploy()
    const bank = await ethers.getContractAt("Bank", await ledger.bank())
    // FIXTURE: controlled test credit, not a Bitcoin custody witness.
    await ledger.creditForTest(payer.address, "50000")
    await bank.connect(payer).approveBalance(ledger.address, "40000")
    const admission = {
      walletId: ethers.utils.id("M9 wallet"),
      descriptorHash: ethers.utils.id("M9 descriptor"),
      balanceOwner: payer.address,
      redeemer: redeemer.address,
      gross: "10000",
      treasuryFee: "100",
      maximumBitcoinFee: "500",
      timeoutSeconds: "0",
      finalityBlocks: "3",
      script: PAYEE,
    }
    const at = (await ethers.provider.getBlock("latest")).timestamp + 100
    await network.provider.send("evm_setNextBlockTimestamp", [at])
    await refused(
      ledger.connect(payer).request({
        ...admission,
        timeoutSeconds: UINT64_MAX.sub(at).add(1),
      }),
      "a deadline past the uint64 maximum was captured"
    )
    await network.provider.send("evm_setNextBlockTimestamp", [at + 1])
    await ok(
      ledger.connect(payer).request({
        ...admission,
        timeoutSeconds: UINT64_MAX.sub(at + 1),
      }),
      "a deadline of exactly the uint64 maximum"
    )
    expect(
      await ledger.escrow(admission.walletId),
      "escrow of the boundary request"
    ).to.equal(10000)
  })
})

describe("M9 redemption library guards: cancellation history", () => {
  // FIXTURE: synthetic intent records in FrostCancellationHistoryFixture.
  const State = { Reserved: 1, Paid: 2, Cancelled: 3 }
  let h: Contract
  let sponsor: string
  let serial = 0
  const record = (name: string, fee: number) => ({
    transactionHash: ethers.utils.id(`M9 alternative ${name}`),
    snapshot: ethers.utils.id(`M9 snapshot ${name}`),
    fee,
    sponsor,
    admittedBlock: 1,
    validUntilBlock: 2,
    seats: [1, 2],
    signatures: "0x",
    budgetSettled: false,
  })
  const empty = () => ({
    ...record("none", 0),
    transactionHash: ZERO,
    snapshot: ZERO,
    sponsor: ethers.constants.AddressZero,
  })
  /// A fresh intent in `state` with no alternatives recorded.
  const intent = async (state: number) => {
    serial += 1
    const id = ethers.utils.id(`M9 intent ${serial}`)
    await h.initializeLegacyForTest(id, state, empty())
    return id
  }
  beforeEach(async () => {
    const [owner, s] = await ethers.getSigners()
    sponsor = s.address
    h = await (
      await ethers.getContractFactory("FrostCancellationHistoryFixture", owner)
    ).deploy()
  })

  it("appends only to an unresolved intent without a winner (FrostCancellationHistory.sol:106)", async () => {
    const id = await intent(State.Reserved)
    await ok(h.appendForTest(id, record("first", 1000)), "append to Reserved")
    for (const state of [State.Paid, State.Cancelled]) {
      const resolved = await intent(state)
      await refused(
        h.appendForTest(resolved, record(`after ${state}`, 1000)),
        `an alternative was appended to an intent in state ${state}`
      )
      expect(await h.count(resolved), "no alternative recorded").to.equal(0)
    }
    await ok(
      h.recordWinnerForTest(id, record("first", 1000).transactionHash),
      "record the first as winner"
    )
    await refused(
      h.appendForTest(id, record("late", 2000)),
      "an alternative was appended after the winner was recorded"
    )
    expect(await h.count(id), "only the first remains").to.equal(1)
  })

  it("records as winner only a known alternative whose budget is unsettled (FrostCancellationHistory.sol:153, :155, :161)", async () => {
    const id = await intent(State.Reserved)
    await h.appendForTest(id, record("first", 1000))
    await h.appendForTest(id, record("second", 2000))
    await refused(
      h.recordWinnerForTest(id, record("unknown", 3000).transactionHash),
      "an unknown alternative was recorded as winner"
    )
    expect((await h.rawHistory(id)).winningHash, "no winner").to.equal(ZERO)

    // Defence in depth on fixture state: a first budget already returned
    // (recordFirstReturn) cannot be recorded as the burned winner.
    await h.recordFirstReturnForTest(id)
    await refused(
      h.recordWinnerForTest(id, record("first", 1000).transactionHash),
      "a first alternative whose budget was returned was recorded as winner"
    )
    expect((await h.rawHistory(id)).winningHash, "still no winner").to.equal(
      ZERO
    )

    // Defence in depth on fixture state: an extra alternative refunded while
    // the intent was resolved cannot later be recorded as winner.
    await h.setStateForTest(id, State.Paid)
    await ok(
      h.takeRefundForTest(id, record("second", 2000).transactionHash),
      "refund the second budget"
    )
    await h.setStateForTest(id, State.Reserved)
    await refused(
      h.recordWinnerForTest(id, record("second", 2000).transactionHash),
      "a refunded extra alternative was recorded as winner"
    )
    expect(
      (await h.rawHistory(id)).winningHash,
      "no winner at the end"
    ).to.equal(ZERO)
  })

  it("marks a first-budget return only when a first alternative exists (FrostCancellationHistory.sol:176)", async () => {
    const id = await intent(State.Reserved)
    await refused(
      h.recordFirstReturnForTest(id),
      "a first-budget return was marked with no first alternative"
    )
    expect(
      (await h.rawHistory(id)).firstBudgetSettled,
      "no first budget settled"
    ).to.equal(false)
    await h.appendForTest(id, record("first", 1000))
    await ok(h.recordFirstReturnForTest(id), "mark the existing first return")
  })

  it("refunds only a known alternative (FrostCancellationHistory.sol:200)", async () => {
    const id = await intent(State.Reserved)
    await h.appendForTest(id, record("first", 1000))
    await h.setStateForTest(id, State.Paid)
    const unknown = record("unknown", 5000).transactionHash
    await refused(
      h.takeRefundForTest(id, unknown),
      "an unknown alternative's budget was refunded"
    )
    await refused(
      h.takeRefundForTest(id, ZERO),
      "a zero alternative's budget was refunded"
    )
  })
})
