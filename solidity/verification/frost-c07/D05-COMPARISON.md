# D-05 approach comparison — open decision

This records the C7-2 review response. The current Jacobian implementation is
an inactive prototype. This comparison does not freeze an implementation/proof
approach or qualify its gas budget. P-C07-BIP340 and P-C07-TAPTWEAK remain OPEN.

| Candidate                                                               | Acceptance relation and proof burden                                                                                                                                                                                                                                                                                                                         | Gas evidence                                                                                                                                                       | Decision status                                                                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Current direct Jacobian arithmetic                                      | Exact field-coordinate comparison, canonical lift, two full 256-bit multiplications for BIP340, explicit infinity/equal/opposite cases; needs source/EVM refinement and all-key group order.                                                                                                                                                                 | Existing finite sampled tests and review measurements only; fresh memory allocations grow across scalar loops. The 8M regression ceiling is not an analytic bound. | Baseline only; not a completed D-05 choice.                                                                                            |
| Direct arithmetic with reused scratch storage / combined multiplication | Can retain the same exact relation if allocation changes and joint scalar recoding preserve all exceptional cases. Needs differential checks and updated loop/refinement evidence; Shamir/GLV introduce additional recoding identities.                                                                                                                      | Not yet measured on source-bound compiled candidates.                                                                                                              | Preferred first comparison experiment because it retains the existing acceptance relation; not selected until measurements and review. |
| Construction using ecrecover internally                                 | Requires a complete derivation and fallback cases; returning an Ethereum address provides a truncated hash comparison rather than the existing full-coordinate relation. Canonical admissible x values outside the ECDSA r range and zero intermediate scalars need explicit treatment. Such assumptions cannot silently replace the named strict predicate. | Precompile cost alone does not include lift, hashes, exceptional paths or a possible direct-arithmetic fallback; no complete candidate measured.                   | Not selected. Needs frozen statements and independent specialist review before any runtime change.                                     |

The next bounded comparison must compile the current baseline and a scratch
candidate with the same optimizer settings, differential-check the exact API,
and measure valid, invalid and dense scalar paths. A complete gas argument must
bound both 256-step scalar loops, the number of additions, exceptional branches,
memory high-water growth and modexp calls. Invalid signatures are relevant: a
sender can choose a dense s and search for a high-popcount challenge without a
valid signature. A maximum valid-vector sample is therefore insufficient.

The target budget must reserve gas for the consuming admission/enforcement path
and respect EIP-7825's16,777,216 transaction cap, independently of block gas.
No final budget, specialist acceptance or predicate discharge is claimed here.
The 32-byte Merkle-root API and existing DKG x-coordinate lift are also part of
the source correspondence recorded by the separate review-response changes.
