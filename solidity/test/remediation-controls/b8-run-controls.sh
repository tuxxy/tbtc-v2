#!/usr/bin/env bash
# Remediation batch 8 controls (README-batch8.md). Applies each control to a
# SCRATCH checkout of the candidate head, compiles, runs test/b8, records the
# log and reverts. A control is one patch or several joined by "+" (applied
# in order, e.g. a wrong patch on top of a fix). Never point it at a working
# checkout: it runs `git checkout -- .` there.
#
# usage: b8-run-controls.sh <scratch-solidity-dir> <log-dir> [control ...]
set -euo pipefail
scratch=$(cd "$1" && pwd)
logs=$(mkdir -p "$2" && cd "$2" && pwd)
shift 2
here=$(cd "$(dirname "$0")" && pwd)

controls=("$@")
if [ ${#controls[@]} -eq 0 ]; then
  fixes="b8-c1-cap-128.fix.patch+b8-c2-commit-ignores-inbound.fix.patch+b8-r-docs.fix.patch"
  controls=(
    "$fixes"
    b8-c1-cap-129.wrong.patch
    b8-c1-frost-route-only.wrong.patch
    b8-c2-closure-ignores-inbound.wrong.patch
    b8-r-no-refusal.wrong.patch
    b8-r-legacy-rebate-off-with-frost.wrong.patch
  )
fi

cd "$scratch"
export USE_EXTERNAL_DEPLOY=true TEST_USE_STUBS_TBTC=true
test -d build || npx hardhat compile --quiet > "$logs/base.compile.log" 2>&1
test -z "$(git status --porcelain -- .)" || { echo "scratch checkout is dirty" >&2; exit 1; }
for c in "${controls[@]}"; do
  name=${c//+/__}
  echo "== $c"
  IFS=+ read -r -a parts <<< "$c"
  for p in "${parts[@]}"; do
    git -C "$(git rev-parse --show-toplevel)" apply "$here/$p"
  done
  npx hardhat compile --quiet > "$logs/$name.compile.log" 2>&1
  npx hardhat test --no-compile test/b8/*.test.ts > "$logs/$name.log" 2>&1 || true
  grep -E "^ +[0-9]+ (passing|failing|pending)|AssertionError" "$logs/$name.log" | cut -c1-240 || true
  git checkout -- .
done
# Leave the scratch build at the head again.
npx hardhat compile --quiet > "$logs/restore.compile.log" 2>&1
