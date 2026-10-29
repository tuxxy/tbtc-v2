# Batch 2 controls (tbtc-v2)

Refs tuxxy/tbtc-v2#18, #20, #22 and D8; the tests are
`test/bridge/Frost.Movement.LegacyAfterCutover.test.ts`. Each `b2-*.patch` is
applied to a scratch checkout of `integration/frost-base` `2377d060`, compiled,
the test file run with `USE_EXTERNAL_DEPLOY=true TEST_USE_STUBS_TBTC=true`, and
reverted. None is committed to production code.

`movementWorld` refuses any deployed contract above EIP-170 (24,576 bytes).
At `2377d060` `MovingFunds` has about 90 bytes left and `Bridge` about 318, so
these controls sit in `Bridge.sol` wrappers or `MaintainerProxy`, and a fix
must fit the same margins.

Without a control (integration `2377d060`): 27 passing, 7 failing (the #18
refusal, the four FrostOnly resets with a legacy Live wallet, the two
reimbursed FrostOnly resets with a legacy Live wallet).

| Patch | Kind | Result recorded 2026-10-28 |
| --- | --- | --- |
| `b2-18-fence.fix.patch` (legacy targets refused in FrostOnly, in the `Bridge` wrapper) | positive | the #18 test passes; every #18 guard still passes; 28 passing, 6 failing (only the #20/#22 cases with a legacy Live wallet) |
| `b2-20-reset.fix.patch` (crude: the reset ignores the Live count in FrostOnly) | positive | every #20 and #22 case passes; 33 passing, 1 failing (only #18) |
| `b2-18-all-modes.patch` (legacy targets refused in every mode) | removal | fail: "in LegacyOpen, a legacy-target commitment was refused", "in LegacyDraining, …", "before the cutover, a legacy-target commitment was refused" |
| `b2-18-fence-proof.patch` (the proof of a pre-cutover legacy commitment refused after the cutover) | removal | fails: "after the cutover, the proof of a legacy commitment made before it was refused" |
| `b2-20-frostonly-no-reset.patch` (no reset in FrostOnly) | removal | the four FrostOnly zero-Live recovery guards fail: "period 1: no legacy reset entrypoint accepts the reset …: No reset after cutover"; the zero-Live reimbursed guard fails: "no reimbursed reset through MaintainerProxy …" |
| `b2-20-any-budget-blocks-reset.patch` (K09-39: an enabled drain with an eligible target blocks the reset, whatever budget or containment) | removal | every budget-partial, budget-exhausted and contained zero-Live guard fails in all three modes: "period 1: no legacy reset entrypoint accepts the reset …: FROST drain route available"; all three zero-Live reimbursed guards fail |
| `b2-22-unwrapped-reset.patch` (a new verified-main Bridge reset with no MaintainerProxy wrapper) | removal | fails: "MaintainerProxy has no reimbursed wrapper for resetLegacyMovingFundsTimeout(bytes20,(bytes32,uint32,uint64))" |
| `b2-22-no-refund.patch` (MaintainerProxy resets without refunding) | removal | all three zero-Live reimbursed guards fail: "the MaintainerProxy reset did not reimburse its caller: Expected "0" to be greater than 0" (re-recorded 2026-10-29 after review R7) |
| `b2-22-wrong-recipient.patch` (the refund goes to the MaintainerProxy owner, not the caller; review R7) | removal | all three zero-Live reimbursed guards fail: "the MaintainerProxy reset did not reimburse its caller: Expected "0" to be greater than 0". Before R7 the test checked only that the pool lost ETH and all 34 cases passed under this patch with the positive controls |
| `b2-D8-restricted.patch` (below-dust notification restricted to the treasury) | removal | all six below-dust guards fail: "a third party cannot end a below-dust source" |
