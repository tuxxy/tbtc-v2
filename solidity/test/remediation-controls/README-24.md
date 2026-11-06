# tbtc-v2#24 controls: single main (D13 refinement)

Refs tuxxy/tbtc-v2#24. Decision: DECISIONS.md "D13 refinement" (tux,
2026-10-30). While a FROST wallet's main is reserved for a redemption, no
ordinary deposit sweep is accepted (deposit-only or claiming the main); the
deposits wait until the reservation resolves. The C-04 sweep-resolution route
is unchanged. A wallet with no main still takes a deposit-only first sweep.
Invariant: after every accepted Bridge call, a FROST wallet's recognized
unspent custody is exactly its main
(`custody.value == outputs[custody.mainOutpoint].value`, or both zero).

Tests: `test/bridge/Frost.SingleMain.test.ts` (new), plus the amended
`Frost.DepositSweep.MainRequired`, `Frost.SweepConflictResolution` and
`Frost.PublicVaultCallback` tests.

Each patch is applied to an APFS clone of `solidity/` at
`remediation/tests-24` (integration/frost-base `72307e72` plus these tests),
compiled with `npx hardhat compile`, and run with
`USE_EXTERNAL_DEPLOY=true TEST_USE_STUBS_TBTC=true npx hardhat test --no-compile <files>`.
No patch is applied in the committed tree.

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
fragment beside the reserved main was not refused by the main guard"
(MainRequired, 2 cases), "tbtc-v2#24: the late deposit-only sweep beside the
reserved main was not refused by the main guard" (SweepConflictResolution, 10
cases, through the shared `admitted` setup), "tbtc-v2#24: the deposit-only
Vault sweep beside the reserved main was not refused by the main guard"
(PublicVaultCallback, 2 cases).

## Results (recorded 2026-10-30)

| Patch | Kind | Result |
| --- | --- | --- |
| `24-single-main.fix.patch` (drop `\|\| activeReservation != 0` from "FROST sweep main required") | positive | `Frost.SingleMain` 5/5; the amended files pass; the touched suites `Frost.DepositSweep*`, `Frost.SweepConflictResolution*`, `Frost.PublicVaultCallback`, `Frost.Custody`, `Frost.Movement*`, `Frost.Lifecycle*` pass (168 cases, 0 failing) |
| `24-reserved-only.wrong.patch` (refuse only while the intent is `Reserved`) | removal | 4 passing, 1 failing: "TimeoutPending: deposit-only sweep of one deposit: an ordinary deposit sweep (includeMain=false) was accepted while the main is reserved" |
| `24-ordinary-main.wrong.patch` (refuse deposit-only, but let an ordinary sweep spend and replace the reserved main) | removal | 2 passing, 3 failing: "Reserved: ordinary sweep of the deposits and the reserved main: an ordinary deposit sweep (includeMain=true) was accepted while the main is reserved", the same for TimeoutPending, and "e2e: ordinary main sweep while reserved: ... (includeMain=true) was accepted" |
| `24-overbroad.wrong.patch` (fix, plus refuse every sweep while reserved, including the resolution route) | over-broad | 4 passing, 1 failing: "C-04 sweep resolution: the approved resolution sweep of the reserved main: refused (... 'FROST sweep main reserved')" |
| `24-no-main.wrong.patch` (every deposit sweep must claim a main) | over-broad | 0 passing, 5 failing, each at "boundary: a no-main wallet's first deposit-only sweep is accepted: refused (... 'FROST sweep main required')" |

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
