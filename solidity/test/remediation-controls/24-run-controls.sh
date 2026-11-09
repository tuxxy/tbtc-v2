#!/usr/bin/env bash
# tuxxy/tbtc-v2#24 controls (D13 refinement). Local only; nothing here runs in
# CI. Applies one control patch to a scratch checkout of this branch, compiles
# and runs the #24 tests there. Never applies a patch in this tree.
#
# Usage:
#   24-run-controls.sh <scratch tbtc-v2 checkout> <evidence dir> <patch> [test files...]
#
# The scratch checkout is a separate worktree of this repository (its
# solidity/node_modules provisioned like this one). It is reset to this
# branch's HEAD, the patch is applied and committed on a detached HEAD (some
# fixtures refuse a dirty runtime source), and the contracts are recompiled.
# Default test files: every #24 test (Frost.SingleMain and the amended
# MainRequired, PublicVaultCallback, SweepConflictResolution and
# ExposureReset). Writes <evidence dir>/<patch name>.log and a summary line.
set -euo pipefail
scratch=${1:?scratch checkout required}
evidence=${2:?evidence directory required}
patch=${3:?patch required}
shift 3
here=$(cd "$(dirname "$0")/../../.." && pwd)
patch=$(cd "$(dirname "$patch")" && pwd)/$(basename "$patch")
mkdir -p "$evidence"
evidence=$(cd "$evidence" && pwd)
name=$(basename "$patch" .patch)
files=("$@")
if [ ${#files[@]} -eq 0 ]; then
	files=(test/bridge/Frost.SingleMain.test.ts
		test/bridge/Frost.DepositSweep.MainRequired.test.ts
		test/bridge/Frost.PublicVaultCallback.test.ts
		test/bridge/Frost.SweepConflictResolution.test.ts
		test/bridge/Frost.SweepConflictResolution.ExposureReset.test.ts)
fi
[ "$(git -C "$scratch" rev-parse --path-format=absolute --git-common-dir)" = \
	"$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)" ] ||
	{ echo "scratch checkout is not a worktree of this repository" >&2; exit 2; }
[ "$(cd "$scratch" && pwd)" != "$here" ] || { echo "refusing to patch this tree" >&2; exit 2; }
head=$(git -C "$here" rev-parse HEAD)
git -C "$scratch" reset -q --hard
git -C "$scratch" checkout -q --detach "$head"
git -C "$scratch" apply "$patch"
git -C "$scratch" -c user.name=control -c user.email=control@localhost \
	commit -q -am "CONTROL $name (scratch, never pushed)"
cd "$scratch/solidity"
npx hardhat compile > "$evidence/$name.compile.log" 2>&1
start=$(date +%s)
status=0
USE_EXTERNAL_DEPLOY=true TEST_USE_STUBS_TBTC=true \
	npx hardhat test --no-compile "${files[@]}" > "$evidence/$name.log" 2>&1 || status=$?
wall=$(( $(date +%s) - start ))
counts=$(grep -E '^\s+[0-9]+ (passing|failing|pending)' "$evidence/$name.log" | tr -s ' ' | tr '\n' ' ' || true)
failures=$(sed 's/\x1b\[[0-9;]*m//g' "$evidence/$name.log" | grep -E '^\s+(AssertionError|Error): ' |
	sed 's/^ *//' | cut -c1-200 | sort | uniq -c | sed 's/^ *//' | tr '\n' '|' || true)
printf '%s\texit=%s\twall=%ss\t%s\t%s\n' "$name" "$status" "$wall" "$counts" "$failures" | tee -a "$evidence/controls.tsv"
