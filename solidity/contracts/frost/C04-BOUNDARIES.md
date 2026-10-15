# C-04 reservation and settlement boundaries

Work in progress on `integration/c04-redemption-reservations`, based on K-03
`76f79051`. Governing documents: KC-SF-V3 revision 01 sections 4.6 and C-04;
KC-VER revision 01 V-04 and V-05. No C-04 exit is claimed by this file.

## Certificate boundary

`FrostReservationCertificate` validates the existing Ethereum operator signature
mechanism against the wallet's frozen descriptor. It does not introduce a new
threshold signing scheme. Signatures use Ethereum personal-sign over the
Keccak-256 hash of the Solidity ABI encoding of:

1. `keccak256("tbtc-v2/frost-redemption-reservation/v2")`;
2. the current Ethereum chain ID;
3. the Bridge proxy address;
4. the reservation tuple defined in the library.

The tuple binds the full wallet ID and descriptor hash, uint64 intent generation
and state version, K-04 binary intent commitment, request ID commitment,
reserved conflict outpoint and fee policy. The request ID commitment is
`keccak256(abi.encode(bytes32[] requestIds))` in the exact plan order. The
consumer must recompute it from current request records and recompute the
K-04 commitment from their authorized transaction fields. Supplied hashes alone
do not establish funded requests, exact amounts, recipient scripts or custody.

`FrostSigningIntent` reconstructs the K-04 v2 commitment from the snapshot,
genesis, reservation fields and ordered net recipient entitlements. Its two
fixed vectors match the Go/TypeScript fixtures, including generation at uint64
maximum and state version above JavaScript's safe integer range. It validates
recipient script shapes and nonzero request identities. Distinctness is enforced
by the consumer's atomic Requested-to-Reserved state transition. The consumer
must still derive those entitlements from escrow, validate fee policy and build
the snapshot from exact transaction bytes and recognized custody prevouts.
The encoder is not a substitute for those funded-state and Bitcoin checks.

The validator takes the snapshot/genesis and ordered request data and derives
both `intentCommitment` and `requestIdsHash` internally. Supplied bindings must
match those derived values before signature validation. There is no opaque-only
validation path. Admission must populate request amounts and scripts from escrow,
not forward an untrusted caller's net amounts. The helper tests now compose vector
transaction/request data, commitment derivation, signing and validation in the
current deployment domain; the two fixed byte-contract vectors are also retained.

### Validator failure behavior

`derive` returns a fresh Reservation and does not change the caller's memory
struct. `validate` likewise leaves the supplied tuple unchanged on acceptance
or a well-formed binding mismatch. Early descriptor/certificate/domain failures
return false. If those checks pass, malformed Plan/request domains revert during
derivation: empty or over-64 requests and zero snapshot/genesis use
`FROST intent domain`; zero IDs, invalid amounts or unsupported scripts use
`FROST intent request`. A well-formed derived-binding mismatch returns false.
Consumers must treat both false and revert as admission failure; this is not a
boolean-only, non-reverting API. Early refusal can occur before Plan validation.

The revised K-04/C-04 profile caps requests at64 (65outputs with exact-Q
change), recognized inputs at32, and certificate seats at the existing100-seat
descriptor maximum. Both request and input bounds are mirrored in NewPlan and
INTENT-V2. This is a joint profile chosen from full admission measurements,
rather than a request-only extrapolation.
The encoder preallocates its complete preimage and copies each field once.
Duplicate IDs must be rejected by the admission loop's request-state transition:
each request must be Requested, then becomes Reserved in that same atomic call;
a repeated ID encounters Reserved and reverts the entire frame. The pure encoder
does not replace that state guard. Maximum-batch helper gas and a local public batch were checked;
target-chain transaction feasibility is now an OPEN A1 release decision. The
historical 255-request/29M transaction/30M block witness does not establish
production feasibility. The128-request-only intermediate profile also failed the combined storage
budget and is superseded. Target proof/watchtower budgets remain OPEN.

Seats are one-based descriptor positions. Their indices must increase strictly;
each index counts once. A repeated operator address is allowed when one operator
holds multiple distinct selected seats. Certificate quorum is the descriptor's
signing threshold, not the full-roster DKG result quorum.

Only a descriptor loaded from the registered wallet may be passed to validation.
The caller must compare current intent generation, state version and capability,
check request eligibility and funding, and atomically install the reservation.
The library is not an externally callable reservation or a funding adapter.

## Generation, state version, identity and expiry

These semantics are the C-04/K-05/V-04 correspondence contract; their storage and
transitions must be implemented in the Bridge consumer before admission exits:

- K-03 readiness generation is uint32 and certifies completed keys. It is separate
  from the uint64 intent-generation counter in K-04 and C-04. Never narrow an
  intent generation into readiness storage or compare those unrelated counters.
- Each wallet's intent counter starts at zero. Admission requires generation
  `counter + 1` and increments it atomically on success; checked overflow refuses.
  A pending intent is never relabeled. At most one unresolved custody-spending
  reservation is admitted for the same wallet main UTXO.
- The consumer's additive common `FrostCustody.Storage.wallets` mapping is keyed
  by full wallet ID. Its wallet record contains uint64 generation and stateVersion
  plus the active reservation ID. These are new intent/custody fields, separate
  from K-03 readiness generation and legacy timeout flags. Public admission tests
  exercise these counters; capability invalidation correspondence remains under
  review.
- Actual local state-version transitions: first recognized custody credit sets
  uint64 stateVersion to one. Every subsequent unreserved credit increments it,
  including deposit-only sweep credit without main consumption. Additional
  deposit-only credit during an active reservation preserves the admitted main,
  intent generation and stateVersion. Confirmed payment/cancellation replacement
  increments stateVersion; governance quarantine increments it and preserves
  unresolved escrow/history. Reservation admission increments intent generation,
  not stateVersion. Timeout, cancellation authorization and ordinary governance
  fee/watchtower/configuration changes do not bump stateVersion in this code.
  Captured request/intent policy remains immutable. An unreserved sweep between
  attestation and admission therefore makes the old version fail admission and
  requires fresh canonical validation/re-attestation. A capability/seat/policy
  invalidation transition is not inferred from configuration changes; its owned
  provider/storage correspondence remains open.
- The Go ReservationView exposes the reservation's intent generation and captured
  state version. Its current state must also reflect any invalidating transition;
  repeating old stored fields with Reserved after invalidation is forbidden.
- Reservation ID is Keccak-256 of Solidity ABI encoding of
  `keccak256("tbtc-v2/frost-reservation-id/v1")`, chain ID, Bridge proxy address,
  wallet ID, descriptor hash, uint64 intent generation, uint64 stateVersion and
  intent commitment, in that order. It identifies the logical intent and does
  not change when a certificate for the same intent renews its expiry.
- Certificate v2 signs uint64 validUntilBlock. Admission is permitted through
  that block inclusively, then refuses. The consumer must enforce its configured
  maximum certificate window. Draft-v1 signatures do not migrate to v2.
  Expiry prevents a new admission only: it does not revoke an admitted reservation
  or a Bitcoin signature. Providers verify the certificate at its authenticated
  admission block and read the reservation's current canonical state; they must
  not refund escrow just because the certificate is now expired.
- Hosts read the authoritative full reservation ID from canonical chain storage
  or its authenticated admission event and bind it to the current stored intent.
  They must not independently derive that ID until a fixed cross-language ID
  vector and byte contract pass for the contract and host/client implementations.
  The existing Solidity ABI test is not that host interoperability vector.
- K-05 durably records each intent attestation and every certificate renewal for
  `(wallet, intentGeneration, stateVersion)`. Failure or timeout cannot erase its
  history. A different intent may replace an unadmitted attestation in that slot
  only after the inclusive old validUntilBlock (and every prior outstanding
  renewal's deadline) is finalized, and one consistent canonical finalized read
  establishes no admission for that slot at or before those deadlines. Record
  the finalized head/hash, deadline and authoritative non-admission evidence in
  durable storage before signing the replacement certificate. Pending finality,
  reorganization, inconsistent reads or uncertain storage refuse replacement.
  Elapsed local time, certificate expiry alone or a pending transaction is not
  evidence of non-admission.
- Honest hosts never release a Bitcoin signing package or signature before they
  durably observe and retain finalized canonical admission of that exact intent.
  The old no-admission evidence therefore cannot conceal an honest pre-admission
  Bitcoin signature. Once an intent is admitted, certificate expiry does not
  permit slot replacement or escrow release; preserve its admission, possible
  signatures and escrow until proven payment or custody-preserving cancellation.
  A fresh generation/state follows the required on-chain transition.

## Entitlements, custody and defenses

For every captured request, derive `f_i = G_i - T_i - P_i` with checked
subtractions. Require `0 < P_i`, `f_i <= captured txMaxFee_i`, and
`sum(f_i) == actual Bitcoin fee`. Apply aggregate min/max and actual-vsize rate
checks to the same canonical transaction. Policy updates cannot enlarge an old
request's captured cap or change its recipient. Existing legacy requests retain
their identities, fees, watchtower data and accrued timing promises.

The reserved conflict outpoint must be recognized source-wallet custody (the
current main UTXO), not merely a caller-supplied prevout. Every payment,
replacement or cancellation shares that input. Validate canonical transaction
bytes and rebuild the snapshot from recognized prevout values/scripts. This
encoder accepts the resulting snapshot hash; it is not that on-chain rebuild or
a BIP341 digest reconstruction. C-08 losing-signature defense must rebuild both
snapshot and input digest and connect the finalized intent to the confirmed
winning replacement/cancellation, even when the losing transaction never mined.

## Available seats and escalation

Readiness and not-reported-lost membership are an honest-host operational
assumption, not a guarantee enforced by this validator. The helper checks the
frozen descriptor's seat/operator mapping and threshold; it receives no readiness
or lost-seat set and does not enforce either set. Each honest attester must obtain
those sets and capability state from a canonical authenticated provider, retain
the relevant version/head in durable storage, and use only readiness-certified
seats not reported lost. It must validate the transaction and reload its completed
key in a fresh worker immediately before attesting. The future canonical provider,
Bridge storage and host checks that enforce these relations remain required
implementation and correspondence work. Operator signatures alone cannot prove
private FROST key availability. Later loss can still make payment/cancellation
impossible and remains a named availability assumption.

K-05 and the Bridge consumer must record unresolved intent, affected requests,
first timeout/availability-loss block and reason, and expose a permissionless
escalation event/view. Loss of cancellation quorum or prolonged lack of inclusion
escalates to the operator recovery lead and governance/risk coordinator. Preserve
the intent, defense records and escrow; contain new issuance/funding as required.
Restore an authorized signing quorum where possible, then prove payment or a
custody-preserving conflict spend. Any separate compensation must use an explicitly
funded independent budget, never an unproved escrow refund. Named people, fee/
inclusion bounds, escalation deadlines and the monitoring/runbook policy remain
D-08/D-09/C-10 release decisions; no numeric production guarantee is invented.

## Required consumer transitions

An unreserved timeout cannot refund until the configured finality boundary.
A finalized reservation is required before the host grants worker signing.
A reserved timeout enters TimeoutPending; elapsed time alone cannot refund it.
Payment proof settles payment once. A confirmed cancellation consumes the same
reserved conflict input, preserves custody under the authorized fee/output
policy, updates custody accounting once, and only then permits refund.
Every alternative or replacement must share that conflict input. An assertion
that no signature escaped cannot cancel a reservation.

## Work still required for this milestone

Public funded escrow/reservation admission, payment/timeout/cancellation,
financial rollback and the explicit sweep-conflict proof/individual refund path
are implemented locally. Their controlled tests do not establish production
qualification or the canonical host/model joins. Remaining work includes:

- Add current-head Go reservation adapter and K-05 operator agreement; exercise
  public node and maintainer paths against actual contracts and Bitcoin Core.
- Replay V-04 against these concrete transitions; record V-05 correspondence.
- Resolve D-06/D-08 release policy and legacy outstanding-intent reconciliation;
  local test values do not approve production refunds or accrued deadline changes.

The list above describes milestone obligations, not a claim that every route is
still absent. The local public financial witnesses and remaining gaps are recorded
in the checkpoint section below.

The attestation/replacement model must include a bounded `sometimes` witness:
an initial certificate expires without admission, its inclusive deadline becomes
finalized, canonical finalized state confirms no admission in the slot at or
before that deadline, the host durably records that evidence, and a replacement
certificate is admitted and enables signing only after durable finalized
admission. Declare finite bounds and finality/provider/storage assumptions and
replay the concrete boundaries. Also require refusal traces for unfinalized
expiry, uncertain/noncanonical absence, admission at the inclusive old deadline,
and an already admitted intent. This is a required reachable successful path,
not an established liveness result or proof of eventual recovery.

The review response is retained in
[solidity/docs/frost](../../docs/frost/C04-CLAUDE-RESPONSE-2026-10-13.md).

Required witnesses are funded request/reserve/sign/mine/prove/settle; timeout
before and after reservation/share release/broadcast; late valid payment;
confirmed cancellation followed by refund; crash recovery and unchanged legacy
settlement. Required rejection checks preserve the full financial state frame.
Mutation testing is deferred to the agreed checkpoints.

## Local lifecycle checkpoint, 14 October 2026

The in-progress consumer uses fixed linked request/recovery, admission, and
proof/cancellation libraries. All share additive Bridge storage and one reentry
flag. Public selectors remain in IFrostBridge. New admission remains disabled by
default. Proof and already-owed recovery routes remain callable while new
admission is disabled. The normal deployment script supplies the fixed links.

Cancellation fee sponsorship is a separate Bank budget; request escrow cannot
fund an unproved refund. Before accepting a cancellation, require:

`custodyValue - cancellationFee >= totalNetLiability - reservedBatchNet`.

Retain `max(cancellationFee - reservedBatchNet, 0)` as cancellation exposure.
Every later request must satisfy `totalNetLiability + newNet <= custodyValue - cancellationExposure`. Confirmed payment burns the captured G-T and transfers
captured treasury fees; it returns the unused cancellation budget because the
shared conflict input is spent. Confirmed cancellation burns its independently
funded fee budget, refunds full captured gross amounts and updates custody once.
Keep the cancellation certificate, admission block and original intent records
for the future exact defense join. Exposure clears only on proven resolution.

The milestone exit is still open. C-04 now consumes the common C-05
`FrostCustody.Storage`, not private copies of custody records. It subtracts only
its captured spent inputs and preserves any later deposit-only credits during
an active reservation. Intent counters remain separate from registry readiness.
Affected capacity/escrow and actual linked-proxy checks passed 19 cases.
This checkout contains a local composition of C-05/C-07 sources; it still needs
the prerequisite commits and publication stack. Three public funding checks
establish local Core funding, public reveal, SPV sweep and backed Bank credit.
Seven public reservation and five public payment/recovery checks pass. Three
public Vault/watchtower checks cover credit, callback reentry, complete rollback
and captured policy. Controlled registry readiness, known signing scalar3 and
the zero-difficulty regtest relay remain explicit qualification boundaries.
Historical local result: exact word/tail equality allowed the 255-request
reservation and Core/SPV settlement under a tested 29M transaction cap and 30M
block limit (26,085,050 gas admission; 9,145,901 gas settlement). Claude A1
supersedes any target-chain feasibility inference from that local result. The
selected profile is now64requests/32inputs with up to100certificate seats.
The gas-only full-admission fixture executes canonical parsing, genuine operator
signature validation, INTENT derivation and ledger archival. With all32inputs
colliding in the64-slot detector, it uses14,882,443gas (diagnostic estimate
15,148,894) under the16,777,216 transaction limit. Its roots and Bank issuance
are synthetic; this measurement does not establish public funding or Bitcoin
consensus. Bridge fallback overhead is outside that fixture.

The separate actual public/Core/Bank witness covers64requests with one input:
admission7,142,440gas, payment2,516,019, cancellation authorization491,491 and
cancellation/refund1,859,946. All35affected checks pass under
`hardhat.frost-gas.config.ts`, which retains normal compiler/contract-size rules
and uses an effective16,777,216 one-transaction block ceiling because this
Hardhat version predates EIP-7825. Complete target proof-size, watchtower and
production joining evidence remain OPEN; no production qualification follows
from either the component or controlled public witness. Historical255/128
measurements remain historical counterexamples/comparisons, not the new profile.
The aggregate governance fee
cap is enforced at admission and retained in the original certificate so later
policy changes do not prevent settlement or enlarge its authorized fee range.
KC-SF-V3
C-05 owns exact deposit/reveal/sweep credit and depends on C-07 qualification;
C-06 is not a bypass because it also depends on C-05. C-04 component tests and
configuration evidence do not replace that funded origin. No synthetic credit
setter, seeded custody or governance evidence hash establishes this exit.

### Containment and historical authorization

Governance may contain a funded registered wallet through
`quarantineFrostWallet(walletId, expectedStateVersion, reasonHash, evidenceHash)`.
This is authenticated containment, not a proof that private keys were lost.
It advances the custody state version, blocks new request/reservation/reveal
admission and marks an unresolved reservation Quarantined. Captured certificates,
signatures, inputs, deadlines, sponsor budgets and escrow remain intact.
An immutable version-keyed record exposes the authority, block, reason, evidence
reference and affected reservation. Timeout cannot overwrite Quarantined.
Payment and cancellation proof recovery use the captured intent and remain live;
resolution advances custody version but does not clear wallet quarantine/history.
No restoration selector or automatic escrow refund is introduced.

Eight public settlement tests pass, including containment authorization/rollback,
timeout preservation and both Core/SPV recovery paths. Recursive compiler layout
comparison preserves every baseline member/type/position and the 2496-byte root;
the appended history mapping consumes one gap slot (24→23). Five affected
runtimes remain below24576. Restoration, operational availability correspondence,
D08 legacy reconciliation, full prerequisite qualification and the K05/V04 join
remain open.

The cancellation record now retains its signed validUntilBlock alongside the
snapshot, transaction hash, fee, seats, signatures and authenticated admission
block. Reconstruct historical authorization in its original chain/Bridge domain
at admission; present certificate expiry does not revoke an admitted Bitcoin act.

## Draft response to Claude A3/A4/A5 and C7-3 (OPEN release decisions)

Review sources: [C-04 A3/A4/A5](https://github.com/tuxxy/tbtc-v2/pull/2#issuecomment-6168676791)
and [C-07 C7-3](https://github.com/tuxxy/tbtc-v2/pull/4#issuecomment-6168347321).
This section records source behavior and outstanding decisions, not an adopted
production host/owner policy or release qualification. A1 gas/cap work is parent-owned.

### A3: cross-purpose main-spend serialization

Ordinary sweep proofs still refuse reserved-main consumption. The separate
`submitFrostSweepResolutionProof` route now accepts a canonical C-05 sweep that
spends the active unresolved redemption's captured current main, with a distinct
operator certificate binding chain/Bridge, exact reservation ID, sweep transaction
hash, vault and authorization deadline. SPV, exact deposit inputs/output and all
captured fee limits must pass. Successful certified conflict proof immediately
makes the full captured request gross collectible, including before the request
deadline; it does not push request refunds during the sweep proof. Each affected
request enters appended state 6 `Refundable`, emitting
`FrostRedemptionRefundAvailable`, while its full escrow and pending net liability
remain held. The intent separately enters state 6 `ConflictResolved`. Elapsed time
or certificate expiry alone cannot make a reserved request refundable.
Historical reservation expiry does not block resolution, while the new resolution
certificate must be valid at submission. Quarantine is not cleared. The intent
enters appended state 6 `ConflictResolved` and emits
`FrostReservationResolvedBySweep`; appended archive fields retain the sweep hash,
resolution block, authorization deadline, selected seats, signature hash and
full authorization digest alongside all original/payment and cancellation records.
The authorization digest commits to vault as well as the exact domain/chain/Bridge
and transaction context. `FrostSweepResolutionApproved` emits the full certificate
bytes; they also remain in the canonical transaction calldata. K-05 must retain
and retrieve that transaction, receipt/log and inclusion references, verify both
stored commitments, and interpret the certificate at its submission block rather
than current expiry. Hashes do not establish historical data availability. This
archive/retrieval join remains OPEN until the canonical host path implements it.

Only actual sweep inputs are consumed; other captured redemption inputs remain
recognized custody. The old nonzero main pointer is retained through custody
credit, then replaced before resolution clears active reservation/exposure and
advances stateVersion once. Sweep fees remain charged only to new deposits under
their captured caps: new Bank credits equal the custody increase, preserving old
main backing. Proof resolution retains full request escrow and conservative net
liability, so unclaimed refunds continue to consume new-request capacity. The
permissionless, guarded `refundResolvedFrostRedemption(requestId)` requires that
request to be `Refundable` and its recorded intent to be `ConflictResolved`; it
sets request state 5 `Refunded` and decrements escrow/net liability before paying
the full captured gross only to the stored redeemer. Repeat collection refuses;
a failed Bank transfer rolls the claim back. Any funded, unused single
cancellation budget returns to its sponsor during proof resolution without a burn.
The final custody coverage check and shared callback guard cover the atomic proof
transition; later Bank/Vault failure rolls it back. Separating bounded individual
claims removes the batch of cold Bank payouts from the legal 128-input sweep
proof; the joint maximum remains subject to measured transaction-gas evidence.

Proof-backed common-main conflict resolution was chosen instead of relying on
local signed-intent inventories: different signing quorums need not share an
honest inventory holder, so local exclusions do not establish global exclusion.
Canonical signing serialization before shares is not implemented by this route.
Production D-08 adoption of this refund policy, canonical host/provider integration,
Bitcoin/Ethereum finality and reorg assumptions, and exact losing-signature defense
remain OPEN. V-04/V-05 correspondence must retain the sweep-before-reservation
ordering and the full financial frame; this sweep-specific recovery does not
qualify general movement conflicts or the wider production lifecycle.

### A4: immutable cancellation alternatives and fee/inclusion assumptions

`authorizeFrostCancellation` admits additional distinct transactions only at a
strictly higher fee than all prior admitted alternatives, within the original
reservation certificate's frozen fee/rate envelope. Every alternative must spend
the exact captured ordered inputs into the exact wallet Q output and carry its
own operator certificate. The original payment remains immutable. Increasing
current governance limits does not enlarge an old certificate's envelope.

The first cancellation remains in the original Intent fields. An appended history
map retains every later transaction, snapshot, fee, sponsor, admission block,
certificate deadline, seats and signatures. It consumes one Bridge storage gap
slot; old fields/enum values retain their positions. Indexed getters expose all
alternatives and the actual confirmed winner. A lower-fee or expired historical
alternative remains provable after newer admissions; no record is overwritten.

Every admission debits its sponsor's entire fee, independently of earlier budgets.
Custody exposure is the highest possible winning fee minus the refundable batch
net, floored at zero, rather than the sum of mutually conflicting fees. The
existing remaining-liability capacity check still applies before authorization.
Proof selection uses the exact stored alternative hash/snapshot/fee. Only its
budget is burned on cancellation; full request escrow is refunded and shared
inputs are consumed exactly once. Settlement does not traverse the alternative
history. Permissionless `claimFrostCancellationBudget` pays only the recorded
sponsor of a terminal, unused budget and rejects early, winning and repeat claims.
Payment or sweep resolution retains the existing automatic first-budget return;
additional unused budgets are individually collectible. Old terminal records infer
that their first budget was already returned/burned without migration writes.

`A-FEE-INCLUSION-ESCALATION` remains OPEN for production fee/inclusion and signer
availability assumptions, an assigned monitor, escalation criteria/deadlines and
above-envelope recovery or compensation decisions. This implementation adds
escalation within the captured envelope; it cannot guarantee inclusion if that
envelope or available funded budgets become inadequate. It does not adopt a new
fee cap, compensation promise, recipient CPFP guarantee or unapproved movement
purpose. V-04 must cover all retained alternatives, the selected winner, unused
budget claims, and stalled above-cap/fee-spike outcomes under named assumptions.
Canonical host, archive, reorg/finality and production policy joins remain OPEN.

### A5: late host authorization versus historical SPV resolution

The actual version rules above replace the earlier overbroad capability/policy
wording. Governance configuration changes do not themselves increment stateVersion;
quarantine and custody transitions do. Canonical host views must expose the current
state/version separately from the immutable captured certificate context.

C-04 accepts an exact, previously admitted payment proved on Bitcoin while its
intent is TimeoutPending or Quarantined, including after certificate expiry. This
resolves escrow using historical authorization plus SPV; it does not turn a late
Done/signature notification into a new worker grant, second release or new spend
permission. A current unavailable/invalidated view must refuse fresh host signing.
Historical payment/cancellation evidence and unresolved escrow remain recoverable.

KC-VER `P-K05-LATE-SIGNATURE-QUARANTINE` says a late signature cannot authorize
settlement. Read literally as banning all later SPV settlement, that wording
conflicts with the required previously-authorized payment recovery in KC-SF-V3
section 4.6. Whether the predicate concerns late host authorization/release versus
historical confirmed-act settlement is an OPEN spec/model-owner correspondence
issue. Record the distinction in V-04 and obtain an explicit owner disposition
before claiming the predicate. This file neither silently revises the normative
spec nor claims the discrepancy closed. No new generalized proof campaign is added.

### C7-3: existing x-only validation belongs in named evidence

C-02 `FrostDkgValidator.validate` calls `FrostCurve.validX`; the registry checks that
result, and Bridge `FrostWallets.register` also uses its FrostCurve copy. This is a
separate code path from C-07 `FrostSecp256k1.lift`. validX rejects x >= P, computes
the square root with the modexp precompile and checks it back; it does not return
a normalized even-Y point. C-07 lift also constructs the point/parity convention.
No code migration or equivalence proof is claimed here.

V-05 rows 1/3/8 now source-bind both FrostCurve copies and the DKG validator path.
Named `P-C07-BIP340` evidence and independent specialist review must include these
actual range/square-root/precompile/exception checks as well as the C-07 lift and
signature implementation; `P-C07-TAPTWEAK` remains separately scoped. This extends
traceability of the existing named predicate, not a new DKG/identity proof. Exact
implementation correspondence, differential/boundary evidence and qualification
remain OPEN. Verified commit/path/blob pins are in the V-05 manifest; draft text
here is intentionally not a new committed qualification artifact.
