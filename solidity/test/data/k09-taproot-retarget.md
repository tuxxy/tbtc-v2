# K-09 retained Taproot proof composition

The adjacent JSON retains public mainnet transaction
153bf9a05d1aa8382a578fd9432d0990dc26ac52339d6f3852e72e673c3dca4a,
its parent, coinbase and inclusion paths, and ten actual headers starting at
838655, crossing the difficulty retarget at 838656. Primary provider URLs and
retrieval date are recorded in the vector. SHA256:
6139d0175dbd00be7815050866f007ebd11ce9d4a66ad3a4eb0a140de5bc13bd.

The keep-core `TestFrostRetainedMainnetMovementProof` supplies these historical
chain observations to the real FROST movement maintainer, difficulty-aware
depth policy and default Bitcoin proof assembler. No test assembler intervenes.
Five available headers refuse; six satisfy factor six across the rising
retarget. The generated proof is written once to a private path and passed
unchanged to `Frost.LifecycleRealisticSpv.test.ts` and the full Bridge FROST
moving-funds proof entrypoint. Missing producer output fails the consumer suite.

The consumer tests acceptance, insufficient accumulated work, invalid Merkle
inclusion, an out-of-range relay observation, inconsistent custody and replay.
Refusals preserve the relevant custody, Bank balance, commitment, incoming,
counter, spent and proven-transaction frame. Production Bridge/libraries are
unchanged; EIP-170 remains enabled.

Controlled adapters publish the two retained epoch difficulties, create the
wallet descriptors, seed custody from the actual parent outpoint and enter
MovingFunds. The public commitment uses a local 20,000-satoshi cap covering the
actual 9,702-satoshi fee. These are explicit proof-composition assumptions,
not mainnet custody origin, threshold ownership of these public keys, a
canonical relay deployment, production fee policy or funding qualification.
The separate real-worker/Core public lifecycle supplies reachable funding and
threshold-signing evidence under its own local assumptions.
