# Batch 14 controls (tuxxy/tbtc-v2#63, F-1)

Run on a scratch checkout of the candidate head, never a working checkout:

```
test/remediation-controls/b14-run-controls.sh <scratch>/solidity <log-dir> [control ...]
```

| Control | Kind | Expected result |
| --- | --- | --- |
| `b14-shared-helper.fix.patch` | fixture fix: the view and `validateTerms` both call `FrostWallets.isMovementTarget` | 60/60 pass |
| `b14-view-no-capability.wrong.patch` | inline view `(ReadyUnfunded or Live) and not quarantined`, no `capabilityVersion` | fails at `F-1: isFrostFundingTarget disagrees ...` for ReadyUnfunded and Live with `capabilityVersion=0`, and at `F-1 shared helper` |
| `b14-view-inline-copy.wrong.patch` | inline view copy of the full wallet-level rule (agrees, not shared) | fails only at `F-1 shared helper: the isFrostFundingTarget branch ... compares wallet states inline` |
| `b14-admission-live-only.wrong.patch` | shared helper that narrows admission to Live | fails at `F-1 admission rule: frostDepositOutput answered false for state=ReadyUnfunded ...` (and Live with `capabilityVersion=0` answered true) |
| `b14-shared-helper.fix.patch+b14-storage-field.wrong.patch` | the fix plus a new `Wallet` field | fails only at `F-1 constraint: the Bridge storage layout differs from 39412825` |

The fixture fix is one correct shape, not the required one: any FROST library
helper called by both the view's dispatch branch and `validateTerms` passes.
