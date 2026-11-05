#!/usr/bin/env bash
# C-11a acceptance run (tuxxy/tbtc-v2#58, #57, #56): Frost.Upgrade and
# deploy test 85, from solidity/. Temporary builds go to solidity/.c11-tmp.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .c11-tmp
export TMPDIR="$PWD/.c11-tmp"
export USE_EXTERNAL_DEPLOY=true TEST_USE_STUBS_TBTC=true
npx hardhat test test/c11/Frost.Upgrade.test.ts test/deploy/85_deploy_tip109_governance_upgrade.test.ts "$@"
