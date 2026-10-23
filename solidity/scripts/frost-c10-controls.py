"""C-10 guard regressions: revert one guard and require the test that owns it
to fail at its own assertion; inject a contained fault and require its test
to pass (the expected revert reason appears in the
failure). Each control runs in its own throwaway copy of `solidity`, so they
run in parallel and the working tree is never modified. Run from `solidity`
after `npx hardhat compile`."""
import concurrent.futures
import os
import re
import shutil
import subprocess
import sys
import tempfile

root = os.getcwd()
EXPOSURE_TEST = "test/bridge/Frost.CutoverExposure.test.ts"
DISPATCH_TEST = "test/bridge/Frost.FundingDispatch.test.ts"
CONTROLLER = "contracts/frost/FrostExposureController.sol"
EXPOSURE = "contracts/frost/FrostExposure.sol"
WALLETS = "contracts/bridge/Wallets.sol"

controls = [
    # BOUND-06: the independent issuance ceiling.
    ("IssuanceCeiling", CONTROLLER,
     '        require(nextIssuance <= issuanceCeiling, "FROST issuance budget");\n', "",
     EXPOSURE_TEST, "bounds a faulty deposit validator", "FROST issuance budget"),
    # BOUND-03: the cumulative custody ceiling.
    ("CustodyCeiling", CONTROLLER,
     '        require(nextCustody <= custodyCeiling, "FROST custody budget");\n', "",
     EXPOSURE_TEST, "keeps the reservations within both ceilings", "FROST custody budget"),
    # Reading 8 (Astra re-check of #14): a release, proven through the
    # possibly faulty relay, restores no custody allowance.
    ("ReleaseRestoresAllowance", CONTROLLER,
     '        require(nextCustody <= custodyCeiling, "FROST custody budget");\n',
     '        require(nextCustody - custodyReleased <= custodyCeiling, "FROST custody budget");\n',
     EXPOSURE_TEST, "releases only an unsettled custody-only reservation", "FROST custody budget"),
    # Reconcile completion once.
    ("CompleteTwice", CONTROLLER,
     '        require(r.state == RESERVED, "Exposure settled");\n', "",
     EXPOSURE_TEST, "completes each reservation once", "Exposure settled"),
    # BOUND-11: containment stops new reservations.
    ("ReserveWhileContained", CONTROLLER,
     '    ) external override onlyBridge {\n        require(!contained, "FROST exposure contained");\n        Reservation storage r',
     '    ) external override onlyBridge {\n        Reservation storage r',
     EXPOSURE_TEST, "stops reveals, reservations and drain commitments", "FROST exposure contained"),
    ("ReserveDepositWhileContained", CONTROLLER,
     '    function reserveDeposit(uint64 amount) external override onlyBridge {\n        require(!contained, "FROST exposure contained");\n',
     '    function reserveDeposit(uint64 amount) external override onlyBridge {\n',
     EXPOSURE_TEST, "stops reveals, reservations and drain commitments", "FROST exposure contained"),
    # Deposit completion consumes at most the outstanding reserved value, so
    # a misreported reservation is charged (adversarial review of #14).
    ("DepositsOverCovered", CONTROLLER,
     "        uint64 covered = reserved < depositsOutstanding\n            ? reserved\n            : depositsOutstanding;\n        depositsOutstanding -= covered;\n",
     "        uint64 covered = reserved;\n",
     EXPOSURE_TEST, "completes each reservation once", 'Expected "5" to be equal 0'),
    # BOUND-11: containment stops reveals.
    ("RevealWhileContained", "contracts/frost/FrostDepositAdmission.sol",
     "        FrostExposureState.requireAdmission(bridge.frostExposure);\n", "",
     EXPOSURE_TEST, "stops reveals, reservations and drain commitments", "FROST exposure contained"),
    # BOUND-06: the single credit statement reports to the controller.
    ("CreditUnreported", "contracts/frost/FrostDepositSweep.sol",
     "        FrostExposureState.controllerOf(bridge.frostExposure).completeDeposits(\n            accounting.count,\n            uint64(reserved),\n            uint64(custody),\n            uint64(credited)\n        );\n", "",
     EXPOSURE_TEST, "bounds a faulty deposit validator", "FROST issuance budget"),
    # BOUND-03: a drain reserves custody at its commitment.
    ("DrainUnreserved", "contracts/bridge/MovingFunds.sol",
     "        if (drain)\n            FrostMovement.reportDrain(\n                self,\n                walletPubKeyHash,\n                walletBtcBalance,\n                true\n            );\n", "",
     EXPOSURE_TEST, "reserves a legacy drain's custody at its commitment", "FROST custody budget"),
    # SC-01: no new ECDSA request once the drain has begun.
    ("RequestInDrain", WALLETS,
     '        require(\n            self.frostExposure.creationMode ==\n                FrostExposureState.LEGACY_OPEN,\n            "Legacy wallet creation closed"\n        );\n', "",
     EXPOSURE_TEST, "closes legacy requests at the drain", "Legacy wallet creation closed"),
    # SC-01: no ECDSA registration after the cutover, and during the drain
    # only the DKG in flight when it began, once (adversarial review of #14).
    ("RegisterAfterCutover", WALLETS,
     '        require(\n            exposure.creationMode == FrostExposureState.LEGACY_OPEN ||\n                (exposure.creationMode == FrostExposureState.LEGACY_DRAINING &&\n                    exposure.legacyDkgInFlight),\n            "Legacy wallet creation closed"\n        );\n', "",
     EXPOSURE_TEST, "closes legacy requests at the drain", "Legacy wallet creation closed"),
    ("DrainCallbackTwice", WALLETS,
     "        exposure.legacyDkgInFlight = false;\n", "",
     EXPOSURE_TEST, "closes legacy requests at the drain", "Legacy wallet creation closed"),
    # The cutover needs the legacy DKG IDLE.
    ("CutoverNotIdle", EXPOSURE,
     '        require(\n                self.ecdsaWalletRegistry.getWalletCreationState() ==\n                    EcdsaDkg.State.IDLE,\n                "Legacy DKG not idle"\n            );\n', "",
     EXPOSURE_TEST, "completes the cutover only with the legacy DKG IDLE", "Legacy DKG not idle"),
    # The cutover needs the legacy sortition pool unlocked.
    ("CutoverPoolLocked", EXPOSURE,
     "            require(\n                !ILegacyDkgPool(", "            require(\n                true || !ILegacyDkgPool(",
     EXPOSURE_TEST, "completes the cutover only with the legacy DKG IDLE", "Legacy sortition pool locked"),
    # A second controller would reset the counters.
    ("ReinstallController", EXPOSURE,
     "                exposure.controller == address(0),", "                true,",
     EXPOSURE_TEST, "installs the controller once", "FROST exposure installed"),
    # Drains exist only under a controller.
    ("DrainGateWithoutController", "contracts/frost/FrostMovementDispatch.sol",
     '            require(\n                !enabled || self.frostExposure.controller != address(0),\n                "FROST exposure not installed"\n            );\n', "",
     EXPOSURE_TEST, "installs the controller once", "FROST exposure not installed"),
    # Review of #14: a legacy sweep that replaces a drain's committed main
    # releases the drain, so a larger drain must reserve again.
    ("DrainKeptAfterDepositSweep", "contracts/bridge/DepositSweep.sol",
     "        FrostMovement.releaseDrainForMainChange(self, walletPubKeyHash);\n", "",
     EXPOSURE_TEST, "releases a drain when a legacy deposit sweep", "FrostDrainReleased"),
    ("DrainKeptAfterMovedFundsSweep", "contracts/bridge/MovingFunds.sol",
     "        FrostMovement.releaseDrainForMainChange(self, walletPubKeyHash);\n", "",
     EXPOSURE_TEST, "releases a drain when a legacy moved-funds sweep", "FrostDrainReleased"),
    ("DrainKeptAfterRedemption", "contracts/bridge/Redemption.sol",
     "        if (self.frostMovement.drainTargets[walletPubKeyHash].length > 0)\n            FrostMovement.releaseDrain(self, walletPubKeyHash);\n", "",
     EXPOSURE_TEST, "releases a drain when a timed-out legacy redemption", "FrostDrainReleased"),
    # Adversarial review of #14: every drain release clears the commitment,
    # so a conflict release that lands first leaves the source recommittable.
    ("ConflictKeepsCommitment", "contracts/frost/FrostMovement.sol",
     "        delete self\n            .registeredWallets[source]\n            .movingFundsTargetWalletsCommitmentHash;\n        emit FrostDrainReleased(source);\n",
     "        emit FrostDrainReleased(source);\n",
     EXPOSURE_TEST, "clears the commitment when the conflict release lands", "0x0000000000000000000000000000000000000000000000000000000000000000"),
    # A drain-committed source is proven only as a drain.
    ("LegacyShapedDrain", "contracts/bridge/MovingFunds.sol",
     "            frostOutputs ==\n                (\n                    self.frostMovement.drainTargets[processInfo.sourceWallet]\n                        .length > 0\n                        ? outputsCount\n                        : 0\n                ),\n",
     "            frostOutputs == 0 || frostOutputs == outputsCount,\n",
     EXPOSURE_TEST, "proves a drain-committed source only as a drain", "FROST drain mixes schemes"),
    ("DrainBelowDust", "contracts/bridge/MovingFunds.sol",
     '        require(\n            !drain || walletBtcBalance >= self.movingFundsDustThreshold,\n            "FROST drain below dust"\n        );\n', "",
     EXPOSURE_TEST, "refuses a drain commitment below the moving funds dust", "FROST drain below dust"),
    # A deposit is reserved once, and never inside its refund window.
    ("DepositReservedTwice", EXPOSURE,
     '        require(deposit.reservedAt == 0, "FROST deposit reserved");\n', "",
     EXPOSURE_TEST, "reserves a proven deposit once", "FROST deposit reserved"),
    ("DepositRefundWindow", EXPOSURE,
     '        require(\n            /* solhint-disable-next-line not-rely-on-time */\n            block.timestamp + self.frostExposure.depositReservationMargin <\n                deposit.terms.refundLocktime,\n            "FROST deposit refund window"\n        );\n', "",
     EXPOSURE_TEST, "refuses a reservation once the deposit can be refunded", "FROST deposit refund window"),
    # Contained faults (review of #14): the sweep's credit accounting is the
    # assumed faulty component, so an injected over-credit must leave every
    # Bank credit counted and within the ceiling. These must PASS.
    ("OverCreditedAmount", "contracts/frost/FrostDepositSweep.sol",
     "                deposit.treasuryFee -\n                charged;\n",
     "                deposit.treasuryFee -\n                charged +\n                100000;\n",
     EXPOSURE_TEST, "keeps every Bank credit inside the controller's count", "contained"),
    ("UnchargedFee", "contracts/frost/FrostDepositSweep.sol",
     "                deposit.treasuryFee -\n                charged;\n",
     "                deposit.treasuryFee;\n",
     EXPOSURE_TEST, "keeps every Bank credit inside the controller's count", "contained"),
    # Deposits exist only under a controller.
    ("FundingGateWithoutController", "contracts/frost/FrostBridge.sol",
     '            require(\n                !(addressesEnabled || revealEnabled) ||\n                    self.frostExposure.controller != address(0),\n                "FROST exposure not installed"\n            );\n', "",
     DISPATCH_TEST, "authenticates one-time installation", "FROST exposure not installed"),
]


def run(control, mutate=True):
    name, path, old, new, test, title, marker = control
    parent = tempfile.mkdtemp(prefix="c10-control-")
    try:
        tree = os.path.join(parent, "solidity")
        shutil.copytree(root, tree, symlinks=True,
                        ignore=shutil.ignore_patterns("cache", "build", "typechain", "export"))
        target = os.path.join(tree, path)
        src = open(target).read()
        # A stale control is a harness error for that control alone; the
        # others still run and report (adversarial review of #14).
        if src.count(old) != 1:
            return name, None, f"stale control: {src.count(old)} matches in {path}"
        if mutate:
            src = src.replace(old, new)
        open(target, "w").write(src)
        env = dict(os.environ, USE_EXTERNAL_DEPLOY="true", TEST_USE_STUBS_TBTC="true",
                   NODE_OPTIONS="--max-old-space-size=8192")
        r = subprocess.run(["npx", "hardhat", "test", test, "--grep", re.escape(title)],
                           cwd=tree, env=env, capture_output=True, text=True)
        out = r.stdout + r.stderr
        passing = re.search(r"(\d+) passing", out)
        failing = re.search(r"(\d+) failing", out)
        # Only the owning assertion kills a control; a compile error, a
        # missing test or an unrelated failure is a harness error. A revert
        # that names another reason names its expected one; a revert that did
        # not happen ("Transaction NOT reverted") carries no reason, so it
        # counts only when the selected test itself expects this reason.
        detail = [l.strip() for l in out.splitlines() if marker in l and ("Expected" in l or "AssertionError" in l)]
        source = open(os.path.join(tree, test)).read()
        start = source.find(title)
        body = source[start:source.find("\n  it(", start)] if start >= 0 else ""
        if not detail and "Transaction NOT reverted" in out and f'"{marker}"' in body:
            detail = [f"expected revert '{marker}' did not happen"]
        if marker == "contained":
            ok = r.returncode == 0 and passing and int(passing.group(1)) > 0 and not failing
            return name, bool(ok), "contained: the owning test passes under the fault" if ok else " | ".join([l for l in out.splitlines() if l.strip()][-3:])
        if failing and failing.group(1) == "1" and r.returncode != 0 and detail:
            return name, True, detail[0]
        if r.returncode == 0 and passing and int(passing.group(1)) > 0 and not failing:
            return name, False, f"{passing.group(1)} passing"
        tail = [l for l in out.splitlines() if l.strip()][-3:]
        return name, None, " | ".join(tail)
    finally:
        shutil.rmtree(parent, ignore_errors=True)


if "--self-test" in sys.argv:
    # An unchanged guard must survive; a reverted guard whose test is not
    # selected must be an error, never a kill.
    _, killed, line = run(controls[0], mutate=False)
    print(f"self-test: unchanged guard -> {'SURVIVED' if killed is False else killed}; {line}")
    ok = killed is False
    wrong = controls[0][:4] + (EXPOSURE_TEST, "no test has this title", controls[0][6])
    _, killed, line = run(wrong)
    print(f"self-test: no matching test -> {'ERROR' if killed is None else killed}; {line}")
    ok = ok and killed is None
    raise SystemExit(0 if ok else 1)

if "--only" in sys.argv:
    wanted = set(sys.argv[sys.argv.index("--only") + 1].split(","))
    controls = [c for c in controls if c[0] in wanted]

bad = False
with concurrent.futures.ThreadPoolExecutor(max_workers=7) as pool:
    for name, killed, line in pool.map(run, controls):
        contained = name in ("OverCreditedAmount", "UnchargedFee")
        verdict = "ERROR (did not run to its assertion)" if killed is None else (("CONTAINED" if contained else "KILLED") if killed else ("NOT CONTAINED" if contained else "SURVIVED"))
        print(f"{name}: {verdict}; {line}", flush=True)
        bad = bad or not killed
raise SystemExit(1 if bad else 0)
