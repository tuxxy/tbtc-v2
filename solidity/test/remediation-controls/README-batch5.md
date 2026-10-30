# Remediation batch 5: controls

Each patch is applied to a scratch checkout of the integration head (`2377d060`), compiled, run against its test, and reverted. A `.fix` patch is a plausible fix and the test must pass under it. A `.wrong` patch, or a patch with no suffix, removes or weakens a guard, and the test must fail at its own named assertion. None of these patches is part of any fix.

## tuxxy/tbtc-v2#26 and tuxxy/keep-core#92: `test/bridge/Frost.Fraud.MovementOutputCap.test.ts`

| Patch | Change | Expected result |
| --- | --- | --- |
| `26-raise-defense-cap.fix` | `FrostFraud.MAX_OUTPUTS` 128 to 252 | all five cases pass (largest admitted commitment 204 targets, largest provable movement 131) |
| `26-cap-admission.fix` | `FrostMovement.commit` asks for at most 128 targets | all five cases pass; the wallet commits 128 targets (both maxima 128) |
| `26-defense-cap-129.wrong` | `MAX_OUTPUTS` 128 to 129 (fixes the reported example only) | the 131 case fails at `the accepted 131-target movement has no usable unmined (AUTH_MOVEMENT) defense`; both maxima cases fail |
| `26-defense-cap-131.wrong` | `MAX_OUTPUTS` 128 to 131 (the largest provable movement, not the largest admitted commitment) | the three count cases and the provable-maximum case pass; the admitted-maximum case fails at `the worst-case unmined defense at the 204-output cap could not be measured: … 'FROST defense outputs'` |
| `26-refuse-admission.wrong` | `commit` refuses more than 128 targets but still requires the uncapped count | 129 and 131 fail at `a wallet that needs N targets has no accepted movement commitment` |
| `26-any-target-order.wrong` | on top of the raised cap, the movement defense stops checking each output's key | the count cases and the provable-maximum case fail at `a variant of the committed movement was defended` |
| `26-92-defense-gas-over-cap.wrong` | on top of the raised cap, the movement defense burns about 120,000 gas per output | the provable-maximum case fails at `the worst-case unmined defense at the 131-output cap uses 17906155 gas, not below the 16,777,216 transaction cap`; the admitted-maximum case runs out of gas |

**Observation, not a control:** an admission bound of one target (`26-cap-admission.fix` with 1 for 128) passes all five cases. The test sets no minimum admission bound because none is approved; the bound a fix chooses is for review.

## tuxxy/tbtc-v2#33: `test/bridge/Frost.SweepConflictResolution.ExposureReset.test.ts`

| Patch | Change | Expected result |
| --- | --- | --- |
| `33-no-exposure-reset` | delete `wallet.cancellationExposure = 0` from `FrostRedemptionLedger.resolveSweep` | the two fee > reservedNet cases fail at `the resolved reservation's cancellation exposure was not released`; the fee = reservedNet case passes |

## tuxxy/tbtc-v2#27 to #31: `test/portability/fresh-checkout.sh`

These patches are committed on local scratch commits (refs `refs/scratch/b5-<patch>` in the candidate repository, never pushed), and the runner is pointed at them with `PORTABILITY_COMMIT`. `27-host-artifact.wrong` sits on top of `27-full-history.fix`; the others sit on the integration head.

| Patch | Change | Case | Expected result |
| --- | --- | --- | --- |
| `27-full-history.fix` | the workflow's checkout takes `fetch-depth: 0` | 27 | passes (5/5) |
| `29-go-mod-download.fix` | a workflow step runs `go mod download all` in both Go helper modules before the tests | 29 | passes (4/4, 16/16) |
| `30-swap-three-files.wrong` | reverses 8be84b62, so the baseline reconstruction swaps three files and deletes `contracts/frost/` again | 30 | fails in `Frost.Identity` (the upgrade test) |
| `27-skip-upgrade.wrong` | `it.skip` on the upgrade test (the one that needs history); the file exits 0 with 4 passing | 27 | fails at `pending/skipped: … preserves every old storage field …` |
| `27-host-artifact.wrong` | `Frost.Identity` reads `~/.tbtc-portability-sentinel`, a host file nothing provisions (the runner creates it for the control and removes it after) | 27 | fails at `EPERM: operation not permitted, open '/Users/…/.tbtc-portability-sentinel'` |

`28-d1-checker-controls.sh` exercises the D1 baseline check (`evaluate.cjs d1`) on real builds, without a test run. The arguments are the candidate repository, `baseline-40a11d1d/solidity/build` and `upgraded-2377d060/solidity/build` (both `build-baseline.sh` outputs).

| Control | Expected result |
| --- | --- |
| `d1-build` | the 40a11d1d build with its own hashes: ok |
| `wrong-build` | the 2377d060 build: fails at `baseline source contracts/bridge/Bridge.sol differs from D1 40a11d1d` |
| `hashes-from-other-build` | the 40a11d1d build, with the hashes reported from the 2377d060 build: fails at `the run's baselineSourceHashes are not the D1 40a11d1d sources of its baseline build` |
| `no-origin` | the run wrote no origin: fails at `the run wrote no public-legacy-origin.json under the fresh root` |
