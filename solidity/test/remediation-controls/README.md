# Remediation batch 1 controls

Each patch changes production code in a scratch build only; it is applied,
the contracts are recompiled, the named test file is run, and the patch is
reverted. None is ever committed to `contracts/`.

| Patch | Test file | Expected | Result recorded 2026-10-28 |
| --- | --- | --- | --- |
| `24-drop-custody-equality.patch` (naive #24 fix: drop the main-equals-custody check in `commit`) | `Frost.Movement.NonMainCustody.test.ts` | the "never closes ... recognized output behind" guard fails | fails: "partial movement: the wallet closed with recognized custody left: Expected "49000" to be equal 0"; the two drain cases still fail (path A now at "FROST movement input") |
| `25-fresh-period-for-terminated.patch` (fix-shaped: a terminated wallet regaining custody opens a fresh period, state kept) | `Frost.Lifecycle.TerminatedRegain.test.ts` | both cases pass | 2 passing |
| `25-reopen-clears-terminated.patch` (wrong: reopen a terminated wallet into MovingFunds) | `Frost.Lifecycle.TerminatedRegain.test.ts` | both cases fail at the terminated-status assertion | fails: "terminated wallet: regaining custody cleared its terminated status: expected 5 to equal 8" |
