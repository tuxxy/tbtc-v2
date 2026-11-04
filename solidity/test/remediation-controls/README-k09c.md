# K-09 contract-only tests: controls

Tests: `test/k09/K09.RegistryCutover.test.ts` (tuxxy/tbtc-v2#16, K09-5), `test/k09/K09.LegacyObligations.test.ts` (tuxxy/tbtc-v2#16 inventory, tuxxy/keep-core#25 K09-4), `test/k09/K09.CutoverInvariants.test.ts` (tuxxy/keep-core#25, #31, #32).

Each patch is applied to a scratch checkout of the candidate head, compiled, run against its test files and reverted by `k09c-run-controls.sh <scratch-solidity-dir> <log-dir> [patch ...]`. A patch with no suffix removes a guard. A `.wrong` patch is a plausible wrong change. Either way the named case must fail at its own named assertion. None of these patches is part of any fix.

| Patch | Change | Expected result |
| --- | --- | --- |
| `k09c-5-no-idle-check` | delete the `Legacy DKG not idle` check from the cutover (`FrostExposure.dispatch`) | the four non-idle state cases fail at `cutover refused in <state>`, and the late-approval case at `cutover refused while approval is pending`: the sortition-pool check now answers `Legacy sortition pool locked` |
| `k09c-5-no-dkg-guards` | delete both the idle and the sortition-pool checks | the same five cases fail at the same assertions: the cutover completes during a DKG |
| `k09c-12-no-mode-gate` | delete the creation-mode check from `Wallets.requestNewWallet` | `[K09-12] refuses a new ECDSA wallet…` fails at `cutover refusal`; `[K09-4]` at `ECDSA wallet request after the cutover`; `[in-flight-registration]` at `no ECDSA request after the cutover`; the K09-5 late-approval case at `new ECDSA request refused after the cutover`; the ledger fails at `uncovered obligation class: legacy-dkg-in-flight` |
| `k09c-12-no-admission-gate` | delete `requireAdmission` from the FROST deposit reveal | `[K09-12] refuses a new FROST deposit under containment…` fails at `containment refusal` |
| `k09c-12-no-reserve-gate` | delete the containment check from `FrostExposureController.reserve` | `[drain-commitment]` fails at `containment refuses the drain`; the ledger fails at `uncovered obligation class: moving-funds (route drain-commitment)` |
| `k09c-11-no-closure-obligations` | delete the obligations check from `FrostLifecycle.finalize` | `[K09-11]` fails at `closure with an open challenge` |
| `k09c-4-contained-blocks-legacy-sweep.wrong` | containment also stops legacy deposit sweeps (`DepositSweep`) | `[deposit-sweep]` and the interleaving case fail at `deposit-sweep discharges`; the ledger fails at `uncovered obligation class: unswept-deposit (route deposit-sweep)` |
| `k09c-ledger-drop-witness` | delete the `closing-elapsed` witness case | the ledger fails at `uncovered obligation class: closing-wallet (route closing-elapsed)` |
| `k09c-ledger-drop-route` | drop the veto route from the ledger's class table | the ledger fails at `unmapped baseline entrypoint: notifyRedemptionVeto` |
| `k09c-5-no-callback-gate` | delete the creation-mode check from `Wallets.registerNewWallet` (the Bridge side of "no ECDSA registration after FrostOnly") | **vacuous here, recorded:** every case still passes. Through the real WalletRegistry this check cannot be reached: the cutover refuses while any DKG is in flight, and no DKG can start after the drain begins. Its own witness is the C-10 component suite (`Frost.CutoverExposure`, registry fixture) |
