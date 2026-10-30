#!/usr/bin/env bash
# Controls for the D1 baseline check of test/portability/evaluate.cjs (#28,
# owner decision D1 = tbtc-v2 main 40a11d1d). Each control builds a fake
# fresh root holding a copy of a real Hardhat build and a
# public-legacy-origin.json shaped like the one Frost.LegacyReconciliation
# writes, then runs the checker.
#
# Usage: 28-d1-checker-controls.sh <repo with 40a11d1d> <40a11d1d build> <other build> <work dir>
#   builds: the solidity/build directory of a test/legacy/build-baseline.sh
#   output (keep-core), for example baseline-40a11d1d/solidity/build and
#   upgraded-2377d060/solidity/build.
set -euo pipefail
repo=${1:?repo} d1build=${2:?40a11d1d build} other=${3:?other build} work=${4:?work dir}
here=$(cd "$(dirname "$0")/../portability" && pwd -P)
D1=40a11d1dcdcf82d3962e430067cfe3f97be81483
mkdir -p "$work"
work=$(cd "$work" && pwd -P)
git init -q --bare "$work/d1.git"
git -C "$work/d1.git" fetch -q --depth=1 "$repo" "$D1"

# origin <root> <build copied in> <build whose sources give the hashes>
origin() {
  mkdir -p "$1/evidence"
  cp -c -R "$2" "$1/build"
  node -e '
const fs = require("fs"), path = require("path"), crypto = require("crypto")
const [root, hashesFrom] = process.argv.slice(1)
const art = path.join(hashesFrom, "contracts/bridge/Bridge.sol/Bridge.json")
const dbg = JSON.parse(fs.readFileSync(art.replace(/\.json$/, ".dbg.json"), "utf8"))
const info = JSON.parse(fs.readFileSync(path.resolve(path.dirname(art), dbg.buildInfo), "utf8"))
const baselineSourceHashes = Object.entries(info.input.sources).filter(([n]) => n.startsWith("contracts/"))
  .map(([n, s]) => ({ path: n, sha256: crypto.createHash("sha256").update(Buffer.from(s.content)).digest("hex") }))
fs.writeFileSync(path.join(root, "evidence/public-legacy-origin.json"),
  JSON.stringify({ baselineBuild: path.join(root, "build"), baselineSourceHashes }, null, 2))' "$1" "$3"
}
check() { # check <name> <expect ok|fail>
  node "$here/evaluate.cjs" d1 "$work/$1" 0 "$work/d1.git" "$D1" "$work/$1.json"
  local ok
  ok=$(node -e 'const r = require(process.argv[1]); console.log(r.ok ? "ok" : "fail: " + r.problems[0])' "$work/$1.json")
  echo "$1 (expect $2): $ok"
}

origin "$work/d1-build" "$d1build" "$d1build"
check d1-build ok
origin "$work/wrong-build" "$other" "$other"
check wrong-build fail
origin "$work/hashes-from-other-build" "$d1build" "$other"
check hashes-from-other-build fail
mkdir -p "$work/no-origin"
check no-origin fail
