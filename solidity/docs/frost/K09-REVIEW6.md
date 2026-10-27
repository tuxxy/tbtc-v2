# Round-six repair boundary — 27 October 2026

Reviewed pair: keep-core f29d2bcc91e27752b2601a92279cd5b3442660af;
tbtc-v2 653b44393c960dc209d2e55bad8384df55d415d0. Governing spec
51b9a168e6b6c73d4d471f7d302267a065407fb5. Reviews 5671041158 / 5671041953.

Record before implementation. Concrete scoped testing; not K-09 exit.
- K09-39/40: no-route resets reachable in FrostOnly or zero-legacy-live modes,
  including partial/zero capacity, containment, disabled drain, absent targets
  and below dust. Use verified main preimage, repeat before timeout and reopen.
  Keep original selector conservative without balance; honest upgraded host uses
  additive selector in all modes. Original selector compatibility limitation is
  explicit; no unsafe estimate from opaque hash. Preserve legal legacy fallback
  when the local FROST target index is incomplete.
- K09-41: a leader never replaces an advertised recipe based only on its own
  absent grant. Persist recipe publication before sending; retain until canonical
  reconciliation. Exercise follower-only grant with leader interrupted before
  claim and new incoming. Do not undo existing possible-release protection.
- K09-42: shared transaction mutex covers nonce/submission only; receipt latency
  cannot hold up unrelated submissions. Prefer existing transactor behavior.
- K09-43: fault hooks and local CLI registration belong to an explicit test build
  or test adapters, not ordinary production configuration.
- K09-44: exact owning revert reasons, correct membership, follower ceiling
  rejection at actual call site and a targeted owning control.
- K09-45: capture source/artifact/head manifests before each focused execution,
  verify unchanged afterwards, bind results and private hashes. Historical
  unbound results are not retroactively promoted.

Route-refusal and fee policy are implementer readings awaiting owner/independent
review. No arbitrary production fee constants. Drain activation follows upgraded
operator fleet. Shared fee values alone do not repair distributed recipe pinning.
Limits: <=8 Go cores, <=900 seconds per command; serialize Core/tss/heavy jobs.
Evidence private directories0700/files0600. Never decode worker records. No Docker,
CI, Kani, full acceptance sweep, broad mutation campaign, merge or release. K09-6,
combined reserve/pay/prove stale-main, residual lifecycle criteria, models/replays,
V-05 and separately authorized K09b remain OPEN.

Round-seven compatibility clarification (K09-50): the original selector is also
conservative when the actual main balance is BELOW DUST, not only on partial
positive capacity; this applies in every creation mode. MaintainerProxy wraps
only that original selector, so reimbursed third-party resets cannot service the
pre-cutover zero-live partial-capacity/below-dust cases. Upgraded native clients
use the additive verified-main selector. Fleet upgrade precedes drain enablement.
A timeout reset preserves custody; it does not perform the below-dust transition.
