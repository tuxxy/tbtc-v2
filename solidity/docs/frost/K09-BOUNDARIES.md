# K-09a contract integration boundary

Recorded 23 October 2026, before code. Companion to keep-core
pkg/frost/integration/verification/BOUNDARIES.md and its exact source pins.

KC-SF-V3 section 6 K-09 and section 8.3 govern this local integration.
Use the reviewed C-10 contracts above 767ce3a33. Bridge.sol stays unchanged.
No production funding or verifier qualification is claimed.

## Fault model and public entry points

Exercise a transparent proxy upgrade from the immutable 76f7905 baseline,
retaining publicly created legacy obligations; do not manufacture their
precursors with storage writes. Use real Bank and Bridge entry points.
Controlled registry and retained known-key Bitcoin fixtures are explicitly
local assumptions. Separately run production Bitcoin SPV validation on
realistic retained headers at actual difficulty/depth settings.

## Invariants and verification plan

- Preserve pending deposits, redemption escrow, incoming/outgoing movement,
  challenges and watchtower policy across the upgrade in reachable fixtures.
- Check the relevant full state frame before/after a rejected operation.
- Complete positive settlement/recovery witnesses and reject duplicate credit.
- New DKG uses FROST after cutoff; legacy pending work survives cutoff and
  containment; creation mode never rolls back automatically.
- Valid production SPV vectors pass; invalid links, work, inclusion and depth
  fail at their owning validation guard. Regtest zero difficulty is separate.

Every new guard has a focused negative control and a successful witness.
Reuse unchanged component acceptance evidence; keep Core suites sequential.
Record run limits, source/artifact hashes and evidence class. No CI, Docker,
mutation campaign or changes to Bridge.sol are part of this package.

## Readings (OPEN)

1. Separate public legacy fixtures may carry obligations requiring mutually
   exclusive source wallet states across the same implementation upgrade.
2. Production SPV vectors form a second run, separate from the live regtest
   lifecycle; they do not qualify the relay deployment or Bitcoin operations.
3. K-09a does not close K-09b, V-05, C-07 qualification or deployment gates.

## As implemented (23 October 2026)

`Frost.LifecycleUpgrade` supplies three checkpoints built only through public
entry points on the immutable 76f7905 baseline: an unswept deposit and open
heartbeat fraud challenge, an outgoing commitment, and an incoming sweep.
Each actual transparent-proxy upgrade retains legacy slots 0..128 and the
relevant financial/obligation frame. Real Core transactions complete the
pending sweep and both sides of the legacy movement. Duplicate calls retain
the frame and fail at their intended guards. The existing signed-redemption
and watchtower upgrade witness also passes unchanged.

The legacy helper now exposes a before-sweep checkpoint, installs a real
reimbursement pool, and can continue a known-key Core spend to the committed
legacy target. The controlled registry exposes only local membership,
seize and close adapters needed by these public legacy entry points.
The test keys are public scalars 3 and 4; neither registry sanctions nor
threshold ECDSA qualification is claimed by these fixtures.

`Frost.LifecycleSpv` runs production BitcoinTx validation at difficulty
7,019,199,231,177 and factor six, separately from live regtest evidence.
Six mainnet headers pass. Five negative cases attribute insufficient depth,
bad linkage, bad header work and bad transaction/coinbase inclusion to their
specific guards. `hardhat.k09.config.ts` retains EIP-170, disables the gas
reporter's replacement reporter and emits machine-readable case results.

Primary run: 6/6 SPV and 9/9 upgrade/reconciliation cases. The three new
upgrade cases were rerun after financial-frame review; the two movement
cases were further checked for their exact duplicate-call revert reason.
Evidence: `implementation/K-09/local-2026-10-23/`, including `run/result.json`,
`upgrade-review.log` and `upgrade-duplicate-review.log`. Matching host record:
keep-core `test/frost/K09.md`. Results are concrete testing only.
All readings above remain OPEN for owner review. Production Bridge/libraries
are unchanged; no mutation campaign or production gate is completed.

## Review corrections (24 October 2026)

The current suite has seven public upgrade cases plus six existing reconciliation
cases, plus one isolated seeded request-state guard control (14 total), alongside six realistic-header library cases. Added cases
retain original redemption and fraud deadlines, outgoing and incoming timeout
obligations, alias the redeemer with its timeout notifier, reject repeated
discharge, and close the source after completed movement. The incoming replay
supplies the current target main and reaches the input-count guard: the original
sweep has one input, whereas an existing main requires two. The separate seeded
component control directly exercises successful pending-request consumption and
then rejection at the consumed-request guard, preserving its state frame.
The native digest executable is SHA256 pinned; there is no temporary fallback.

The fresh paired execution is recorded under
`implementation/K-09/review-feedback-2026-10-24/run/result.json`. Its status and
source/artifact manifests determine current acceptance. Earlier executions above
are historical and are not reused for changed-source acceptance.

The realistic-header suite exercises BitcoinTx library validation; it does not
establish the full FROST producer/entry-point join at production settings. The
paired host CLI now derives proof depth from the Bridge factor and relay epochs,
using its explicit confirmation argument as an additional floor. Its retarget
and DIFF1 tests use a controlled assembler. That remaining full proof join is an
OPEN K-09 exit requirement owned by the SPV integration owner.

The separate native legacy-to-FROST drain is a seeded component control. A public
legacy obligation through upgrade, cutover and containment into FROST drain and
incoming sweep remains OPEN under the integration lead. Real node dispatch and
firewall qualification remain OPEN under the node integration lead; the local
host witness uses two in-process bundles and firewall.Disabled. These are not
approved deferrals. See the paired K09-COVERAGE.json for all review dispositions.
