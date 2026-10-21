# C-06 movement boundaries and open gates

Recorded on 19 October 2026 with the C-06 implementation. This states what
the inactive C-06 code establishes, what it does not, and what K-07, C-08,
C-09 and C-10 still owe. The host contract is keep-core
`pkg/frost/movement/verification/BOUNDARIES.md` (V-08); its readings 1 to 6
are the rules implemented here.

## Routes

| Route | Entry | Proof | Target sweep |
| --- | --- | --- | --- |
| FROST → FROST | `submitFrostMovingFundsCommitment` | `submitFrostMovingFundsProof` | `submitFrostMovedFundsSweepProof` |
| ECDSA → FROST (drain) | legacy `submitMovingFundsCommitment`, behind `setFrostDrainEnabled` | legacy `submitMovingFundsProof` | `submitFrostMovedFundsSweepProof` |
| ECDSA → ECDSA | legacy, unchanged | legacy, unchanged | legacy, unchanged |
| FROST → ECDSA | none | none | none |

All FROST entrypoints sit in two new linked libraries, `FrostMovement` and
`FrostMovementDispatch`, reached from the last branch of
`FrostBridge.dispatch`. The Bridge bytecode is unchanged (24,271 bytes).
`MovingFunds` grows to 23,775 bytes for the drain (limit 24,576).

## What the code establishes

**Commitment.**

- Accepted once per period from a seat operator of a source in `MovingFunds`.
- Every obligation must be clear: no active reservation, no redemption
  escrow, no pending or committed incoming transfer.
- Revealed deposits never block. A reveal is not proven on Bitcoin and its
  refund time is the depositor's choice, so it cannot hold a wallet (review
  finding: a fabricated reveal with `refundLocktime = 0xffffffff` blocked
  movement until 2106). A later sweep of a real deposit reopens the wallet.
- The custody main is the whole custody value. A wallet whose custody also
  holds outputs credited during a reservation cannot commit until they are
  merged; see open gates.
- Target count is `min(eligibleTargets, ceil(value / walletMaxBtcTransfer))`,
  the legacy rule with FROST wallets counted.
- Targets are strictly ascending labels, each `isMovementTarget`
  (`ReadyUnfunded` or `Live`, not quarantined, capability version > 0),
  never the source.
- The commitment stores the main outpoint, the ordered labels, each
  target's descriptor hash and the `movingFundsTxMaxTotalFee` in force: the fee
  policy it authorizes, for its proof and its C-08 defense, whatever
  governance sets later. A label is `bytes20(keccak256(domain ‖ Q))`, so it
  binds the target key. Commitments are kept per lifecycle period for C-08
  defenses.
- **Retirement.** A proven deposit or incoming sweep that spends the main of
  an unproven commitment retires it. Its targets' inbound obligations are
  released and the next period opens, so the new main can be committed. The
  retired commitment stays readable for C-08 defenses.

**Movement proof.**

- Exactly one input: the committed main, still the custody main, unreserved.
- Outputs in commitment order, each `OP_1 PUSH32 Q` of its committed target
  with an unchanged descriptor hash.
- The legacy equal split (`[min, min + remainder]`) and the committed fee cap.
- Effects:
  - the main is spent in custody and in `spentMainUTXOs`;
  - every output becomes a pending incoming obligation of its target,
    **whatever the target's state is by then**;
  - the source goes to `Closing`.

**Receiving sweep.**

- Accepted from a target in `ReadyUnfunded`, `Live`, `MovingFunds`, `Closing`
  or `Terminated`.
- Inputs are the target's main (required when present) and one or more of
  its pending or escalated incoming outputs. One output pays the target's Q.
  The fee is at most `movedFundsSweepTxMaxTotalFee`. Refused while the
  target's main is reserved.
- Each incoming key is consumed once, in `spentMainUTXOs`, the replay space
  shared with legacy deposits, legacy mains and FROST custody.
- No Bank credit: the value was already backed by the source's custody.
- `ReadyUnfunded` becomes `Live`.

**Reopening.** A `Closing` or `Closed` wallet that gains custody through a
late incoming or deposit sweep returns to `MovingFunds` in a new period, with
dust and the closing time cleared, so the credited value moves again. Closing
deleted nothing, so this is always possible (review findings on #10 and
#12).

**Timeouts and escalation.**

- A commitment past `movingFundsTimeout` is marked escalated. It stays
  provable; C-09 attaches the sanction.
- An incoming output past `movedFundsSweepTimeout` becomes `Escalated`. It
  stays sweepable and keeps counting against the target. Unlike the legacy
  `TimedOut`, nothing is dropped.
- With no eligible target the moving funds clock resets after
  `movingFundsTimeoutResetDelay`.

**Dust.** `notifyFrostMovingFundsBelowDust` records `dust` and begins
closing, but only when every other obligation is clear. This is unlike the
legacy rule, which ignores pending incoming sweeps. The dust output stays
recorded custody.

**Drain.**

- A legacy commitment whose first target is a FROST label is a drain. It
  needs `drainEnabled` and names only eligible FROST targets.
- Its commitment hash keeps the legacy format, `keccak256(labels)`, so
  `WalletProposalValidator` and the keep-core proposal generator read it as
  is. The targets' descriptor hashes are bound separately and checked
  output by output in the proof.
- Drain outputs become FROST incoming obligations, never legacy requests. A
  proof mixing schemes reverts.
- A drain whose legacy source timed out can still be proven late: the
  signed drain may confirm after the timeout.
- Its targets' inbound obligations are released only by Bitcoin evidence
  (`releaseFrostDrainOnConflict`): a proven transaction that spends the
  committed legacy main and pays none of the committed targets' keys.

**Eligibility counter.** `eligibleTargets` is incremented at readiness and
decremented at quarantine of an eligible wallet. Every later C-09 state change
out of `ReadyUnfunded` or `Live` must decrement it.

**Storage.** `FrostMovementState.Storage` (eight slots) is taken from the
Bridge gap, 22 → 14.

## Evidence

`test/bridge/Frost.Movement.test.ts` runs through the real Bridge proxy,
linked libraries, Bank, verifier and registry callbacks. Wallets are funded
by real reveals and deposit sweep proofs. Inclusion proofs are synthetic
regtest blocks, so they test accounting, not Bitcoin spend validity. The
tests cover:

- the full FROST route with conservation and replay refusal;
- commitment authorization, order, count, duplicates and eligibility;
- target state changes after commitment;
- wrong order, split, key, fee, inputs and partial outputs, with no state change;
- the incoming sweep main rule, foreign outputs and fees;
- both escalations and the timeout reset;
- dust with pending obligations;
- reveals that never block, retirement and reopening;
- the drain behind its gate, mixed outputs and release;
- the legacy stranded case as a regression.

The keep-core K-07 tests mine the same transaction shapes on Bitcoin Core 29.0.

Until C-09 exists, entering `MovingFunds` is a controlled storage marker in
these tests, written together with the eligibility counter it implies.

## Open gates

- **C-09:** public entry to `MovingFunds` (closeable, heartbeat failure,
  redemption timeout), sanctions on both escalations (D-03), `Closing →
  Closed` as the closure-ledger predicate, and eligibility decrements on
  every exit from `ReadyUnfunded` or `Live`.
- **C-08:** a defense for a movement signature, reconstructed from the
  per-period commitment and the exact transaction.
- **G-F and C-10:** enabling the drain is first funding of FROST custody. The
  incoming value must count against the rollout budget (BOUND-03/04).
- **Cutover:** refusing new legacy targets after cutover is not implemented.
  The drain gate only admits FROST targets.
- **Extra custody outputs:** an output credited while a reservation was active
  stays outside the main. Movement refuses such a wallet. Merging them belongs
  with C-04/C-05.
- **A target that can never sign:** its incoming stays escalated. The
  governance route is D-03 and OPEN.
- Gas qualification for the worst commitment and proof shapes is not recorded.
