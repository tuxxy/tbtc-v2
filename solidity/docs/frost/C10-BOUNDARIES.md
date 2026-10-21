# C-10 budgets, containment and DKG cutover: boundaries

Written on 21 October 2026, before the C-10 code. This fixes what C-10 builds,
where each check sits, which component is trusted, and what stays open. It
is the contract-side half of two KC-VER obligations:

- P-K11-CUTOVER-ONE-WAY: the `FrostOnly` switch is atomic and permanent.
- P-K11-CONTAINMENT-KEEPS-EXITS: budget counters are monotone, and
  containment blocks only new exposure.

KC-SF-V3 basis: C-10, SC-01, SC-09, BOUND-03, BOUND-04, BOUND-06, BOUND-11
and BOUND-12. D-10 (budgets, response window, enforcers, pause authority,
top-up policy) has no owner values yet. Every number and authority below is
a test value marked OPEN.

## Fault model (D-10 reading, OPEN)

| Role | Component |
| --- | --- |
| Assumed faulty | FROST deposit validation: the relay and SPV proof, funding admission, sweep input and fee accounting in `FrostDepositAdmission` and `FrostDepositSweep`, and the C-07 verifier. A fault may credit value that never entered custody. |
| Trusted enforcer | `FrostExposureController`, a separate contract with its own storage and authority. Bridge code can change its counters only through its API. |
| Trusted binding | The single FROST Bank credit statement, `creditBank` in `FrostDepositSweep`. It computes the depositor credits and the treasury credit (the sum of the deposits' recorded treasury fees) itself, reports exactly their total to the controller with the value admitted and the reserved part of it, and passes exactly those credits to the Bank. No other accounting value reaches the Bank. |
| Not bounded | Compromise of the Bridge implementation or its proxy admin, the Bank owner, or the controller's governance. A Bridge with a faulty credit statement can call the Bank directly; the bound does not survive that (KC-SF-V3 SC-09). |

**Releases restore no allowance.** A drain release
(`releaseFrostDrainOnConflict`, or a legacy proof that replaces the committed
main) rests on an SPV proof from the same relay that the fault model assumes
faulty. Under that fault a fabricated legacy proof could release a drain
whose real transaction later confirms. A release is therefore recorded
(`custodyReleased`, the reservation `RELEASED`) but its custody stays counted
against the ceiling, so the cumulative custody bound holds under the relay
fault as well. Reusing released custody needs a governance top-up, a new
budget period with a record. Decided on 23 October 2026 (reading 8),
following the Astra re-check of #14.

Outside the authorized-inflow cap, and never credited: unsolicited BTC sent
to a FROST key without a reveal, and BTC at a revealed deposit output that is
never reserved. Such a deposit is spendable by FROST keys until its refund
locktime, but no proof credits it without charging the ceilings first. Both
are reported separately and not counted.

## Exposure controller

`FrostExposureController` is deployed on its own. Its constructor fixes the
Bridge address and the initial governance, which may name a guardian.

**Counters** (satoshi, all monotone, never reset):

| Counter | Grows when |
| --- | --- |
| `custodyReserved` | a custody reservation is made, or a completion exceeds its reservation |
| `depositsOutstanding` | a deposit is reserved; a deposit sweep consumes it (the only counter that falls) |
| `custodyReleased` | a drain reservation is released because its committed main moved elsewhere (recorded only: it restores no allowance) |
| `custodyAdmitted` | a reservation completes (reporting) |
| `issuanceReserved` | an issuance reservation is made, or a credit exceeds its reservation |
| `issued` | a Bank credit completes |

**Ceilings.** A budget period sets the two cumulative ceilings:
`custodyReserved <= custodyCeiling` and
`issuanceReserved <= issuanceCeiling`. `issued <= issuanceReserved` holds by
construction.

**Invariants the tests check:**

1. Counters never decrease, except `depositsOutstanding`, which a sweep
   consumes. No call resets them, including a new period.
2. Every FROST Bank credit increases `issued` by exactly the credited sum
   (depositor amounts plus treasury fee) in the same transaction.
3. A drain reservation completes or releases at most once. A deposit sweep
   is covered by at most `depositsOutstanding`, the reserved deposit value
   not yet swept.
4. A completion that exceeds its reservation, or names no reservation, must
   fit under the ceilings and is refused under containment. A drain
   completion without a reservation leaves no record: the ceilings bound it,
   not its ID, so a repeated or fabricated ID is charged again.
5. **Deposits are counted in aggregate** (adversarial review of #14). The
   Bridge marks a deposit reserved (`reservedAt`, in the slot `sweptAt`
   shares) and reports per sweep the admitted value, the credited total and
   the reserved value among them. The controller covers at most the
   outstanding reserved value and charges the rest. A faulty Bridge that
   misreports which deposits were reserved can only spend allowance already
   counted against the ceilings, so `issued <= issuanceReserved <=
   issuanceCeiling` and the custody bound hold. What is lost is per-deposit
   attribution: the unused issuance (fee) of a reserved deposit can cover an
   unreserved one in the same sweep. A per-deposit record would cost a cold
   write per input, and the C-04 joint maximum through a vault then needs a
   17,067,940 gas limit, above the cap.
6. Losses, rotation, withdrawals, redemptions, refunds and drain releases
   never add allowance. Only a new budget period does.

**Authority.**

- `openBudgetPeriod(custodyCeiling, issuanceCeiling, record)`, governance
  only. This is the top-up. Each period has a new ID and a nonzero review
  record. A ceiling may not be set below what is already reserved.
- `transferGovernance(next)` then `acceptGovernance()` by `next`: two steps,
  because the controller can never be replaced and a wrong address would
  freeze top-ups and lifts.
- `setGuardian(address)`, governance only.
- `contain(reason)`, guardian or governance.
- `lift(record)`, governance only, with a nonzero review record.
- `reserve`, `completeOne` and `release` (drains), `reserveDeposit` and
  `completeDeposits` (deposits): the Bridge only.

## Reservation sources

| Inflow | Reserve | Complete | Release |
| --- | --- | --- | --- |
| FROST deposit | `reserveFrostDeposit(outpoint, fundingTx, proof)`, permissionless, once. It needs an SPV proof of the revealed funding transaction and the refund locktime more than `frostDepositReservationMargin` (governance, OPEN) ahead, and reserves custody and issuance equal to the deposit amount. | At the sweep proof, in aggregate: custody is the deposits' amounts; issuance is the depositor amounts plus their treasury fees. | Never. A reservation is refused once the deposit could be refunded before a sweep lands; one refunded after it keeps its reservation (OPEN). |
| Legacy drain into FROST | At the legacy moving-funds commitment that names FROST targets, for a source at or above the moving-funds dust threshold. Custody equals the source main's value; issuance is zero. | At the movement proof, with the value that reached the FROST targets. A drain-committed source is proven only as a drain: legacy-shaped outputs to the FROST labels are refused. | When the committed main can no longer move: `releaseFrostDrainOnConflict` (spent elsewhere), or any other legacy proof that replaces or deletes it (deposit sweep, moved-funds sweep, redemption). Every release clears the commitment, whichever lands first, so the source recommits and reserves the new main's full value before any signature. A drain is keyed by its source and committed main. |
| FROST to FROST movement | none: rotation adds no new custody | — | — |
| Moved-funds receiving sweep | none: no credit | — | — |

A deposit sweep that includes a deposit without a reservation reserves and
completes it in the proof. This is refused under containment or over a
ceiling, and then the sweep proof reverts. A correct host therefore reserves
every deposit before it signs a sweep (keep-core obligation below).

A reveal does not reserve. A reveal is not proven, so a reservation at reveal
would let anyone exhaust the budget with fake reveals. Reserving a deposit
needs a proof that the BTC reached the deposit output. The proof shows the
output existed, not that it is still unspent, so a reservation is refused
inside the refund margin: there the depositor, not FROST, can take the BTC
next (adversarial review of #14).

An approved C-04 conflict-resolution sweep runs the same credit statement.
If it includes an unreserved deposit, it is refused under containment or
over a ceiling, and the redeemers' refund of that intent waits for a lift or
a top-up. The host's reserve-before-sign rule prevents this.

## Containment

| Path | Under containment |
| --- | --- |
| FROST deposit reveal | refused |
| `reserveFrostDeposit` | refused |
| Legacy drain commitment into FROST | refused |
| Sweep proof of reserved deposits | continues (completes in-flight exposure) |
| Sweep proof with an unreserved deposit | refused |
| Drain proof of a reserved drain; drain release | continues |
| Redemptions, cancellations, timeouts, refunds | continue, except the refund of an intent whose approved resolution sweep includes an unreserved deposit (see above) |
| Fraud challenge, defense and timeout | continue |
| FROST to FROST movement, receiving sweeps, closure | continue |
| FROST wallet creation and readiness | continue: a wallet is not exposure (OPEN) |
| Legacy operation | unaffected |

## Creation modes

The modes are stored in Bridge storage, with `LegacyOpen` (0) as the
default, so an upgraded proxy starts open.

| Transition | Who | Guard |
| --- | --- | --- |
| `LegacyOpen` → `LegacyDraining`: `beginLegacyDkgDrain()` | governance | — |
| `LegacyDraining` → `LegacyOpen`: `abortLegacyDkgDrain(policyRecord)` | governance | a nonzero reviewed-policy record (OPEN) |
| `LegacyDraining` → `FrostOnly`: `completeFrostCutover(manifestHash)` | governance | nonzero manifest; the legacy DKG is `IDLE`; the legacy sortition pool is unlocked (implied by `IDLE` on the deployed registry, kept as defence in depth); a FROST registry is configured |
| any → anything, from `FrostOnly` | nobody | permanent |

**Legacy routes.**

- `Bridge.requestNewWallet` is refused unless `LegacyOpen`. This is the
  Bridge's only route to the legacy registry's `requestNewWallet`, which
  admits only its wallet owner.
- `__ecdsaWalletCreatedCallback` is refused in `FrostOnly`. In
  `LegacyDraining` it is accepted once, and only if a legacy DKG was in
  flight when the drain began (recorded by `beginLegacyDkgDrain`). A
  registry owner swap cannot register a DKG requested later. Residual: if
  that in-flight DKG times out, the one allowance stays open until a
  callback or the cutover.
- Every other legacy path is unchanged in every mode: heartbeat-failure
  callbacks, challenges, redemptions, moving funds, approvals and timeout
  reports.

Both checks sit in the `Wallets` library, so the Bridge bytecode is
unchanged. There is no scheme parameter on any request, so a caller cannot
choose a scheme to bypass the mode.

## Wiring and installation

- `installFrostExposureController(controller)`: governance only, once. The
  controller must have code and name this Bridge. There is no replacement or
  removal, because a new controller would reset the counters. Replacing it
  means a reviewed Bridge upgrade (C-11).
- `setFrostFundingGates(…, revealEnabled = true)` and
  `setFrostDrainEnabled(true)` need an installed controller. Deposits and
  drains therefore exist only with a controller, and the controller calls on
  the credit and drain paths fail closed. Closing a gate never needs the
  controller.
- New selectors are dispatched at the end of the chain, after C-09:
  - `installFrostExposureController`, `frostExposureController`;
  - `beginLegacyDkgDrain`, `abortLegacyDkgDrain`, `completeFrostCutover`,
    `frostCreationMode`, `frostCutoverManifest`;
  - `reserveFrostDeposit`, `frostDepositReserved`;
  - `setFrostDepositReservationMargin`, `frostDepositReservationMargin`.
- The C-10 Bridge storage takes two slots from the tail gap (11 becomes 9).

## Authority bypass map

| Authority | What it can do | Bounded by C-10? |
| --- | --- | --- |
| Proxy admin | upgrade the Bridge, and so skip every check | no: C-11 review and release |
| Bridge governance | choose the controller at its one install, and with it the controller's governance; bind the FROST registry; trust vaults (`setVaultStatus`); set SPV maintainers and the treasury; set the reservation margin; move the creation modes | no: the controller choice is once-only and visible, the rest is outside the fault model |
| Controller governance | open a period, which raises the ceilings; lift containment; set the guardian; hand governance on in two steps | recorded only: every top-up is a new period with a record |
| Guardian | contain | cannot lift or raise |
| Bank owner | change the Bank's bridge | no |
| SPV maintainer | submit proofs | yes: credits still pass the controller |
| Relay (difficulty source) | admit false proofs | yes, within the ceilings: this is the assumed fault. A false legacy proof can release a drain, but a release restores no allowance |
| Legacy registry governance (`updateWalletOwner`) | point the old registry at another owner and run DKG there | partly: such a wallet never registers in the Bridge. Host refusal after `FrostOnly` is K-11 (V-10). |
| TBTCVault optimistic minting | mint before a sweep | not reachable: FROST deposits never enter `Bridge.deposits` |
| TBTCVault governance and upgrades (the TBTC mint authority) | mint outside the Bridge | no: outside the fault model |
| RedemptionWatchtower | veto legacy redemptions | not an exposure power; it carries the inlined drain release |
| Rebate staking | adjust reveal economics | not reachable: FROST reveal requires no rebate staking |

## Verification

`test/bridge/Frost.CutoverExposure.test.ts`, through the real Bridge proxy
and public entrypoints.

**Cutover**

- `completeFrostCutover` in each of the four legacy DKG states (only `IDLE`
  passes), with the pool locked, without a FROST registry, from
  `LegacyOpen`, and twice.
- A legacy request is refused in `LegacyDraining` and in `FrostOnly`.
- A DKG that started before the drain completes during the drain.
- A callback after the cutover is refused.
- An abort is accepted only with a record and only from `LegacyDraining`,
  and there is no exit from `FrostOnly`.
- Legacy heartbeat, redemption and moving-funds routes still work after the
  cutover.

**Exposure**

- Every inflow and mint path:
  - a reserved deposit swept, through both the vault and plain-Bank paths;
  - an unreserved deposit swept;
  - a drain committed, proven and released;
  - FROST to FROST movement adds nothing;
  - an optimistic mint is unreachable.
- Ceilings, per counter and exactly at the boundary.
- A repeated drain completion is refused; a deposit sweep reported as
  reserved beyond the outstanding value is charged.
- A reservation inside the refund margin or past the locktime is refused,
  and a deposit is reserved once.
- A drain below dust and a legacy-shaped drain proof are refused; a conflict
  release before the main-replacing proof clears the commitment.
- Controller governance moves only in two steps.
- uint64 overflow is refused.
- Repeated loss and rotation do not replenish allowance; a top-up does. The
  loss case is a drain-committed source that times out under containment.

**Containment**

- A reveal, a reservation and a drain commitment are refused.
- In-flight reserved sweeps and drains complete.
- A FROST movement, a drain release and a fraud defense succeed during
  containment. In `Frost.SweepConflictResolution`, a FROST redemption request,
  reservation and payment proof, a cancellation proof and a request timeout
  all succeed under containment with every counter unchanged. Depositor
  refunds happen on Bitcoin alone.
- Races: a contain and a lift between a reserve and its completion.

**Fault demonstration**

- The assumed fault: the regtest relay admits proofs of fabricated funding
  and sweep transactions, so deposit validation credits deposits that never
  entered custody.
- The controller stops the credits at the issuance ceiling, and
  reservations of fabricated deposits stop at the custody ceiling.
- The Bank credit total equals `issued`.

**Negative controls.** `scripts/frost-c10-controls.py` reverts one guard per
control in a throwaway copy. Each control must make its named test fail at
its own assertion:

- the issuance ceiling;
- the custody ceiling;
- once-only completion;
- containment on reserve;
- containment on reveal;
- the credit statement's report;
- the drain reservation at commitment;
- the mode check on request;
- the mode check on callback;
- the IDLE guard;
- the pool-lock guard;
- the install-once guard;
- the drain gate's controller check;
- the funding gate's controller check;
- the drain release when a legacy deposit sweep replaces the committed main;
- the drain release when a legacy moved-funds sweep replaces it;
- the drain release when a legacy redemption proof replaces or deletes it;
- containment on deposit reservation;
- the outstanding cap on deposit coverage;
- the one-callback rule during the drain;
- the commitment clearing in every release;
- the drain-only proof of a drain-committed source;
- the drain dust floor;
- the once-only deposit reservation;
- the refund window on deposit reservation.

A stale control (its mutation no longer matches the source) is reported as
an error for that control; the others still run.

Two contained-fault controls inject an over-credit into the sweep's credit
accounting (an inflated depositor amount; an uncharged fee) and require the
test "keeps every Bank credit inside the controller's count" to pass: every
Bank credit is counted and within the ceiling, or the proof reverts. The
test's ceiling, 149,999, sits below both faults' credits, so each reaches
the refusal.

**Sizes and gas.** The Bridge stays at 24,258 bytes. Every library stays under
24,576 bytes; MovingFunds is the tightest, at 24,486 bytes (23,846 before).
Measured gas, against the 16,777,216 transaction cap. "Limit" is the
smallest gas limit that succeeds (`estimateGas`); it exceeds the gas used
because of the 63/64 rule in the vault's nested mint calls.

| Transaction | Gas used | Limit |
| --- | --- | --- |
| 128-deposit sweep, every deposit reserved | 6,968,396 | |
| 128-deposit vault sweep, no reservations (C-05 F5) | 12,757,036 | 13,464,265 |
| C-04 A3 joint maximum (64 refunds + 128 inputs + 100 signatures), Bank, all reserved | 12,182,109 | 12,843,319 |
| C-04 A3, Bank, none reserved | 14,336,247 | 15,070,485 |
| C-04 A3, vault, all reserved | 12,991,083 | 13,755,154 |
| C-04 A3, vault, none reserved | 15,145,077 | 16,015,482 |

A reserved deposit's sweep is cheaper because its reservation already wrote
the storage slot that the sweep's `sweptAt` shares. The host signs only
reserved sweeps; the unreserved rows are the worst case a contract-level
sweep can reach.

## keep-core obligations (same milestone)

- `test/frost/deploy.cjs` deploys and installs the controller and opens a
  budget period with test ceilings (OPEN) before it opens the funding and
  drain gates.
- The bindings are regenerated.
- Before it signs a sweep, the sweeper reserves every deposit the sweep
  includes, through the maintainer's chain seam, using the funding
  transaction's SPV proof. A reservation the chain already holds is reused.
  A deposit it cannot reserve is left out of the sweep. The maintainer
  reserves only a deposit the planner could sweep: its funding output
  unspent and its refund locktime outside the refund margin.
- The legacy moving-funds proposal and SPV maintainer resolve the latest
  commitment event, since a drain release lets a source commit again.
- The planner and the grant-time view require the reservation to be open at
  the head and to exist the reveal-finality depth earlier, so a shallow
  reorganization after broadcast cannot remove it.

## Not in C-10

- Host behaviour across the cutover (P-K11-CUTOVER-ONE-WAY) and containment
  (P-K11-CONTAINMENT-KEEPS-EXITS): K-11, modelled in V-10.
- The production upgrade bundle and addresses: C-11.
- D-10 values: the ceilings, response window, guardian and top-up policy.

## Readings for the owner (OPEN)

1. **Fault model.** The faulty component is FROST deposit validation. The
   controller and the single credit statement are trusted.
2. **Refunds keep their reservation.** A refunded deposit's custody and
   issuance stay counted, because the BTC was under FROST key control.
3. **Fees stay counted.** The unused issuance of a reservation (the sweep
   fee) stays counted, so the counters stay monotone and simple.
4. **No reservation at reveal.** Reservations need an SPV proof of funding,
   because unproven reveals could exhaust the budget.
5. **Containment scope.** Containment blocks reveals, deposit reservations
   and drain commitments, and nothing else. FROST to FROST movement is an
   exit path and continues.
6. **Abort policy.** An abort from `LegacyDraining` needs a nonzero record
   that names the reviewed policy. The contract does not interpret it.
7. **Guardian.** It may contain but never lift. Governance lifts with a
   record.
8. **Releases restore no allowance (decided 23 October 2026).** A drain
   release is recorded, but its custody stays counted, because its SPV proof
   could be fabricated under the relay fault. The cost: governance tops up
   after honest releases (a legacy sweep or redemption that replaces a
   drain-committed main) if the custody they held is needed again.
9. **Deposit reservation margin.** `frostDepositReservationMargin` is a
   governance value, at least the host's refund margin. It defaults to 0,
   which still refuses a reservation at or past the locktime; the contract
   tests use 3,600 s, the host fixture's margin.

## Review fixes (21 October 2026)

Fixes for the review of tbtc-v2 #14 and keep-core #20:

- **Credit binding (#14).** The treasury credit came from a separate
  accumulator that the report did not cover. `creditBank` now derives both
  Bank credits from the values it reports, with checked narrowing. A test
  under two injected accounting faults shows every credit counted or the
  proof reverted.
- **Drain after a main change (#14).** A legacy deposit sweep could grow a
  drain-committed main, so a larger drain would be signed and its proof
  refused after the BTC moved. The sweep proof now releases the drain and
  clears the commitment; the recommitment must reserve the full new value,
  refused with no capacity or under containment. Drains are keyed by source
  and committed main.
- **Drain after any main change (#14 re-check).** The first fix covered only
  deposit sweeps. A moved-funds sweep and a redemption proof (for example a
  timed-out redemption paid after the source committed a drain) also replace
  the committed main. All three proofs now release the drain before the main
  changes. Redemption inlines the release, so the upgradeable
  RedemptionWatchtower, which imports Redemption, still links no external
  library.
- **Reservation finality (#20).** The host accepted a reservation present
  only at the head. The planner and the grant now require it at the
  finalized depth as well.

## Adversarial review fixes (23 October 2026)

Fixes for the adversarial review of tbtc-v2 #14 and keep-core #20:

- **Conflict release first (P1).** `releaseDrain` now clears the commitment
  itself, so a conflict release that lands before the main-replacing proof
  leaves the source able to recommit. Before, the hash stayed, the source
  could neither recommit nor reset its timeout, and it would be terminated
  with its new main stranded.
- **Joint maximum through a vault (P1).** With every deposit reserved, the
  C-04 A3 sweep ran out of gas at the cap (gas limit needed 17,067,940).
  Deposits are now reserved and completed in aggregate (invariant 5). The
  reserved vault route now needs 13,755,131.
- **Legacy-shaped drain proof (P2).** A drain-committed source is proven only
  as a drain.
- **Drain below dust (P2).** Drain commitments need the dust threshold, so a
  below-dust closure cannot strand one.
- **Reservation of an unsweepable deposit (P2).** Refused inside the margin
  or past the locktime; the host checks spentness too.
- **Stale control (P2).** The control script's drain-reservation string, and
  a stale control no longer aborts the run.
- **Missing evidence (P2).** Vault-route sweep, exits under containment, a
  loss case.
- **P3s.** Two-step controller governance; one callback during the drain,
  only for an in-flight DKG; the `UnchargedFee` ceiling; the pinned FROST
  layout in `Frost.Identity`; this document's fault model, bypass map and
  sizes.

## Re-check fix (23 October 2026)

Astra's re-check of the adversarial-review fixes found no new P1 or P2, and
recommended closing reading 8. A drain release now restores no custody
allowance: `add` checks `custodyReserved <= custodyCeiling`, and
`remainingCustody` is `custodyCeiling - custodyReserved`. The tests show that
a released reservation still counts, and that only a top-up admits the
recommitted drain. New control: `ReleaseRestoresAllowance`.

