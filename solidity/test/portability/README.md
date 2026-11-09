# Fresh-checkout portability check (tuxxy/tbtc-v2#27 to #31)

`fresh-checkout.sh` runs the default Solidity suite (`yarn test`) on chosen files from a fresh, CI-shaped checkout of a candidate commit. It runs locally only, never in CI.

**Invariant:** the default suite needs only what the repository and its contracts workflow provision. It must not need history beyond the workflow's checkout depth, a pre-filled Go module cache, or any file on this machine outside the checkout and its provisioned toolchains and dependencies (for example a Core binary, a baseline build or a helper left in the workspace, the home directory or `/private/tmp` by an earlier local session).

**Scope of the evidence:** this is local component evidence on macOS (`sandbox-exec`). It does not reproduce the Ubuntu CI runner. The workflow adapter runs `run:` steps only and ignores `uses`, `if` and step `env`, so it can also reject a provisioning fix that is correct on Linux; such a fix needs review, not a change to fit this adapter.

## The fresh environment
- **Checkout:** the candidate commit is fetched at the depth its own workflow's `actions/checkout` step asks for (`fetch-depth`; default 1).
- **Dependencies:** `node_modules` installed from the candidate's own `yarn.lock` is linked in (the lock is compared byte for byte; the installed tree itself is not attested).
- **Workflow steps:** every step of `contracts-build-and-test` between "Install dependencies" and "Run tests" runs as written. Network access is allowed, as on a CI runner.
- **Isolation:** HOME, TMPDIR, GOPATH, the Go module cache and the Go build cache start empty. `PATH` holds only node, go, git and the system directories.
- **Sandbox:** reading, executing and writing files are denied by default.
  - Readable and executable: the fresh root, the linked `node_modules`, the toolchains (the Nix store when node or git comes from Nix, otherwise their install prefixes; go's GOROOT) and the system directories (`/System`, `/usr`, `/bin`, `/sbin`, `/private/etc`, `/dev`, the Command Line Tools, `/Library/Apple` for Rosetta).
  - Writable: the fresh root only.
  - Before any step, a preflight writes a sentinel file next to the fresh root and requires that the sandbox can neither read it (`cat`, `node`) nor execute it.
  - Nothing in `/private/tmp` is moved or deleted.
- **ADAPTERs:**
  - `yarn` is a shim. `yarn install` checks the linked `node_modules`; `yarn <script>` runs the package script through npm.
  - `mocha-results.cjs`, loaded with `NODE_OPTIONS=--require`, records Mocha's own test and hook events. It only observes.
  - Each run gets an APFS clone of the provisioned checkout, with Hardhat's file cache re-rooted to the clone, so the build done once in provisioning is reused.

## Cases
Each issue case fails at its own named point. To get there, it supplies other issues' prerequisites, each recorded as PROVIDED in the manifest.

| Case | Files | Provided |
| --- | --- | --- |
| 27 | `Frost.Identity` | nothing |
| 30 | `Frost.Identity` | full history (stands in for #27) |
| 29 | `Frost.Verifier.GoOracle`, `Frost.Fraud` (a frost-digest consumer) | nothing |
| 31 | every default-suite file that reaches Bitcoin Core (12 files) | Go module cache (#29) |
| 28 | `Frost.LegacyReconciliation` | Go module cache (#29), read-only `/private/tmp/k04-tools` and the files its links resolve to (#31) |
| all | all of the above | nothing (the acceptance case) |

**A file passes only if all of these hold:**
- `yarn test <file>` exits 0;
- Mocha finished;
- no test or hook failed, and no test is pending (an `it.skip` or a runtime `this.skip()` is a failure);
- the passed tests are exactly the expected case identities and counts in `expected-cases.json` (97 tests in 16 files).

A renamed, moved, skipped or added test needs a reviewed amendment of `expected-cases.json`, not a smaller passing subset. To regenerate it from a candidate checkout, list the tests without running them:

```
PORTABILITY_DRY_RUN=1 PORTABILITY_RESULTS=<out.json> NODE_OPTIONS="--require $PWD/test/portability/mocha-results.cjs" \
  USE_EXTERNAL_DEPLOY=true TEST_USE_STUBS_TBTC=true npx hardhat test --no-compile <the 16 files>
```

**D1 legacy baseline (#28, owner decision D1).** Wherever `Frost.LegacyReconciliation` passes (cases 28 and all), its legacy baseline must also be tbtc-v2 `main` `40a11d1d`. The check is `evaluate.cjs d1`, run by the harness outside the sandbox:
- every `public-legacy-origin.json` the run wrote in its clone names its baseline build, and the harness reads that build itself;
- every `contracts/` source in the build's Bridge build-info, except Hardhat's generated dependency re-exports, must equal `40a11d1d:solidity/<path>`, which the harness fetches from `PORTABILITY_REPO`; `Bridge.sol` must be among them;
- the Bridge artifact must equal its build-info output;
- the run's own `baselineSourceHashes` must equal those sources' SHA-256, path for path.

The helper's self-reported revision is not trusted.

**Acceptance for #27–#31:** `manifest-all.json` at the candidate head with `"accepted": true`, every file `pass`, and nothing provided. Case 30 must also pass (guard).

## Timing
Each manifest records `provisionSeconds` and `measuredSeconds` separately.
- **Provisioning (once per invocation):** one fresh checkout and one run of the workflow steps with empty caches. This is the genuine fresh-dependency check: the candidate's build downloads its compilers itself. When a case needs it, provisioning also fills the PROVIDED Go module cache.
- **Measured:** one run per file and distinct environment, in parallel (`PORTABILITY_JOBS`, default 12; largest files first). Cases 27, 29 and all share the nothing-provided runs.

At integration `2377d060` on this machine (16 cores, quiet):

| Run | Provisioning | Measured |
| --- | --- | --- |
| `all` | 42 s | 79 s |
| all six cases (`suite`) | 58 s | 119 s |

`Frost.SweepConflictResolution` (12 real tests, about 1 minute) sets the measured time.

## Environment (no defaults)
| Variable | Value |
| --- | --- |
| `PORTABILITY_REPO` | a git repository holding the candidate with full history, and `40a11d1d` (stands in for the GitHub origin) |
| `PORTABILITY_COMMIT` | the candidate commit |
| `PORTABILITY_NODE_MODULES` | `solidity/node_modules` installed from `PORTABILITY_NODE_LOCK` |
| `PORTABILITY_NODE_LOCK` | that lock; it must equal the candidate's `solidity/yarn.lock` |
| `PORTABILITY_WORK` | work directory outside `/private/tmp` |

**Usage:** `fresh-checkout.sh "<case>..." <evidence dir>`, where a case is 27, 28, 29, 30, 31 or all, or `suite` for all six. It writes:
- `manifest-<case>.json` per case;
- `run-<environment>-<file>.log` per run;
- `suite.log`.

It exits non-zero unless every requested case is accepted.

## Limits
- macOS only, and component evidence only (see the scope of the evidence above).
- If a fix moves a file out of `test/bridge/`, its case reports it `missing`. An example is moving it into an explicitly provisioned integration suite, which #31's review allows. The case list and `expected-cases.json` then need a reviewed amendment, together with a check of the new suite's provisioning.
