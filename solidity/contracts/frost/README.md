# Inactive K-03 Bridge support

This extension installs immutable FROST identity, registers a pending wallet,
accepts a readiness callback and closes an expired pending wallet unfunded.
It contains no transition to Live, no deposit route and no active-wallet switch.
Both the Bridge request flag and the separate registry request flag start off.

The matching keep-core K-03 branch provides the independent registry, validator,
admission adapter, pool integration and node executor. Its `test/frost` harness
uses these actual contracts with real worker processes and authenticated libp2p.
The local policy is N=3/t=2/r=2; it does not set a production policy.

## ABI and storage

Attach `IFrostBridge` to the existing Bridge proxy for the new methods. The
Bridge's original selectors keep their implementations. Its fallback calls the
fixed, linked `FrostBridge` library, which recognizes only the selectors declared
by this interface. There is no arbitrary delegate target. This keeps the Bridge
below EIP-170 without an unlimited-size network setting. `FrostBridge` calls the
fixed `FrostWallets` library; both require review as part of an upgrade.

`BridgeState.Storage` consumes four slots from its tail gap (48 becomes 44):
registry and request flag, wallet mapping, Q mapping, and registry/ID mapping.
FROST state and counters do not reinterpret legacy wallet state. The full public
descriptor is stored with its ID, hash, fixed deadline, lifecycle and capability
metadata. The label is the first 20 bytes of the domain-separated full wallet ID;
zero or occupied labels reject. Expiry retains both identity and Q mappings.

Registration authenticates the configured registry and its chain domain. It
accepts only scheme 2, profile 1 and a canonical liftable secp256k1 x coordinate.
`FrostTypes` and `FrostCurve` must match the copies in keep-core's FROST contracts.
The descriptor tuple and domains are specified in keep-core's
`pkg/frost/dkg/README.md` and tested across the contract and Go boundaries.

The legacy callback remains scheme 1. New ECDSA registrations must have both
coordinates in range and satisfy the curve equation. Existing wallet identities
are not rehashed. Existing keys used by outstanding obligations still need the
specification's census before the affected production gate.

The output resolver recognizes only raw `0x5120 || Q` or the existing
length-prefixed `0x225120 || Q` form. A known Q resolves its identity even after
unfunded expiry; that does not confer funding eligibility. No FROST record enters
the legacy live-wallet mapping. The explicit funding-target view returns false
for pending, ReadyUnfunded and Closed records.

## Authority and deadline

Governance may configure the registry once and control new FROST requests.
Configuration verifies code exists and `walletOwner()` is this Bridge proxy.
The registry alone may call created/ready/expired. A ready callback must match
the descriptor hash, generation 1 and capability version 1. It succeeds only
before the fixed deadline. Expiry succeeds at or after that deadline and only
from pending. Neither callback changes legacy counters or active selection.

The fresh deployment script links the new libraries but does not configure or
enable the extension. The existing local rebate fixture also supplies those
links. Historical production upgrade scripts are not a K-03 deployment plan;
C-11 must prepare and review the exact implementation and library addresses.

## Verification and limits

`Frost.Identity.test.ts` uses actual linked contracts and a transparent proxy
with EIP-170 enabled. It checks authority, identity/Q tombstones, canonical
encodings, domain rejection, exact output scripts, and separation from a real
legacy registration. It also compiles baseline
`40a11d1dcdcf82d3962e430067cfe3f97be81483`, populates a legacy wallet, upgrades
that proxy and compares old storage layouts, raw slots, wallet data and getters.

The ordinary `Bridge.Wallets.test.ts` regression still uses the repository's
legacy stub fixture. It is separate from the actual-contract K-03 test. Use
keep-core's `test/frost/run-local.sh` for the combined verification procedure.

This is local inactive support. It does not close the C-07 curve-primitive
qualification or approve a production group, readiness policy, memory budget,
fence, activation, upgrade or funding gate. A later capability implementation
must explicitly define the controlled Live transition and its release checks.

The 7 October review update adds correctly isolated invalid-point rejection,
cross-scheme label collision controls in both directions, and duplicate-Q
checks across fresh epochs and after expiry. The collision fixtures use the
compiler storage layout to force an occupied state at a chosen label, exercise
the real callback, then remove that state for a positive control. They do not
claim a practical hash collision. Production contract source is unchanged.
