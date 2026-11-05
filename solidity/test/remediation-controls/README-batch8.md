# Remediation batch 8: controls

`b8-run-controls.sh <scratch-solidity-dir> <log-dir> [control ...]` applies each control to a scratch checkout of the candidate head, compiles, runs `test/b8/*.test.ts` and reverts. A control is one patch, or several joined by `+` and applied in order.

- A `.fix` patch is a plausible fix, and the tests it targets must pass under it.
- A `.wrong` patch is a wrong or partial fix, and the tests must fail at their own named assertions.

None of these patches is part of any fix. The suite also fails at head, with the current contracts. That is the removal control for each decision: there is no cap, the commitment is blocked by inbound obligations, and there is no NatSpec.

## ADV-C1 and tuxxy/tbtc-v2#49: `test/b8/B8.MovementTargetCap.test.ts`

| Control | Change | Expected result |
| --- | --- | --- |
| head | no cap | both "needs 129" cases fail at `ADV-C1: the <route> commitment naming 129 targets was accepted (cap 128)`; both "exactly 128" cases pass |
| `b8-c1-cap-128.fix` | `FrostMovement.commit` and the drain branch of `MovingFunds.submitMovingFundsCommitment` ask for at most 128 targets | all four pass; MovingFunds keeps 43 B of its EIP-170 space |
| `b8-c1-cap-129.wrong` | the same with 129 | both "needs 129" cases fail at `... naming 129 targets was accepted (cap 128)` |
| `b8-c1-frost-route-only.wrong` | the cap on the FROST route only | the drain "needs 129" case fails at `ADV-C1: the ECDSA-to-FROST drain commitment naming 129 targets was accepted (cap 128)` |

## ADV-C2: `test/b8/B8.UnsignedMovementTargets.test.ts`

| Control | Change | Expected result |
| --- | --- | --- |
| head | `requireClear` counts inbound commitments for the target's own commitment | both movement cases fail at `ADV-C2: a target with an unsigned inbound movement cannot commit its own movement: ... 'FROST movement obligations'`; the reset case passes (the reset never read obligations) |
| `b8-c2-commit-ignores-inbound.fix` | `requireClear` ignores inbound commitments for a commitment, and keeps them for the dust closure | all three pass |
| `b8-c2-closure-ignores-inbound.wrong` | the fix above, and it also drops bit 4 from the closure obligations | both movement cases fail at `ADV-C2: closure obligations do not name the inbound commitment` |

## RebateStaking: `test/b8/B8.RebateStakingPrecondition.test.ts`

| Control | Change | Expected result |
| --- | --- | --- |
| head | no NatSpec | the documented case fails at `RebateStaking: the NatSpec of revealFrostDeposit does not state the RebateStaking precondition ...`; the other three pass |
| `b8-r-docs.fix` | NatSpec on `IFrostFundingBridge.revealFrostDeposit` and `Bridge.setRebateStaking` | all four pass |
| `b8-r-no-refusal.wrong` | removes the `FROST rebate unsupported` guard | the refused case fails |
| `b8-r-legacy-rebate-off-with-frost.wrong` | legacy reveals skip the rebate once a FROST registry is configured | the legacy case fails at `RebateStaking: a legacy reveal's rebate differs from 40a11d1d` |

## RebateStaking unset (D20): `test/b8/B8.RebateStakingUnset.test.ts`

Interface (D20 option (b)): `BridgeGovernance.setRebateStaking(address(0))` by the BridgeGovernance owner unsets a set RebateStaking.

| Control | Change | Expected result |
| --- | --- | --- |
| head | `BridgeState.setRebateStaking` refuses 0x0 and a set address | the unset and no-rebate cases fail at `D20: governance could not unset RebateStaking on a Bridge where it is set and reinitializer(5) is spent: expected '... Rebate staking already set' to equal ''`; the governance-only case passes |
| `b8-r-unset-zero.fix` | `BridgeState.setRebateStaking` accepts 0x0 when an address is set; every other input keeps its rule and reason | all three pass |
| `b8-r-unset-zero.fix` + `b8-r-unset-no-access.wrong` | the fix, and `Bridge.setRebateStaking` lets anyone pass 0x0 (no access check on the unset path; dropping `onlyGovernance` outright exceeds EIP-170) | the governance-only case fails at `D20: the BridgeGovernance owner calling the Bridge directly unset RebateStaking without governance` |
| `b8-r-unset-zero.fix` + `b8-r-unset-governance-no-owner.wrong` | the fix, and `BridgeGovernance.setRebateStaking` without `onlyOwner` | the governance-only case fails at `D20: a third party through BridgeGovernance unset RebateStaking without governance` |

Results of the runs are recorded in `K-09-restart/TESTS-BATCH8.md`.
