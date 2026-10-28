# C-04 response to Claude review

Review subject: `824e3030`, [comment on PR #2](https://github.com/tuxxy/tbtc-v2/pull/2#issuecomment-6146629990).
This response addresses the foundation APIs before Bridge admission depends on
them. C-04 remains incomplete; no funded settlement or milestone exit is claimed.

| Finding | Response | Evidence / remaining work |
| --- | --- | --- |
| F1: quadratic encoder at 255 | Allocate the exact preimage once, copy each field once, and remove the encoder's quadratic duplicate scan. Pin the K-04/C-04 limit at 255. | Fixed vectors and independent maximum-batch byte comparison; 255 P2WSH requests cost 2,208,328 gas through the helper, below the 4M regression ceiling. Real Bridge admission gas and atomic per-request duplicate rejection still gate exit. |
| F2: opaque independently supplied commitments | The validator now takes snapshot/genesis and ordered requests and derives both commitments internally; supplied values must match before signature checking. No opaque-only validation path remains. | Fixed-vector transaction/request data → derivation → certificate → validation; changed snapshot, genesis, net value or script refuses. Escrow-derived request loading remains the required Bridge consumer join. |
| F3: generation/version ambiguity | Define uint64 intent generation separately from uint32 readiness generation; define per-wallet storage, monotonic admission/custody rules and the Go field mapping. | C04-BOUNDARIES and K-04 INTENT-V2 semantics agree. No intent narrowing cast is allowed. Actual Bridge counter slots and transitions remain an open admission prerequisite. |
| F4: unavailable cancellation / escalation | State the honest-host operational assumption of readiness-certified, not-reported-lost seats and fresh completed-key reload; this validator does not enforce those sets. Specify the unresolved-intent escalation record, trigger and operator/governance recovery route. | Recorded required work; named people, monitoring/inclusion bounds, actual escalation API and recovery runbook remain open release obligations. Unavailable quorum never authorizes an unproved escrow refund. |
| F5: perpetual/conflicting certificates | Certificate domain v2 binds validUntilBlock and refuses admission after that inclusive deadline; retain durable attestation history and require finalized expiry plus canonical finalized no-admission evidence before replacing an unadmitted slot. | Deadline equality/expiry regression and V-05 caller obligation. Expiry does not revoke admitted reservations or Bitcoin signatures. Host attestation storage is a K-05 deliverable. |
| F6: missing consumer relations | Specify per-request fee allocation/caps, total fee equality, recognized main-UTXO conflict input, logical reservation ID and on-chain snapshot/BIP341 reconstruction for defenses. | Reservation ID is implemented and independently ABI-tested. Transaction/custody/defense reconstruction and financial settlement remain required consumer work. |
| F7: descriptor-shape coverage | Add correctly signed malformed descriptor controls for zero member/operator, threshold bounds, roster limit, array mismatch and scheme/profile. | Table regression passes without a mutation campaign. |

The earlier draft-v1 certificate has no production state to migrate. The v2
certificate domain rejects reuse of its signatures; the K-04 v2 Bitcoin intent
bytes and the two frozen interoperability vectors are unchanged.

The pure encoder is a byte encoder, not a request-state admission predicate.
Go's constructor and C-04's consumer enforce distinct IDs. Repeated IDs must
revert atomically when the same request is encountered Reserved on a second
iteration; removing the expensive encoder scan does not waive that obligation.

V-05 now records these caller obligations, per-row sides/hashes/statuses, the
counter/identity correspondence and the still-unimplemented funded-state join.
Independent adversarial re-review remains required before this milestone exits.

## Response to Claude re-review at b4c59e41

Review: [PR #2 comment 6148026519](https://github.com/tuxxy/tbtc-v2/pull/2#issuecomment-6148026519).

| Item | Change | Evidence / remaining work |
| --- | --- | --- |
| N1: replacement after unused expiry | Require finalized inclusive expiry and canonical finalized no-admission evidence for the slot, retained durably before replacement; include outstanding renewals. No Bitcoin signing precedes durable finalized admission, and admitted escrow remains reserved. | [Boundary contract](../../contracts/frost/C04-BOUNDARIES.md) requires a bounded `sometimes` successful replacement/admission witness and negative refusal traces. Host storage, provider and model/replay remain open; no liveness result is claimed. |
| N2: readiness/lost-seat claim | Reword as an honest-host operational assumption. The validator has no readiness/lost-seat set and does not enforce them. | Future authenticated canonical provider, versioned Bridge storage and durable host checks remain required. |
| L1: memory alias | Derive an explicitly allocated fresh Reservation; preserve every caller field during derivation and validation. | Fixture regressions compare the original ABI tuple after derive and after correctly signed binding-mismatch refusal, with a valid-input control. |
| L2: revert versus false | Document early false refusal, malformed Plan/request derivation reverts and well-formed binding-mismatch false. | Focused tests cover empty/oversized requests, zero snapshot/genesis/IDs, invalid amounts/scripts and early refusal. |
| L3: host reservation ID | Require authoritative ID from canonical chain storage/authenticated admission event; no independent host derivation before a fixed cross-language vector and byte contract. | Existing Solidity ABI ID regression is not a host interoperability vector. |
| L4: response placement | Move this response out of the contract source tree to `solidity/docs/frost/` and link it from the boundary contract. | Documentation-only move; unfinished request-ledger files and V-05 are excluded. |

These changes do not implement Bridge admission, replacement, escrow settlement
or host attestation storage. No funding, milestone exit or production gate is
claimed. The focused helper regressions are local tests, not checkpoint mutants.

Final follow-up focused run: 17 tests pass; the 255-request encoder fixture estimates 2,208,328 gas after the fresh-struct change. Independent patch review found no actionable defects.
