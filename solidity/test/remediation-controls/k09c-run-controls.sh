#!/usr/bin/env bash
# K-09 contract-only controls (README-k09c.md). Applies each patch to a
# SCRATCH checkout of the candidate head, compiles, runs the named test
# files, records the log and reverts. Never point it at a working checkout:
# it runs `git checkout -- .` there.
#
# usage: k09c-run-controls.sh <scratch-solidity-dir> <log-dir> [patch ...]
set -euo pipefail
scratch=$(cd "$1" && pwd)
logs=$(mkdir -p "$2" && cd "$2" && pwd)
shift 2
here=$(cd "$(dirname "$0")" && pwd)

files_for() {
  case "$1" in
    k09c-5-no-idle-check.patch | k09c-5-no-dkg-guards.patch)
      echo test/k09/K09.RegistryCutover.test.ts ;;
    k09c-12-no-admission-gate.patch | k09c-11-no-closure-obligations.patch)
      echo test/k09/K09.CutoverInvariants.test.ts ;;
    k09c-12-no-reserve-gate.patch | k09c-4-contained-blocks-legacy-sweep.wrong.patch | k09c-ledger-*.patch)
      echo test/k09/K09.LegacyObligations.test.ts ;;
    *)
      echo test/k09/K09.RegistryCutover.test.ts test/k09/K09.LegacyObligations.test.ts test/k09/K09.CutoverInvariants.test.ts ;;
  esac
}

patches=("$@")
if [ ${#patches[@]} -eq 0 ]; then
  patches=()
  for p in "$here"/k09c-*.patch; do patches+=("$(basename "$p")"); done
fi

cd "$scratch"
export USE_EXTERNAL_DEPLOY=true TEST_USE_STUBS_TBTC=true
test -d build || npx hardhat compile --quiet > "$logs/base.compile.log" 2>&1
test -z "$(git status --porcelain -- .)" || { echo "scratch checkout is dirty" >&2; exit 1; }
for p in "${patches[@]}"; do
  echo "== $p"
  git -C "$(git rev-parse --show-toplevel)" apply "$here/$p"
  if git diff --name-only -- contracts | grep -q .; then
    npx hardhat compile --quiet > "$logs/$p.compile.log" 2>&1
  fi
  # shellcheck disable=SC2046
  npx hardhat test --no-compile $(files_for "$p") > "$logs/$p.log" 2>&1 || true
  grep -E "^ +[0-9]+ (passing|failing|pending)|AssertionError" "$logs/$p.log" | cut -c1-240 || true
  git checkout -- .
done
# Leave the scratch build matching its head.
npx hardhat compile --quiet > "$logs/restore.compile.log" 2>&1
