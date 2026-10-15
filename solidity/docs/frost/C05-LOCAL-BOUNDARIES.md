# C-05 local implementation boundaries

This work follows C-05a exact template/reveal and C-05b sweep/accounting in
KC-SF-V3. It is an unqualified local implementation. It does not enable G-F.

`FrostDepositAdmission` binds the chain, Bridge, Bitcoin genesis, full wallet ID,
descriptor, depositor, vault, blinding, amount, refund key/time and extra data.
It validates canonical funding vectors, exact value and NUMS/two-leaf Taproot
output through the code-pinned C-07 verifier. Reveal creates metadata only.
Its pending counter counts asserted transactions, including unconfirmed or
fabricated ones. It must not become a closure/funding-obligation predicate
without an owned recovery/expiry rule.

Address construction returns the receipt, both exact scripts and both control
blocks before funding. Historical construction captures the wallet key and
remains readable through verifier/admission pauses. Refund locktime uses Unix
seconds and the existing reveal-ahead policy. The fixed NUMS profile remains a
local D-04 recommendation pending the required owner decision and qualification.

`FrostDepositSweep` calls the real `BitcoinTx.validateProof` and accepts only
recognized deposits for the destination wallet, optionally its current main
output. An available unreserved main must be included. It requires version 2, canonical bounded input counts, empty scriptSig,
one exact Q output and captured per-deposit fee bounds. Fees divide equally with
the remainder charged to the last deposit. Bank user plus treasury credit equals
deposit principal minus Bitcoin fee; main replacement preserves unrelated
custody. Trusted vault routing uses the existing Bank callback order; revoked
trust falls back to depositor Bank balances. Effects precede callbacks and a
late failure reverts the complete operation.

Deposit-only proofs may add custody during an active reservation. They preserve
the admitted main, state version and intent counter. Main-consuming proofs
reject active reservations. The C-04 consumer must subtract only its captured
spent inputs and retain later credited outputs. Registry readiness32 is separate
from the custody uint64 intent counter.

Shared funding outpoint identities use raw Bitcoin hash bytes and packed uint32
output index. FROST reveal rejects legacy/custody claims; legacy reveal rejects
FROST claims. Sweep records consumed inputs in the shared spent map and retains
deposit tombstones. FROST receipts do not populate legacy DepositRequest records;
legacy optimistic/adapter paths therefore cannot treat them as revealed legacy
deposits. Rebate-enabled reveal is explicitly unsupported pending owned accounting.
These paths still require their runtime rejection/rollback evidence.

All new production state is additive: two custody maps and eight funding slots
consume ten old gap slots, reducing gap44 to gap34 without moving older fields.
The exact compiler comparison is structural evidence, not a populated production
upgrade rehearsal. Fixed linked libraries are installed inactive. One-time
governance installation checks the expected verifier runtime hash, nonzero
approval reference and network, leaving both gates disabled. The reference is
not qualification evidence. Two actual public Bridge/proxy configuration tests
pass, including unauthorized/repeated/bad installation rejection. The production
authority bundle, atomic initialization and activation remain C-11 obligations.
Address and reveal flags are separate; neither gates existing sweep proofs or
historical refund data.

Eight component tests now cover actual Core inclusion through the real SPV
validator into the real Bank, without seeded custody/deposits/balances. They
include replay/wrong wallet/corrupted Merkle proof, completion while paused and
rollback after late treasury failure. The refund-spent case archives a valid
wallet-leaf spend before independently refunding its input, then observes Core
reject the identical wallet spend. The real mined refund proof cannot credit the
sweep consumer; the relevant financial frame remains unchanged. Wallet signing
is disabled throughout refund execution. Pending reveal metadata remains; cleanup
is a separate lifecycle obligation. The fixture still controls registration
metadata and regtest difficulty zero; it is not the complete public lifecycle.

Scoped local review corrections also cover main/input/fee guards and complete
rollback, with 54 guard/main/dispatch cases and measured 128-input Bank/Vault gas
fixtures; these use controlled boundary state and synthetic SPV. The total sweep
input cap is 128, including main; 129 refuses. Every public FROST SPV dispatch
checks the existing SPV-maintainer authorization before decoding or effects.

Open release/composition evidence: C-07 named implementation proofs and specialist
qualification, remaining full public lifecycle/Vault and optimistic/adapter
correspondence, target proof/debt-state gas qualification, D-04 adoption, full
K-06 witnesses and production policy. Local test evidence does not close these
prerequisite or downstream milestones.
Controlled Core regtest establishes script acceptance, not production accumulated
work/finality policy or threshold signing.
