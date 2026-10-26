# Round 3 remediation boundary

Recorded before changes at 85e4505b1a96de6592dd399be314bd544eb5cb0b;
paired keep-core 9fdcab15bcf38a57daa499d597c2fbb599ee0eb4.
Governing spec 51b9a168e6b6c73d4d471f7d302267a065407fb5.

K09-16: after FrostOnly, reject a new legacy-target commitment at its public
entrypoint, preserving the full relevant state. Accept an eligible FROST drain
and continue proving commitments legally made before cutover. This modifies
the production route guard; retain EIP-170 and ABI/storage compatibility.

K09-5: create each legacy obligation on immutable 76f790511, upgrade, cut over,
then discharge publicly. Include cross-wallet interleaving and exact refusal
frames. Known-key contract controls do not establish threshold host coverage.

K09-8: cover actual proof producer output through sweep/redemption consumers
at realistic proof settings, in addition to the existing movement proof.
Keep retained-chain, custody-origin and relay assumptions explicit.

The prior K09-14 public replay is correctly refused by the input-count guard;
its request-state guard is a separately labeled seeded control. Do not claim
the unreachable public guard as a finding or change its semantics to ease tests.

Fresh evidence must bind changed source/artifacts; old runs are historical.
Follow the paired K09-REVIEW3 contract, focused bounds and private diagnostics.
No model, V-05, campaign, release or merge gate is granted by remediation.
