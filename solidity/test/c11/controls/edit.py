#!/usr/bin/env python3
"""Source-edit controls for the C-11 tests (run by run-controls.sh).

Each edit weakens one guard in the implementation's source and must apply
exactly once; otherwise the control did not run and this script fails.
Usage: edit.py <control>   (run from solidity/)
"""
import re
import sys


def balanced_function(source, name):
    """Span of `function <name>(...) ... { ... }`, from its line start."""
    m = re.search(r"\n([ \t]*)function\s+" + name + r"\s*\(", source)
    if not m:
        sys.exit(f"control did not apply: no function {name}")
    start = m.start() + 1
    depth = 0
    i = source.index("{", m.end())
    while True:
        if source[i] == "{":
            depth += 1
        elif source[i] == "}":
            depth -= 1
            if depth == 0:
                return start, i + 1
        i += 1


def edit(path, change):
    with open(path) as f:
        source = f.read()
    changed = change(source)
    if changed == source:
        sys.exit(f"control did not apply to {path}")
    with open(path, "w") as f:
        f.write(changed)


def forwarder_unguarded(source):
    # Drops onlyOwner from the setFrostFundingGates forwarder.
    start, end = balanced_function(source, "setFrostFundingGates")
    body = source[start:end]
    header, rest = body.split("{", 1)
    if header.count("onlyOwner") != 1:
        sys.exit("control did not apply: setFrostFundingGates has no single onlyOwner")
    return source[:start] + header.replace("onlyOwner", "") + "{" + rest + source[end:]


def forwarder_missing(source):
    # Deletes the abortLegacyDkgDrain forwarder.
    start, end = balanced_function(source, "abortLegacyDkgDrain")
    return source[:start] + source[end:].lstrip("\n")


def no_codehash_check(source):
    # Accepts any runtime hash at verifier install.
    return source.replace("verifier.codehash == runtimeHash &&", "", 1)


def window_guard(source):
    # Removes the governance check that guards every non-view
    # FrostExposure selector. The derivation then no longer finds those
    # entrypoints guarded, and the window case fails at its derivation check.
    pattern = re.compile(
        r"require\(\s*msg\.sender\s*==\s*IFrostExposureGovernance\(address\(this\)\)\.governance\(\),\s*\"Caller is not governance\"\s*\);",
        re.S,
    )
    changed, n = pattern.subn("", source, count=1)
    if n != 1:
        sys.exit("control did not apply: FrostExposure governance check")
    return changed


CONTROLS = {
    "c11-5-forwarder-unguarded": ("contracts/bridge/BridgeGovernance.sol", forwarder_unguarded),
    "c11-5-forwarder-missing": ("contracts/bridge/BridgeGovernance.sol", forwarder_missing),
    "c11-7-no-codehash-check": ("contracts/frost/FrostFundingConfiguration.sol", no_codehash_check),
    "c11-2-window-guard": ("contracts/frost/FrostExposure.sol", window_guard),
}

if __name__ == "__main__":
    path, change = CONTROLS[sys.argv[1]]
    if len(sys.argv) > 2 and sys.argv[2] == "--path":
        print(path)
    else:
        edit(path, change)
