# Round-seven repair boundary — 27 October 2026

Recorded before implementation. Reviewed heads: keep-core
b6c05689033964e62d294f594b98193e6ebad95f; tbtc-v2
38eae7e0186deffb2411a200252674433bb9d7f1. Reviews
5674230284 / 5674230730. Governing spec
51b9a168e6b6c73d4d471f7d302267a065407fb5.

- K09-47: detect an upgraded Bridge independently of the optional alias. Missing
  alias on a proven extension refuses startup; unknown RPC failures fail closed.
  Preserve the explicitly identified pre-extension adapter and target safeguards.
- K09-46: retain advertised recipes across absent local grants. Only explicit
  finalized incompatible-input evidence permits durable retirement; fee/policy
  rejection and StatusAbandoned are insufficient. Preserve grants and tombstones.
- K09-48: assert the public recipe is journaled at channel.Send, with an owning
  removal control. K09-52: canonical threshold cohort and leader recovery must
  cover distinct operators, including signing, broadcast and proof failover.
- K09-49: ordinary tests own incomplete-grant release safety and deadline outcome;
  public fault configuration and local CLI remain confined to frosttest builds.
- K09-51: exercise shipped TbtcChain submission, nonce/error handling, concurrency,
  clock and mining behavior. Do not substitute the fixture's redemption adapter.
- K09-50: document original-selector partial-budget AND below-dust conservatism,
  plus MaintainerProxy's original-selector-only reimbursement limitation.

Private, source/head/artifact-bound focused evidence; <=8 Go cores and <=900s per
command, heavy jobs serialized. Preserve historical failures. No full acceptance,
Docker, CI, Kani, broad campaign, merge or release. All-duty K09-6, residual K09-29
and lifecycle criteria, authoritative V-05, models/replays and separately authorized
K09b remain open. No new owner-approved fee constants or activation policy.
Step 1 remains blocking pending independent disposition of the repairs.

Compatibility limitation (K09-50): the original resetMovingFundsTimeout selector
accepts no verified main preimage. Its conservative route check cannot distinguish
partial positive capacity below the actual main balance, or an actual main below
the drain dust threshold, in ANY creation mode. Upgraded hosts use the additive
verified-main selector. MaintainerProxy still wraps only the original selector:
reimbursed third-party resets cannot recover the pre-cutover zero-live-wallet
partial-capacity or below-dust cases. Use upgraded native host recovery there.
This preserves the required fleet-upgrade-before-drain activation condition.
A timeout reset preserves custody but is not a below-dust settlement transition.
