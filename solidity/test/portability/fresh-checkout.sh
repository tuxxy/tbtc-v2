#!/usr/bin/env bash
# Refs tuxxy/tbtc-v2#27, #28, #29, #30, #31.
#
# Invariant: the default Solidity suite (`yarn test`, the contracts workflow's
# "Run tests" step) runs from a fresh CI-shaped checkout of the candidate
# commit, with only what the repository and its workflow provision:
#   - a fetch of the candidate commit at the depth its workflow's
#     actions/checkout@v4 step asks for (default 1, as on CI);
#   - dependencies installed from the candidate's own yarn.lock;
#   - the workflow's own steps between "Install dependencies" and "Run tests",
#     run as written (network allowed, as on a CI runner);
#   - an empty HOME, TMPDIR, Go module cache and Go build cache;
#   - a macOS sandbox-exec profile that denies reading, executing and writing
#     files by default. Readable: the fresh root, the linked node_modules, the
#     node/git/go toolchains and the system directories. Writable: the fresh
#     root. Everything else on this machine (the workspace, the real home,
#     /private/tmp) is refused, so no artifact left by an earlier local session
#     can be used. Nothing in /private/tmp is read, moved or deleted.
#
# This is local component evidence on macOS. It does not reproduce the Ubuntu
# CI runner: the workflow adapter runs `run:` steps only and ignores `uses`,
# `if` and step `env`.
#
# Usage: fresh-checkout.sh "<case>..." <evidence dir>
#   case: 27 | 28 | 29 | 30 | 31 | all, or "suite" for all six
# Each issue case fails at its own named point. To get there it supplies the
# other issues' prerequisites, each labelled PROVIDED in the manifest:
#   27  Frost.Identity in a shallow checkout. Nothing provided.
#   30  Frost.Identity with full history (PROVIDED, stands in for #27).
#   29  the Go oracle and a frost-digest consumer. Nothing provided.
#   31  every default-suite file that reaches Bitcoin Core. PROVIDED: a Go
#       module cache populated from the committed go.mod/go.sum (#29).
#   28  Frost.LegacyReconciliation. PROVIDED: the Go module cache (#29) and
#       read access to /private/tmp/k04-tools only, the hard-coded Core (#31).
#       Its legacy baseline must also be D1, tbtc-v2 main 40a11d1d
#       (evaluate.cjs d1; checked wherever the file passes).
#   all every file above, nothing provided: the acceptance case.
#
# Structure (timed separately in each manifest):
#   provisioning  one fresh checkout and one run of the workflow steps with
#                 empty caches (the genuine fresh-dependency check: the
#                 candidate's build downloads its compilers itself), plus the
#                 PROVIDED Go module cache when a case needs it;
#   measured      the files, in parallel (PORTABILITY_JOBS, default 12; largest files first), one
#                 run per file and distinct environment (cases 27, 29 and all
#                 share the nothing-provided runs), each in its own clone of
#                 the provisioned checkout.
#
# A file passes only with exit 0, no failed or pending (skipped) test, and
# exactly the expected case identities and counts (expected-cases.json),
# from Mocha's own events (mocha-results.cjs, an observation ADAPTER).
#
# Required environment (no defaults):
#   PORTABILITY_REPO          git repository holding the candidate (stands in
#                             for the GitHub origin; it serves full history)
#   PORTABILITY_COMMIT        candidate commit
#   PORTABILITY_NODE_MODULES  solidity/node_modules installed from
#                             PORTABILITY_NODE_LOCK
#   PORTABILITY_NODE_LOCK     the yarn.lock that node_modules came from; must
#                             equal the candidate's solidity/yarn.lock
#   PORTABILITY_WORK          work directory, outside /private/tmp and /tmp
#
# ADAPTER (labelled): `yarn` is a shim. `yarn install` checks the linked
# node_modules instead of installing; `yarn <script> [args]` runs the
# package.json script through npm. Corepack's yarn is not fetched.
set -euo pipefail

cases=${1:?cases}
evidence=${2:?evidence dir}
for v in PORTABILITY_REPO PORTABILITY_COMMIT PORTABILITY_NODE_MODULES \
  PORTABILITY_NODE_LOCK PORTABILITY_WORK; do
  [[ -n ${!v:-} ]] || { echo "missing $v" >&2; exit 2; }
done
jobs=${PORTABILITY_JOBS:-12}
here=$(cd "$(dirname "$0")" && pwd -P)
D1=40a11d1dcdcf82d3962e430067cfe3f97be81483
[[ $cases == suite ]] && cases="27 30 29 31 28 all"

core_files="test/bridge/Frost.DepositSweep.test.ts test/bridge/Frost.PublicFunding.test.ts test/bridge/Frost.PublicReservation.test.ts test/bridge/Frost.PublicSettlement.test.ts test/bridge/Frost.PublicSpvMaintainer.test.ts test/bridge/Frost.PublicNegativeGuards.test.ts test/bridge/Frost.PublicGasCap.test.ts test/bridge/Frost.PublicMaximumBatch.test.ts test/bridge/Frost.PublicVaultCallback.test.ts test/bridge/Frost.CancellationAlternatives.test.ts test/bridge/Frost.SweepConflictResolution.test.ts test/bridge/Frost.SweepConflictResolution.Core.test.ts"
case_files() {
  case $1 in
  27 | 30) echo "test/bridge/Frost.Identity.test.ts" ;;
  29) echo "test/bridge/Frost.Verifier.GoOracle.test.ts test/bridge/Frost.Fraud.test.ts" ;;
  31) echo "$core_files" ;;
  28) echo "test/bridge/Frost.LegacyReconciliation.test.ts" ;;
  all) echo "test/bridge/Frost.Identity.test.ts test/bridge/Frost.Verifier.GoOracle.test.ts test/bridge/Frost.Fraud.test.ts test/bridge/Frost.LegacyReconciliation.test.ts $core_files" ;;
  esac
}
# The environment each case runs in: what is PROVIDED.
case_env() {
  case $1 in
  27 | 29 | all) echo none ;;
  30) echo full-history ;;
  31) echo gomods ;;
  28) echo gomods-core ;;
  *) echo "unknown case $1" >&2; exit 2 ;;
  esac
}
for c in $cases; do case_env "$c" >/dev/null; done

work=$(cd "$PORTABILITY_WORK" && pwd -P)
case $work in /private/tmp*|/tmp*|/private/var/tmp*) echo "PORTABILITY_WORK must be outside the denied temporary directories" >&2; exit 2 ;; esac
mkdir -p "$evidence"
evidence=$(cd "$evidence" && pwd -P)
F=$work/fresh-$(date +%Y%m%d%H%M%S)-$$
mkdir -p "$F"/{home,tmp,bin,go/pkg/mod,go-build}
log=$evidence/suite.log
: >"$log"
note() { echo "$*" | tee -a "$log"; }
realpath_of() { node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$1"; }
started=$(date +%s)

# --- Provisioning -------------------------------------------------------------

# 1. Checkout with the candidate workflow's own actions/checkout depth
# (fetch-depth, default 1; 0 is full history).
depth=$(git -C "$PORTABILITY_REPO" show "$PORTABILITY_COMMIT:.github/workflows/contracts.yml" |
  NODE_PATH="$PORTABILITY_NODE_MODULES" node -e '
const yaml = require("js-yaml")
const wf = yaml.load(require("fs").readFileSync(0, "utf8"))
const step = wf.jobs["contracts-build-and-test"].steps.find((s) => (s.uses || "").startsWith("actions/checkout@"))
if (!step) throw Error("no checkout step")
const d = step.with && step.with["fetch-depth"] !== undefined ? Number(step.with["fetch-depth"]) : 1
if (!Number.isInteger(d) || d < 0) throw Error("bad fetch-depth")
console.log(d)')
git init -q "$F/repo"
git -C "$F/repo" remote add origin "$PORTABILITY_REPO"
if [[ $depth -gt 0 ]]; then
  git -C "$F/repo" fetch -q --depth="$depth" origin "$PORTABILITY_COMMIT"
else
  git -C "$F/repo" fetch -q origin "$PORTABILITY_COMMIT"
fi
git -C "$F/repo" -c advice.detachedHead=false checkout -q FETCH_HEAD
head=$(git -C "$F/repo" rev-parse HEAD)
[[ $head == $(git -C "$PORTABILITY_REPO" rev-parse "$PORTABILITY_COMMIT^{commit}") ]]
shallow=$(git -C "$F/repo" rev-parse --is-shallow-repository)
note "checkout $head depth=$depth shallow=$shallow"

# 2. Dependencies from the candidate's lock (ADAPTER: linked, not installed).
cmp -s "$PORTABILITY_NODE_LOCK" "$F/repo/solidity/yarn.lock" || {
  note "FAIL node_modules lock differs from the candidate's solidity/yarn.lock"
  exit 1
}
node_modules=$(realpath_of "$PORTABILITY_NODE_MODULES")
ln -s "$node_modules" "$F/repo/solidity/node_modules"
cat >"$F/bin/yarn" <<'SHIM'
#!/usr/bin/env bash
# ADAPTER: yarn shim (see fresh-checkout.sh).
set -euo pipefail
if [[ ${1:-} == install ]]; then
  [[ -d node_modules ]] || { echo "yarn shim: node_modules missing" >&2; exit 1; }
  exit 0
fi
script=$1; shift
exec npm run --silent "$script" -- "$@"
SHIM
chmod +x "$F/bin/yarn"
cp "$here/mocha-results.cjs" "$F/mocha-results.cjs"

# 3. The sandbox. Reads and executions are denied by default; only these
# roots are allowed. Toolchains: the Nix store when node or git comes from
# Nix (their CA bundle is outside their own closures; the store holds no
# workspace artifacts), otherwise their install prefixes; go's GOROOT.
node_bin=$(realpath_of "$(command -v node)")
git_bin=$(realpath_of "$(command -v git)")
go_bin=$(realpath_of "$(command -v go)")
roots=(/System /usr /bin /sbin /private/etc /dev /private/var/db/timezone
  /Library/Developer/CommandLineTools /Library/Apple "$node_modules" "$F")
for b in "$node_bin" "$git_bin"; do
  if [[ $b == /nix/store/* ]]; then
    roots+=(/nix/store)
  else
    roots+=("$(cd "$(dirname "$b")/.." && pwd -P)")
  fi
done
roots+=("$(realpath_of "$(go env GOROOT)")" "$(cd "$(dirname "$go_bin")/.." && pwd -P)")
profile() { # profile <file> <extra readable root>...
  local out=$1; shift
  {
    echo '(version 1)'
    echo '(allow default)'
    echo '(deny file-read-data file-read-xattr file-write* process-exec*)'
    printf '(allow file-read-data file-read-xattr process-exec*'
    printf ' (subpath "%s")' "${roots[@]}" "$@"
    echo ' (literal "/") (literal "/private/var/select"))'
    printf '(allow file-write* (subpath "%s") (subpath "/dev"))\n' "$F"
  } >"$out"
}
profile "$F/sandbox.sb"

# Preflight: an unprovisioned host file next to the fresh root can be neither
# read nor executed inside the sandbox.
sentinel=$work/host-sentinel-$$
printf '#!/bin/sh\necho host-sentinel\n' >"$sentinel"
chmod +x "$sentinel"
leak=""
sandbox-exec -f "$F/sandbox.sb" /bin/cat "$sentinel" >/dev/null 2>&1 && leak="read by cat"
sandbox-exec -f "$F/sandbox.sb" "$sentinel" >/dev/null 2>&1 && leak="executed"
(cd "$F" && sandbox-exec -f "$F/sandbox.sb" node -e 'require("fs").readFileSync(process.argv[1])' "$sentinel") >/dev/null 2>&1 && leak="read by node"
rm -f "$sentinel"
[[ -z $leak ]] || { note "FAIL sandbox: an unprovisioned host file was $leak"; exit 1; }
note "sandbox: reads and executions outside the provisioned roots are refused"

# Fresh environment. TMPDIR, HOME and the Go caches are per environment.
tool_path=$F/bin:$(dirname "$(command -v node)"):$(dirname "$(command -v go)"):$(dirname "$(command -v git)"):/usr/bin:/bin:/usr/sbin:/sbin
envs_for() { # envs_for <dir>
  echo env -i HOME="$1/home" TMPDIR="$1/tmp/" PATH="$tool_path" LANG=C.UTF-8 \
    GOPATH="$1/go" GOMODCACHE="$1/go/pkg/mod" GOCACHE="$1/go-build" CI=true
}

# 4. The workflow's own provisioning steps (between "Install dependencies"
# and "Run tests" in contracts-build-and-test), run as written, with empty
# caches: the fresh-dependency check.
steps=$F/steps.json
(cd "$F/repo/solidity" && node -e '
const yaml = require("js-yaml"), fs = require("fs")
const wf = yaml.load(fs.readFileSync("../.github/workflows/contracts.yml", "utf8"))
const job = wf.jobs["contracts-build-and-test"]
const names = job.steps.map((s) => s.name)
const from = names.indexOf("Install dependencies"), to = names.indexOf("Run tests")
if (from < 0 || to < 0 || to < from) throw Error("workflow steps not found")
const out = job.steps.slice(from + 1, to).filter((s) => s.run).map((s) => ({
  name: s.name, run: s.run,
  dir: s["working-directory"] || (job.defaults && job.defaults.run && job.defaults.run["working-directory"]) || "."
}))
fs.writeFileSync(process.argv[1], JSON.stringify(out))
' "$steps")
n=$(node -e 'console.log(require(process.argv[1]).length)' "$steps")
for ((i = 0; i < n; i++)); do
  name=$(node -e 'console.log(require(process.argv[1])[process.argv[2]].name)' "$steps" $i)
  dir=$(node -e 'console.log(require(process.argv[1])[process.argv[2]].dir)' "$steps" $i)
  node -e 'process.stdout.write(require(process.argv[1])[process.argv[2]].run)' "$steps" $i >"$F/step-$i.sh"
  note "workflow step: $name"
  # shellcheck disable=SC2046
  if ! (cd "$F/repo/$dir" && $(envs_for "$F") sandbox-exec -f "$F/sandbox.sb" bash -e "$F/step-$i.sh") >>"$log" 2>&1; then
    note "FAIL workflow step '$name'"
    exit 1
  fi
done

# 5. One directory per environment the requested cases need, cloned from the
# provisioned state.
env_list=""
for c in $cases; do
  e=$(case_env "$c")
  [[ " $env_list " == *" $e "* ]] || env_list="$env_list $e"
done
for e in $env_list; do
  mkdir -p "$F/env-$e/tmp"
  cp -c -R "$F/home" "$F/go" "$F/go-build" "$F/env-$e/"
  if [[ $e == gomods || $e == gomods-core ]]; then
    # PROVIDED (stands in for #29): the module cache filled from the
    # committed go.mod/go.sum of both Go helpers, with the default proxy.
    for m in frost-digest frost-verifier-oracle; do
      # shellcheck disable=SC2046
      (cd "$F/repo/solidity/test/helpers/$m" && $(envs_for "$F/env-$e") GOTOOLCHAIN=local GOFLAGS=-mod=readonly go mod download all) >>"$log" 2>&1
    done
    note "PROVIDED Go module cache (#29) for $e"
  fi
  if [[ $e == gomods-core ]]; then
    # PROVIDED (stands in for #31): read-only access to the hard-coded Core,
    # including the files its symbolic links resolve to.
    core=(/private/tmp/k04-tools)
    while read -r l; do core+=("$(realpath_of "$l")"); done < <(find /private/tmp/k04-tools -type l)
    profile "$F/env-$e/sandbox.sb" "${core[@]}"
    note "PROVIDED read-only /private/tmp/k04-tools (#31) for $e"
  else
    cp "$F/sandbox.sb" "$F/env-$e/sandbox.sb"
  fi
done
if [[ " $cases " == *" 28 "* || " $cases " == *" all "* ]]; then
  # The D1 baseline sources, fetched by the harness for evaluate.cjs only.
  git init -q --bare "$F/d1.git"
  git -C "$F/d1.git" fetch -q --depth=1 "$PORTABILITY_REPO" "$D1"
fi
provisioned=$(date +%s)
note "provisioning: $((provisioned - started)) s"

# --- Measured -----------------------------------------------------------------

# Each run gets its own APFS clone of the provisioned checkout and of its
# environment's HOME and Go caches, so runs never share a working tree
# (concurrent Hardhat compiles in one checkout race on
# hardhat-dependency-compiler's temporary directory). ADAPTER (labelled):
# Hardhat's file cache is re-rooted to the clone, so the build done once in
# provisioning is reused, not redone.
cat >"$F/run-one.sh" <<RUN
#!/usr/bin/env bash
# run-one.sh <environment> <file>: one default-suite run (see fresh-checkout.sh).
e=\$1 f=\$2
base=\$(basename "\$f" .test.ts)
J=$F/job-\$e-\$base
mkdir -p "\$J/tmp"
cp -c -pR "$F/repo" "\$J/repo"
cp -c -pR "$F/env-\$e/home" "$F/env-\$e/go" "$F/env-\$e/go-build" "\$J/"
sed -i '' "s|$F/repo/|\$J/repo/|g" "\$J/repo/solidity/cache/solidity-files-cache.json"
if [[ \$e == full-history && \$(git -C "\$J/repo" rev-parse --is-shallow-repository) == true ]]; then
  git -C "\$J/repo" fetch -q --unshallow origin
fi
since=\$(node -e 'console.log(Date.now())')
cd "\$J/repo/solidity"
if [[ -f \$f ]]; then
  timeout 900 $(envs_for "\$J") NODE_OPTIONS="--require $F/mocha-results.cjs" \\
    PORTABILITY_RESULTS="\$J/results.json" \\
    sandbox-exec -f "$F/env-\$e/sandbox.sb" yarn test "\$f" >"$evidence/run-\$e-\$base.log" 2>&1
  echo \$? >"\$J/rc"
  if [[ \$base == Frost.LegacyReconciliation ]]; then
    node "$here/evaluate.cjs" d1 "\$J" "\$since" "$F/d1.git" $D1 "\$J/d1.json"
  fi
fi
RUN
chmod +x "$F/run-one.sh"
[[ " $env_list " == *" full-history "* ]] && note "PROVIDED full history (stands in for #27) for case 30"
for e in $env_list; do
  for c in $cases; do
    [[ $(case_env "$c") == "$e" ]] || continue
    for f in $(case_files "$c"); do echo "$e $f"; done
  done
done | sort -u | while read -r e f; do
  # Largest files first: they hold the longest runs.
  echo "$(stat -f %z "$F/repo/solidity/$f" 2>/dev/null || echo 0) $e $f"
done | sort -rn | cut -d' ' -f2- | xargs -P "$jobs" -L 1 "$F/run-one.sh"
measured=$(date +%s)
note "measured: $((measured - provisioned)) s with $jobs jobs"

# --- Evaluation ---------------------------------------------------------------

for c in $cases; do export "ENV_$c=$(case_env "$c")" "FILES_$c=$(case_files "$c")"; done
node -e '
const [cases, shallow, head, steps, prov, meas, jobs] = process.argv.slice(1)
const out = { candidate: head, shallow: shallow === "true", workflowSteps: Number(steps),
  provisionSeconds: Number(prov), measuredSeconds: Number(meas), jobs: Number(jobs), cases: [] }
for (const c of cases.trim().split(/\s+/)) out.cases.push({ id: c, env: process.env["ENV_" + c], files: process.env["FILES_" + c].trim().split(/\s+/) })
console.log(JSON.stringify(out))' "$cases" "$shallow" "$head" "$n" $((provisioned - started)) $((measured - provisioned)) "$jobs" >"$F/plan.json"
node "$here/evaluate.cjs" manifest "$F" "$evidence" "$here/expected-cases.json" "$F/plan.json" | tee -a "$log"
