# Round-five remediation boundary — 27 October 2026

Reviewed pair: keep-core bda2b0aa04df856fe997e9e867863b6aac43de76;
tbtc-v2 e4883a33a67a08270fc8b543609cbc04f10fc625. Governing spec
51b9a168e6b6c73d4d471f7d302267a065407fb5. Reviews 5667802743 / 5667803422.
Record this boundary before implementation; this is concrete testing, not a
model/replay exit or production qualification.

- K09-34: any durable worker attempt/grant is a possible release, including
  grant without done. Uncertainty pins the existing intent. Check shared callers
  and a killed worker at the actual grant boundary; missing completion is never
  evidence that no signature escaped.
- K09-28/31/35: drain admissibility includes enabled, not contained, eligible
  targets and enough remaining custody for the source. An uncommitted legacy
  obligation retains a reachable reset after cutover when no legal route exists;
  the host must issue due resets repeatedly. Reopen a budget and drain normally.
  Pre-cutover legal legacy fallback remains available.
- K09-36 reading: reset only when no admissible route exists in the current mode,
  including the historical zero-live path. This prevents reset from defeating an
  available drain. Owner answered "idk" to the policy question; this is an
  implementer reading for independent review, not an explicit owner decision.
- K09-29 reading: agree a common public incoming recipe; every node verifies it
  against canonical custody and its own fee ceiling. Preferred local fee rates
  are not competing signing intents. A restrictive ceiling may refuse signing;
  it must not cause unsafe signing. Owner answered "idk"; reading awaits review.
- K09-30/37: durable KeyReady resumes reload/readiness before certification;
  genuinely missing pre-key seats remain lost; transient errors retry and true
  quarantine remains terminal. Exercise both sides of durable SaveKey.
- K09-38: an expired runtime bound exits nonzero; explicit operator cancellation
  may exit zero. A timeout is never a successful test outcome.
- K09-32: execute original Bridge.Wallets/MovingFunds under the standard upstream
  environment/config; bind actual counts and correct inaccurate current claims,
  preserving failed historical records. Reuse only applicable identical-code
  results; changed source invalidates affected correspondence.

Limits: <=8 Go cores, <=900 seconds per command, serialized Core/tss/heavy jobs.
Private diagnostics: umask077, directories0700, files0600; never decode opaque
worker records. Focused regressions and owning guard controls first; publish
bounded draft progress without repeated broad acceptance runs. No Docker, CI,
Kani, broad mutation campaign, merge or release. K09-6 and combined all-duty
criteria, models/replays, V-05 and separately authorized K09b remain OPEN.
