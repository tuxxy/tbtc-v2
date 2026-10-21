# C-09 lifecycle boundaries and open gates

Recorded on 19 October 2026 with the C-09 implementation. This states what
the inactive C-09 code establishes for FROST wallets, what it does not, and
what K-07, K-08 and D-03/D-07 still owe. Legacy ECDSA wallets keep the legacy
`Wallets.sol` lifecycle unchanged.

## Entrypoints

| Entrypoint | Effect |
| --- | --- |
| `notifyFrostWalletCloseable(walletId)` | old (`readyAt + walletMaxAge`) or, for a funded `Live` wallet, custody below `walletClosureMinBtcBalance`: leave `ReadyUnfunded`/`Live` |
| `notifyFrostWalletRedemptionTimeout(requestId)` | a request observed timed out (C-04): sanction notice, then leave `ReadyUnfunded`/`Live` |
| `finalizeFrostWalletClosing(walletId)` | `Closing` or `Terminated` → `Closed` when the closure ledger is empty after `walletClosingPeriod` |
| `frostClosureObligations(walletId)` | the closure ledger as a bit set |

They are reached at the end of the dispatch chain, after the C-08 fraud
entrypoints. FrostLifecycle is 3,726 bytes. The Bridge is unchanged.

## What the code establishes

**Entry (C-09 state rules).**

- A wallet that holds nothing and owes nothing goes straight to `Closing`.
  Any other wallet goes to `MovingFunds`, including an empty one still owed
  a committed or recorded incoming transfer. This closes the legacy entry
  route to the stranded case.
- An empty, ready, unfunded wallet is closeable only by age, never by
  balance, so a fresh deposit target cannot be closed by a third party.
- Every exit from `ReadyUnfunded`/`Live` decrements the C-06 eligibility
  counter once. A quarantined or already ineligible wallet is never
  decremented twice.
- `readyAt` is recorded at the readiness callback.

**Closure ledger (P-K07-CLOSE-ONLY-WHEN-CLEAR).** The wallet closes only
when all of these are clear:

| Bit | Obligation |
| --- | --- |
| 1 | custody value, unless dust is recorded |
| 2 | pending or escalated incoming outputs |
| 4 | committed incoming (unproven commitments naming it) |
| 8 | its own unproven commitment |
| 16 | unused: revealed deposits never block closure |
| 32 | redemption escrow |
| 64 | active reservation |
| 128 | open fraud challenge |

- The check runs at the transition, so a late arrival during the closing
  period reopens or blocks it:
  - an incoming or deposit sweep returns a `Closing` wallet to
    `MovingFunds` (C-06);
  - a challenge blocks closure until it is resolved.
- A deposit sweep that lands after final closure (a deposit revealed earlier,
  or a mined sweep proven late) reopens a `Closed` wallet the same way. A
  ledger of counters cannot exclude such an arrival, so closure is not
  irreversible (review finding on #12). A reopened wallet that had been
  terminated stays `Terminated`, and recorded dust is cleared in any state.
- `Closed` wallets refuse new challenges (C-08). The closing period is the
  challenge window.
- Nothing is deleted. The descriptor, custody records, per-period
  commitments and challenge history stay readable.

**Terminated wallets.**

- A fraud timeout terminates a wallet and records `terminatedAt`.
- A terminated wallet keeps every custody duty:
  - it may commit and prove a movement (it stays `Terminated`);
  - it may record dust;
  - its targets sweep normally.
- It closes on the same ledger rule after `walletClosingPeriod` from
  termination.

**Sanctions (D-03 test value, OPEN).**

- The FROST registry has no seize, close or inactivity route.
- Every sanctionable event emits a notification only:
  `FrostSanctionNotified(walletId, descriptorHash, reason)`.
- The reasons are `redemption-timeout`, `moving-funds-timeout`,
  `moved-funds-sweep-timeout` and `fraud-defeat-timeout`.
- The immutable descriptor hash binds the original members and operators,
  which preserves seat attribution.
- No economic penalty is claimed, and no BTC is recovered by sanctions.

## Evidence

`test/bridge/Frost.Lifecycle.test.ts` runs through the real Bridge proxy,
using public entrypoints only, except for two controlled C-04 markers: a
timed-out request, and (in C-08) an admitted intent. The tests cover:

- age and balance entry, including the direct `Closing` case;
- the quarantined no-double-decrement case;
- the owed-incoming wallet sent to `MovingFunds`;
- the redemption timeout sanction;
- a late deposit sweep after final closure reopens the wallet;
- the full closure ledger walk,
  commitment, proof and a late challenge;
- terminated movement and closure;
- escalation sanctions.

## Open gates

- **Heartbeat failure and inactivity claims (K-08).** They need a FROST
  registry inactivity route with operator signatures, nonce and member
  checks, which the K-03 registry lacks. Until then nothing moves a FROST
  wallet on heartbeat failure.
- **D-03.** Install an authorized sanction route and state its economic
  effect, or keep notification-only and record it as such at release.
- **D-07.** Dust and late-deposit retention: recorded dust counts as cleared,
  and a late deposit sweep reopens the wallet (test values, OPEN).
- **K-12.** Retirement inventory of dust and closed wallets.
- **C-10.** Rollout budgets and containment interaction with lifecycle
  transitions.
