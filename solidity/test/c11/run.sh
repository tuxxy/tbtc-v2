#!/usr/bin/env bash
# C-11a acceptance run (tuxxy/tbtc-v2#58, #57, #56), from solidity/.
# Compiles once, then runs two hardhat processes in parallel, each with its
# own TMPDIR (the 40a11d1d baseline builds write there) and each under 2 min:
#   A: test/c11/Frost.Upgrade.test.ts
#   B: test/c11/Frost.Upgrade.Governance.test.ts and deploy test 85.
# Logs: .c11-tmp/run-A.log and .c11-tmp/run-B.log. Extra arguments go to both.
set -uo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .c11-tmp/A .c11-tmp/B
export USE_EXTERNAL_DEPLOY=true TEST_USE_STUBS_TBTC=true
npx hardhat compile >.c11-tmp/run-compile.log 2>&1 || {
  cat .c11-tmp/run-compile.log
  exit 1
}
start=$(date +%s)
TMPDIR="$PWD/.c11-tmp/A" npx hardhat test --no-compile \
  test/c11/Frost.Upgrade.test.ts "$@" >.c11-tmp/run-A.log 2>&1 &
a=$!
TMPDIR="$PWD/.c11-tmp/B" npx hardhat test --no-compile \
  test/c11/Frost.Upgrade.Governance.test.ts \
  test/deploy/85_deploy_tip109_governance_upgrade.test.ts "$@" >.c11-tmp/run-B.log 2>&1 &
b=$!
wait $a
sa=$?
echo "A wall $(($(date +%s) - start)) s" >>.c11-tmp/run-A.log
wait $b
sb=$?
echo "B wall $(($(date +%s) - start)) s" >>.c11-tmp/run-B.log
for x in A B; do
  echo "== $x"
  grep -E "^  [0-9]+ (passing|failing|pending)|^[AB] wall" ".c11-tmp/run-$x.log"
done
[ $sa -eq 0 ] && [ $sb -eq 0 ]
