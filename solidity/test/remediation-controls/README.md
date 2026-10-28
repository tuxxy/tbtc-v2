# Remediation batch 1 controls

Each patch changes production code in a scratch build only; it is applied,
the contracts are recompiled, the named test file is run, and the patch is
reverted. None is ever committed to `contracts/`.

| Patch | Test file | Expected | Result recorded 2026-10-28 |
| --- | --- | --- | --- |
| `24-drop-custody-equality.patch` (naive #24 fix: drop the main-equals-custody check in `commit`) | `Frost.Movement.NonMainCustody.test.ts` | the "never closes ... recognized output behind" guard fails | fails: "partial movement: the wallet closed with recognized custody left: Expected "49000" to be equal 0"; the two drain cases still fail (path A now at "FROST movement input") |
| `25-fresh-period-for-terminated.patch` (fix-shaped: a terminated wallet regaining custody opens a fresh period, state kept) | `Frost.Lifecycle.TerminatedRegain.test.ts` | both cases pass | 2 passing (rechecked with the R4 assertions: sanction kept at every step, closure at the original deadline) |
| `25-reopen-clears-terminated.patch` (wrong: reopen a terminated wallet into MovingFunds) | `Frost.Lifecycle.TerminatedRegain.test.ts` | both cases fail at the terminated-status assertion | fails: "terminated wallet: regaining custody cleared its terminated status: expected 5 to equal 8" |
| `25-renew-terminated-at.patch` (review probe25resetdeadline: the fix-shaped change plus renewing `terminatedAt` at the fresh movement; state stays Terminated) | `Frost.Lifecycle.TerminatedRegain.test.ts` | both cases fail at the sanction-preservation assertion | fails: "terminated wallet: the original terminatedAt changed after the movement proof" (both cases) |

## Batch 1b (fix review of tuxxy/tbtc-v2#45)

Run on the fix head `6138226d` (its `FrostMovement.sol` copied into the
scratch build), then with the control applied on top of it.

| Patch | Test file | Expected | Result recorded 2026-10-28 |
| --- | --- | --- | --- |
| none (fix head `6138226d`) | `Frost.Lifecycle.TerminatedRegainDust.test.ts` | passes | 1 passing (the two frozen #25 cases pass too) |
| `25-open-period-in-commit.patch` (review W-h, against the fix head: the fix in `reopen` undone and the fresh period opened inside `commit` instead) | `Frost.Lifecycle.TerminatedRegainDust.test.ts` | fails at the dust assertion | fails: "terminated wallet: the dust-sized custody regained after its proven movement cannot be recorded as dust: ... 'FROST movement dust state'"; the two frozen #25 cases still pass, which is the gap this test closes |
| `25-dust-writeoff.patch` (review R5: after `lifecycle.dust = true`, zero a reopened terminated wallet's custody value without a spend proof) | `Frost.Lifecycle.TerminatedRegainDust.test.ts` | fails at the retained-dust assertion | fails: "terminated wallet: the retained dust custody value changed after the dust notification: Expected "0" to be equal 14000"; the two frozen #25 cases still pass |
