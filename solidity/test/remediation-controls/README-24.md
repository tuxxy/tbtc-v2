# tbtc-v2#24 controls: single main (D13 refinement)

Refs tuxxy/tbtc-v2#24. Decision: DECISIONS.md "D13 refinement" (tux,
2026-10-30). While a FROST wallet's main is reserved for a redemption, no
ordinary deposit sweep is accepted (deposit-only or claiming the main); the
deposits wait until the reservation resolves. The C-04 sweep-resolution route
is unchanged. A wallet with no main still takes a deposit-only first sweep.
Invariant: after every accepted Bridge call, a FROST wallet's recognized
unspent custody is exactly its main
(`custody.value == outputs[custody.mainOutpoint].value`, or both zero).

Tests (kind for `test/suites/e2e.txt`: only `Frost.PublicVaultCallback`
is e2e, already listed there; the rest are unit):

| File | Kind | #24 cases |
| --- | --- | --- |
| `test/bridge/Frost.SingleMain.test.ts` (new) | unit | 5 |
| `test/bridge/Frost.DepositSweep.MainRequired.test.ts` (amended) | unit | 2 |
| `test/bridge/Frost.SweepConflictResolution.test.ts` (amended) | unit | 10 (shared `admitted` setup) |
| `test/bridge/Frost.PublicVaultCallback.test.ts` (amended) | e2e (Bitcoin Core, Go digest) | 2 |
| `test/bridge/Frost.SweepConflictResolution.ExposureReset.test.ts` (setup amended, batch 18) | unit | 0 (#33 cases; setup only) |

`ExposureReset` (tuxxy/tbtc-v2#33) arrived after these tests were written.
Its setup credited a deposit-only sweep beside the bootstrap reservation's
main, so under the fix its `before all` hook failed at "FROST sweep main
required". Batch 18 sweeps that deposit together with the payment change
into one 178,000 main; its #33 assertions are unchanged, and the batch-5
control `33-no-exposure-reset` still fails its two fee > reservedNet cases at
"the resolved reservation's cancellation exposure was not released".

Run the controls with `24-run-controls.sh <scratch worktree> <evidence dir>
<patch> [files]`: it resets a separate worktree of this repository to this
branch's HEAD, applies and commits the patch there, compiles, and runs the
five files.

## Without any patch (branch head)

`Frost.SingleMain`: 2 passing (boundary, resolution positive control),
3 failing:

- Reserved: "Reserved: deposit-only sweep of one deposit: an ordinary deposit
  sweep (includeMain=false) was accepted while the main is reserved"
- TimeoutPending: "TimeoutPending: deposit-only sweep of one deposit: ...
  was accepted while the main is reserved"
- end to end: "e2e: deposit-only sweep while reserved: ... was accepted while
  the main is reserved"

Amended tests fail at their #24 assertions: "tbtc-v2#24: a deposit-only
fragment beside the reserved main was not refused by the main guard" and "...
a deposit-only sweep during a reservation was not refused by the main guard"
(MainRequired, 2 cases), "tbtc-v2#24: the late deposit-only sweep beside the
reserved main was not refused by the main guard" (SweepConflictResolution, 10
cases, through the shared `admitted` setup), "tbtc-v2#24: the deposit-only
Vault sweep beside the reserved main was not refused by the main guard"
(PublicVaultCallback, 2 cases; with the late-reverting callback the message
names the Vault's revert instead of "accepted"). `ExposureReset` passes (3).

## Results (batch 18, 2026-11-09, integration/frost-base `89bdd77b` plus these tests)

| Patch | Kind | Result (five files) |
| --- | --- | --- |
| none (branch head) | base | 9 passing, 17 failing, each at a #24 assertion (above) |
| `24-single-main.fix.patch` (drop `\|\| activeReservation != 0` from "FROST sweep main required") | positive | 26 passing, 136 s |
| `24-reserved-only.wrong.patch` (refuse only while the intent is `Reserved`) | removal | 23 passing, 3 failing: "TimeoutPending: deposit-only sweep of one deposit: an ordinary deposit sweep (includeMain=false) was accepted while the main is reserved", and MainRequired's "a deposit-only fragment beside the reserved main was not refused by the main guard" and "a deposit-only sweep during a reservation was not refused by the main guard" |
| `24-ordinary-main.wrong.patch` (refuse deposit-only, but let an ordinary sweep spend and replace the reserved main) | removal | 20 passing, 6 failing: "Reserved: ordinary sweep of the deposits and the reserved main: an ordinary deposit sweep (includeMain=true) was accepted while the main is reserved", the same for TimeoutPending, "e2e: ordinary main sweep while reserved: ... (includeMain=true) was accepted", and three `revertedWith` checks |
| `24-overbroad.wrong.patch` (fix, plus refuse every sweep while reserved, including the resolution route) | over-broad | 14 passing, 12 failing: "C-04 sweep resolution: the approved resolution sweep of the reserved main: refused (... 'FROST sweep main reserved')", and the resolution cases of SweepConflictResolution and PublicVaultCallback |
| `24-no-main.wrong.patch` (every deposit sweep must claim a main) | over-broad | 0 passing, 9 failing: 5 at "boundary: a no-main wallet's first deposit-only sweep is accepted: refused (... 'FROST sweep main required')", 4 in setup hooks |

Cross-repository wrong fixes: a host-only fix leaves this tree as it is (the
17 base failures); a Bridge-only fix leaves the keep-core tests
(tuxxy/keep-core#105) failing.

Other suites under the fix (none changed except ExposureReset's setup): every
`Frost.DepositSweep*`, `Frost.Fraud*`, `Frost.Lifecycle*`, `Frost.Movement`,
`Frost.Custody`, `Frost.CutoverExposure`, `Frost.FundingDispatch`,
`Frost.PublicFunding`, `Frost.PublicSpvMaintainer`, `Frost.PublicGasCap`,
`Frost.LegacyReconciliation`, `Frost.SweepConflictResolution.{Core,Gas}`,
`test/b8/*`, `test/b14/*`, `test/k09/*` and `test/c11/Frost.Upgrade*` pass.

**Timing** (fix applied, gas reporter off): SingleMain 0.5-2.2 s per case
(19 s file); MainRequired 2.9-6.1 s; PublicVaultCallback 1.7-2.0 s per case
after a Bitcoin Core `before all`; ExposureReset 0.4 s; SweepConflictResolution
0.5-7.6 s, except "requires the separate exact resolution certificate and
rejects replayed/foreign authority atomically" at 15.6 s (over the 10 s case
budget; the compiler-layout frame reads, unchanged here). The five files take
about 136 s in one process, over the 2 min suite budget; run as separate
processes they take about 60 s wall.

The refusal assertions accept either existing main-guard reason
(`FROST sweep main required` or `FROST sweep main reserved`), so a fix may
refuse with either; a refusal for any other reason (malformed transaction,
proof or deposit) fails the test.

## Notes

- `Frost.SweepConflictResolution.Core` and `Frost.PublicVaultCallback` start
  Bitcoin Core regtest; under parallel load their `bitcoin-cli` calls can time
  out in a `before all` hook (environment, not an assertion). Rerun alone.
- Production-adjacent text still describing the old rule, for the
  implementer (not edited here): `solidity/docs/frost/C05-LOCAL-BOUNDARIES.md`
  30-33, `solidity/docs/frost/CUSTODY-SCHEMA-V1.md` 19-21,
  `solidity/contracts/frost/C04-BOUNDARIES.md` 102-104 and 267-269,
  `FrostDepositSweep.sol` 299-301 (comment), `FrostCustody.sol` 37-39 (doc
  comment; the reserved branch of `credit` itself is still used by the
  resolution route, which credits before it clears the reservation),
  `FrostRedemptionLedger.sol` 408-409 ("unspent non-main reservation
  inputs remain recognized custody").
