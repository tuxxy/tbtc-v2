# C-07 verifier qualification — incomplete

The runtime implements canonical x-only key validation, a bytes32-message BIP340
verifier and a 32-byte-root TapTweak relation with output parity. Deterministic
tests are in `test/bridge/Frost.Verifier.test.ts`; the official BIP340 CSV and
license are retained with exact provenance. Non-32-byte message vectors are
explicitly excluded from this API rather than transformed.

Run the runtime checks from `solidity` with the repository's normal dependencies:

```sh
npx hardhat test test/bridge/Frost.Verifier.test.ts
```

The Lean files are partial arithmetic evidence. They were checked with Lean
4.19.0 and mathlib commit `c44e0c8ee63ca166450922a373c7409c5d26b00b`;
each check was limited to 60 seconds, two
threads and 4 GiB process RSS. They contain no `sorry` or new axioms. Coordinate
addition/doubling and exceptional cases use explicit mathlib curve premises;
the scalar loop is a generic group/BitVec result. CanonicalSubtraction binds
the exact P constant to a natural-number model of the subtraction helper.
These files do not establish Solidity/EVM execution correspondence.

For a configured mathlib project at that revision, copy a proof file into the
project and run `lake env lean -j 2 <file>` under the same external time/memory
limits. The qualification runner/environment is not yet packaged in this branch.

## Open release blockers

- Named implementation predicates P-C07-BIP340 and P-C07-TAPTWEAK.
- Exact-P field and curve-order instantiation, including order for every admitted
  key; canonical operations, lift, hash/parsing and complete scalar-loop binding.
- Exact source/bytecode correspondence and D-04 deposit-profile composition.
- Independently reviewed worst-case gas bounds and a qualified target budget.
- Independent cryptographic specialist review.

Passing vectors and helper lemmas do not qualify this verifier for funded use.
This is an inactive draft prerequisite; no production gate is opened.
