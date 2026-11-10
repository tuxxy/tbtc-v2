#!/usr/bin/env bash
# Remediation batch 17a controls (README.md here; tuxxy/tbtc-v2#17, #19).
# Applies each control to a SCRATCH checkout of the candidate head, runs the
# owning test file, records the log and reverts. Helper controls need no
# compile; the contract removal control is committed on the scratch tree's
# detached HEAD, compiled, and reset. A control is one patch or several joined
# by "+". Never point it at a working checkout: it commits and runs
# `git reset --hard` there.
#
# usage: run-controls.sh <scratch-solidity-dir> <log-dir> [control ...]
set -euo pipefail
scratch=$(cd "$1" && pwd)
logs=$(mkdir -p "$2" && cd "$2" && pwd)
shift 2
here=$(cd "$(dirname "$0")" && pwd)

controls=("$@")
if [ ${#controls[@]} -eq 0 ]; then
  controls=(
    b17a-17-fix-drop-override.patch
    b17a-17-fix-pin.patch
    b17a-17-wrong-tmp-only.patch
    b17a-17-wrong-record-only.patch
    b17a-19-fix-drop-root.patch
    b17a-19-fix-refuse-root.patch
    b17a-19-wrong-needs-baseline.patch
    b17a-19-wrong-record-root.patch
    b17a-17-fix-drop-override.patch+b17a-19-fix-drop-root.patch
    b17a-17-fix-pin.patch+b17a-19-fix-refuse-root.patch
    b17a-17-removal-input-guard.patch
  )
fi

cd "$scratch"
export USE_EXTERNAL_DEPLOY=true TEST_USE_STUBS_TBTC=true
test -z "$(git status --porcelain -- . ':!test/b17a/controls')" || { echo "scratch checkout is dirty" >&2; exit 1; }
start=$(git rev-parse HEAD)
for c in "${controls[@]}"; do
  name=${c//+/__}
  echo "== $c"
  IFS=+ read -r -a parts <<< "$c"
  for p in "${parts[@]}"; do
    git -C "$(git rev-parse --show-toplevel)" apply "$here/$p"
  done
  case "$c" in
    *removal-input-guard*)
      # The legacy origin fixture binds the compiled Bridge sources to HEAD
      # ("frozen runtime source"), so the contract control is committed on
      # the scratch tree's detached HEAD and reset afterwards.
      git commit -q -a -m "batch 17a control $c (scratch only)"
      npx hardhat compile --quiet > "$logs/$name.compile.log" 2>&1
      target=test/bridge/Frost.LegacyReconciliation.test.ts ;;
    *) target=test/b17a/B17a.UpgradeInputs.test.ts ;;
  esac
  npx hardhat test --no-compile "$target" > "$logs/$name.log" 2>&1 || true
  grep -E "^ +[0-9]+ (passing|failing|pending)|AssertionError" "$logs/$name.log" | cut -c1-240 || true
  git reset -q --hard "$start"
  case "$c" in
    *removal-input-guard*) npx hardhat compile --quiet > "$logs/restore.compile.log" 2>&1 ;;
  esac
done
