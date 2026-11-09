#!/usr/bin/env bash
# Remediation batch 14 controls (README-batch14.md, tuxxy/tbtc-v2#63).
# Applies each control to a SCRATCH checkout of the candidate head, compiles,
# runs test/b14, records the log and reverts. A control is one patch or several
# joined by "+" (applied in order, e.g. a wrong patch on top of the fix).
# Never point it at a working checkout: it runs `git checkout -- .` there.
#
# usage: b14-run-controls.sh <scratch-solidity-dir> <log-dir> [control ...]
set -euo pipefail
scratch=$(cd "$1" && pwd)
logs=$(mkdir -p "$2" && cd "$2" && pwd)
shift 2
here=$(cd "$(dirname "$0")" && pwd)

controls=("$@")
if [ ${#controls[@]} -eq 0 ]; then
  controls=(
    b14-shared-helper.fix.patch
    b14-view-no-capability.wrong.patch
    b14-view-inline-copy.wrong.patch
    b14-admission-live-only.wrong.patch
    b14-shared-helper.fix.patch+b14-storage-field.wrong.patch
    b14-review-r1-linked-helper.fix.patch
    b14-review-r2-admission-helper.fix.patch
    b14-review-r3-private-wrapper.fix.patch
    b14-review-w1-view-deadline.wrong.patch
  )
fi

cd "$scratch"
export USE_EXTERNAL_DEPLOY=true TEST_USE_STUBS_TBTC=true
test -z "$(git status --porcelain -- .)" || { echo "scratch checkout is dirty" >&2; exit 1; }
for c in "${controls[@]}"; do
  name=${c//+/__}
  echo "== $c"
  IFS=+ read -r -a parts <<< "$c"
  for p in "${parts[@]}"; do
    git -C "$(git rev-parse --show-toplevel)" apply "$here/$p"
  done
  npx hardhat compile --quiet > "$logs/$name.compile.log" 2>&1
  npx hardhat test --no-compile test/b14/*.test.ts > "$logs/$name.log" 2>&1 || true
  grep -E "^ +[0-9]+ (passing|failing|pending)|AssertionError" "$logs/$name.log" | cut -c1-240 || true
  git checkout -- .
  git clean -fdq -- contracts
done
# Leave the scratch build at the head again.
npx hardhat compile --quiet > "$logs/restore.compile.log" 2>&1
