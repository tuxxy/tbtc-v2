# Round 4 remediation contract

Recorded before implementation against keep-core afc90fb32a35a3015c09b5c9f18ea73e15d38174
and tbtc-v2 a92a4cceb4faff69e0d90add16f10f9355ea7f56; spec
51b9a168e6b6c73d4d471f7d302267a065407fb5. Reviews 5655962724 / 5655963449.

- K09-27: an unconfigured production legacy adapter must reject any target
  absent from the legacy wallet registry before proposal/signing. Use legacy
  reads, without probing FROST selectors on pre-extension deployments; unknown
  targets are never permission to construct P2WPKH. Configured descriptors remain
  bound to the same proxy. Exercise the actual production resolver.
- K09-28: uncommitted legacy MovingFunds crossing cutover remains resettable
  while FROST routing is disabled, contained or lacks eligible targets, regardless
  of legacy Live count. Exercise all six combinations, repeated resets, preserved
  obligation/accounting frame, and successful commitment after reopening.
- K09-29: agree incoming inputs at the finalized round anchor. Retain signed
  intents verbatim; abandon unsigned obsolete plans durably only after checking
  durable outcomes/possible releases and finalized authorization. Test adjacent
  incoming records, changed custody, reservation deferral and restart.
- K09-30: durable KeyReady plus exact canonical certification can reload from
  RegisteredPendingReady; Candidate/no-key and true quarantine remain lost.
  Process cancellation after durable KeyReady must not manufacture quarantine.
  Kill at certificate submit and readiness postcondition; settle incoming to the
  recovered wallet. Keep pre-KeyReady negative controls.
- K09-31: prefer an admissible FROST drain while enabled before cutover; fall
  back to legal legacy targets only in modes 0/1 when drain is unavailable.
  FrostOnly never falls back. This preserves existing new-routing preference;
  the owner has not approved changing that preference.
- K09-32/33: bind all changed legacy Go packages and legacy Bridge suites, or
  explicitly record excluded suites and reason; strengthen reservation duty
  oracle, correct IPv6 evidence; retain legacy no-result and wall-clock behavior.

Concrete tests only; controls must fail at their owning assertion in disposable
copies. Limits before runs: <=8 Go cores, <=900 seconds per command; serialize
Core/tss jobs. Private output remains scanned/hashed under retained evidence.
No merge/release, Docker, CI, Kani or final mutation campaign. Models/replays,
V-05, all-duty automation and existing remaining findings stay open.
