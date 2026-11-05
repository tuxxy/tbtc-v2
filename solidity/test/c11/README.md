# C-11a: FROST Bridge upgrade bundle tests

Refs tuxxy/tbtc-v2#58 (C-11a), #57 (FROST governance through BridgeGovernance), #56 (unlinked FrostBridge, deploy 85).
Brief and record: `K-09-restart/TESTS-C11.md`. Decisions: D1, D20, D21 (a), D22 (a).

## Run

```sh
cd solidity
test/c11/run.sh            # Frost.Upgrade + deploy test 85
```

`run.sh` sets `TMPDIR` to `solidity/.c11-tmp` (the 40a11d1d baseline builds write there), and `USE_EXTERNAL_DEPLOY=true TEST_USE_STUBS_TBTC=true` as `yarn test` does. Run the files together: the class-coverage case reads the witnesses of the three discharge cases in the same run. `C11_TIMING=1` prints each case's duration.

Fresh-worktree environment: symlink `solidity/node_modules` as the other tbtc-v2 worktrees do; nothing else. The baseline (`40a11d1d`) is read from git, so the checkout must contain that commit.

## The world

`test/helpers/c11-upgrade-world.ts` builds on the frozen K-09 world (`k09-registry-world.ts`, imported, not edited): the 40a11d1d Bank and Bridge behind a real proxy, the real ECDSA WalletRegistry. On the 40a11d1d Bridge it creates every legacy obligation class as `k09-legacy-ledger.ts` does (that fixture upgrades inside itself, so its pre-upgrade part is rebuilt here). Then it hands authority over as production has it:

- the Bridge proxy's ProxyAdmin is owned by a real `Timelock` (deploy 42, OpenZeppelin TimelockController) with a TEST delay of 3600 s (deploy 42: 86400 s); the council stand-in is its only proposer and executor;
- the Bridge's governance is a real 40a11d1d `BridgeGovernance` (compiled from git, `BridgeGovernanceParameters` linked, 172800 s delay), installed with the Bridge's own `transferGovernance` (deploy 21) and owned by the council stand-in (deploy 22);
- the watchtower, RebateStaking and Bank are owned by the council stand-in; signer 0 (the historical deployer) keeps no role.

## Builder interface (the implementer writes it; production code)

File `deploy/87_deploy_frost_bridge_upgrade.ts`, shaped like script 85 (exported functions plus a tagged deploy function).

```ts
export default func // tags include "DeployFrostBridgeUpgrade"; skip() is true unless DEPLOY_FROST_UPGRADE === "true"

export async function deployFrostBridgeUpgrade(
  hre: HardhatRuntimeEnvironment,
  inputs: {
    bridge: string             // Bridge proxy
    proxyAdmin: string         // its ProxyAdmin (owned by the Timelock)
    timelock: string           // TimelockController
    bridgeGovernance: string   // the current BridgeGovernance (the Bridge's governance)
    council: string            // Council Safe: Timelock proposer/executor, BridgeGovernance owner
    exposureGovernance: string // governance of the new FrostExposureController (D-10 OPEN; tests pass the council)
  }
): Promise<{
  bridgeImplementation: string          // this checkout's Bridge, every library linked
  libraries: Record<string, string>     // every library in the link graph (Bridge's and the libraries' own), by name
  bridgeGovernance: string              // the new BridgeGovernance version (D22), owned by the council when this returns
  bridgeGovernanceParameters: string
  verifier: string                      // FrostVerifier; deployed, not installed
  exposureController: string            // FrostExposureController(bridge, exposureGovernance); deployed, not installed
  rollbackImplementation: string        // the implementation the proxy ran before the bundle
  steps: Step[]                         // what the council runs, in order
}>

type Step =
  | { kind: "timelock"; actions: { target; value; data }[]; predecessor; salt; description } // scheduleBatch, wait getMinDelay(), executeBatch, by the council
  | { kind: "council"; to; value; data; description }                                          // a Council Safe call
  | { kind: "wait"; seconds; description }                                                     // e.g. the BridgeGovernance delay
```

The deploy phase runs from the named `deployer`. The deployer holds no role afterwards. The D22 forwarders are on `BridgeGovernance` (this checkout), one per governance-guarded FROST entrypoint, with the Bridge function's name and types, `onlyOwner` and immediate.

## Cases (`Frost.Upgrade.test.ts`)

| Property | Case(s) | Fails now at |
| --- | --- | --- |
| interface | `[C-11 interface]` | `C-11 bundle builder present` |
| 5 derivation (#57) | `[#57, D22]` | `no BridgeGovernance route for abortLegacyDkgDrain(bytes32)` |
| 1 authority route | `[1 authority] ... only through Timelock -> ProxyAdmin ...` | `C-11 bundle builder present` |
| 2 window | `[2 window]` | same |
| 2 initializer | `[2 initialization]` | same |
| 1 after the bundle | `[1 authority] after the bundle ...` | same |
| 3 frame | `[3 legacy] the whole frame ...` | same |
| 3 discharges | three `[3 legacy] ... discharged after the bundle` cases, plus `every legacy obligation class` | same |
| 4 G-D | `[4 G-D]` | same |
| 5 per entrypoint | 13 `[5 #57] <fn>` cases | same |
| 5 runbook | `[5 runbook]` (two cases), `[5 emergency]` | same |
| 6 bytecode | `[6 bytecode, #56]` | same |
| 7 verifier | `[7 verifier]` | same |
| 8 rollback | `[8 rollback]` | same |

## Controls (`controls/`)

`controls/run-controls.sh <control>|all`. A control passes when its target case fails at the named assertion listed in the script. All need the implementation. `.wrong.ts` files are builder variants (run through `C11_BUILDER`); `edit.py` weakens one guard in the source and the script restores it from a backup.

| Control | Weakens | Expected failure |
| --- | --- | --- |
| `c11-1-deployer-owns-governance.wrong.ts` | deployer keeps the new BridgeGovernance | `BridgeGovernance owner is the council` |
| `c11-1-admin-to-council.wrong.ts` | upgrade outside the Timelock | `a council step targets the ProxyAdmin` |
| `c11-2-governance-to-deployer.wrong.ts` | Bridge governance to the deployer EOA | `deployer abortLegacyDkgDrain on the Bridge` |
| `c11-2-window-guard` (edit) | FrostExposure governance check removed | `derivation on the bundle's implementation` |
| `c11-4-begins-drain.wrong.ts` | bundle begins the legacy DKG drain | `G-D: creation mode LegacyOpen` |
| `c11-4-requests-on.wrong.ts` | bundle turns FROST wallet requests on | `G-D: FROST wallet requests off` |
| `c11-5-forwarder-unguarded` (edit) | `onlyOwner` dropped from one forwarder | `setFrostFundingGates: the outsider through BridgeGovernance: not refused` |
| `c11-5-forwarder-missing` (edit) | one forwarder deleted | `no BridgeGovernance route for abortLegacyDkgDrain(bytes32)` |
| `c11-6-frostbridge-no-code.wrong.ts` | FrostBridge reported at a codeless address | `linked library has code: FrostBridge` |
| `c11-6-unreported-frostbridge.wrong.ts` | FrostBridge link unaccounted | `bundle reports the address of library FrostBridge` |
| `c11-7-wrong-verifier.wrong.ts` | verifier not the FrostVerifier artifact | `bundle verifier is the FrostVerifier artifact` |
| `c11-7-no-codehash-check` (edit) | install accepts any code hash | `mismatched verifier code hash refused (hash of other code): not refused` |
| `c11-8-wrong-rollback.wrong.ts` | wrong rollback target | `rollback target is the pre-bundle implementation` |

Not controlled: the 24,576-byte size bound (no builder variant can change code size); the reinitializer branch of `[2 initialization]` (only runs if the implementation adds a reinitializer).
