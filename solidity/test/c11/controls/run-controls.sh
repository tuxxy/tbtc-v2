#!/usr/bin/env bash
# C-11 removal controls (tuxxy/tbtc-v2#58, #57, #56).
#
# Usage: test/c11/controls/run-controls.sh <control>|all   (from solidity/)
#
# Every control needs the implementation: deploy/87_deploy_frost_bridge_upgrade.ts
# and the D22 BridgeGovernance forwarders. A control PASSES when its target
# case FAILS at the expected named assertion. `.wrong.ts` controls swap the
# builder (C11_BUILDER); edit controls weaken one guard in the source through
# edit.py, run, and restore the file from a backup (never from git).
# One control per invocation stays under 900 s (world build about 55 s).
set -euo pipefail
cd "$(dirname "$0")/../../.."
mkdir -p .c11-tmp
mkdir -p .c11-tmp/controls
export TMPDIR="$PWD/.c11-tmp/controls"
export USE_EXTERNAL_DEPLOY=true TEST_USE_STUBS_TBTC=true
A=test/c11/Frost.Upgrade.test.ts
B=test/c11/Frost.Upgrade.Governance.test.ts
DIR=test/c11/controls

# name -> kind|test file|case grep|expected named assertion
spec() {
  case "$1" in
  c11-1-deployer-owns-governance) echo "builder|$A|after the bundle the deployer and an outsider|BridgeGovernance owner is the council" ;;
  c11-1-admin-to-council) echo "builder|$A|the implementation changes only through Timelock|a council step targets the ProxyAdmin" ;;
  c11-4-begins-drain) echo "builder|$A|4 G-D|G-D: creation mode LegacyOpen" ;;
  c11-4-requests-on) echo "builder|$A|4 G-D|G-D: FROST wallet requests off" ;;
  c11-6-frostbridge-no-code) echo "builder|$A|6 bytecode|linked library has code: FrostBridge" ;;
  c11-6-unreported-frostbridge) echo "builder|$A|6 bytecode|bundle reports the address of library FrostBridge" ;;
  c11-7-wrong-verifier) echo "builder|$A|7 verifier|bundle verifier is the FrostVerifier artifact" ;;
  c11-8-wrong-rollback) echo "builder|$A|8 rollback|rollback target is the pre-bundle implementation" ;;
  c11-5-forwarder-unguarded) echo "edit|$B|setFrostFundingGates: the council|setFrostFundingGates: the outsider through BridgeGovernance: not refused" ;;
  c11-5-forwarder-missing) echo "edit|$A|same-named BridgeGovernance forwarder|no BridgeGovernance route for abortLegacyDkgDrain(bytes32)" ;;
  c11-7-no-codehash-check) echo "edit|$A|7 verifier|mismatched verifier code hash refused (hash of other code): not refused" ;;
  c11-2-window-guard) echo "edit|$A|2 window|derivation on the bundle's implementation" ;;
  c11-2-governance-to-deployer) echo "builder|$A|2 window|deployer abortLegacyDkgDrain on the Bridge" ;;
  c11-3-trust-vault) echo "builder|$A|side effects|bundle steps emit only the named events" ;;
  c11-1-timelock-weaken) echo "builder|$A|side effects|bundle steps emit only the named events" ;;
  c11-1-short-governance-delay) echo "builder|$A|side effects|new BridgeGovernance governance delay equals the old one's" ;;
  *) return 1 ;;
  esac
}
ALL="c11-1-deployer-owns-governance c11-1-admin-to-council c11-4-begins-drain c11-4-requests-on c11-6-frostbridge-no-code c11-6-unreported-frostbridge c11-7-wrong-verifier c11-8-wrong-rollback c11-5-forwarder-unguarded c11-5-forwarder-missing c11-7-no-codehash-check c11-2-window-guard c11-2-governance-to-deployer c11-3-trust-vault c11-1-timelock-weaken c11-1-short-governance-delay"

one() {
  local name="$1" kind grep expected log
  IFS='|' read -r kind file grep expected <<<"$(spec "$name")"
  log=".c11-tmp/control-$name.log"
  if [ "$kind" = builder ]; then
    C11_BUILDER="$DIR/$name.wrong.ts" npx hardhat test "$file" --grep "$grep" >"$log" 2>&1 || true
  else
    local source
    source=$(python3 "$DIR/edit.py" "$name" --path)
    cp "$source" ".c11-tmp/control-backup.sol"
    trap 'cp ".c11-tmp/control-backup.sol" "'"$source"'"' EXIT
    python3 "$DIR/edit.py" "$name"
    npx hardhat test "$file" --grep "$grep" >"$log" 2>&1 || true
    cp ".c11-tmp/control-backup.sol" "$source"
    trap - EXIT
  fi
  if grep -q " failing" "$log" && grep -qF -- "$expected" "$log"; then
    echo "PASS $name: fails at \"$expected\""
  else
    echo "FAIL $name: expected a failure at \"$expected\" (log $log)"
    return 1
  fi
}

if [ "${1:-}" = all ]; then
  status=0
  for name in $ALL; do one "$name" || status=1; done
  exit $status
fi
spec "${1:-}" >/dev/null || { echo "usage: $0 <control>|all ($ALL)"; exit 2; }
one "$1"
