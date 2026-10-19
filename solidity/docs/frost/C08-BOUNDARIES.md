# C-08 fraud boundaries and open gates

Recorded on 19 October 2026 with the C-08 implementation. This states what
the inactive C-08 code establishes, what it does not, and what C-09, K-08 and
D-05 still owe. It answers KC-SF-V3 FRD-01 to FRD-04 and TF-04 to TF-06 at
the contract boundary only.

## Entrypoints

| Entrypoint | Purpose |
| --- | --- |
| `submitFrostFraudChallenge(walletId, digest, signature)` | payable; the bond is `fraudChallengeDepositAmount` |
| `defeatFrostFraudChallenge(Defense)` | exact transaction defense |
| `defeatFrostFraudChallengeWithHeartbeat(walletId, nonce)` | heartbeat defense |
| `notifyFrostFraudChallengeDefeatTimeout(walletId, digest)` | timeout after `fraudChallengeDefeatTimeout` |
| `frostFraudChallenge`, `frostProvenTransaction`, `frostOpenChallenges`, `frostHeartbeatDigest` | views |

They are reached through `FrostMovementDispatch` → `FrostFraudDispatch` →
`FrostFraud`. The Bridge fallback becomes `payable`, and `FrostBridge.dispatch`
refuses call value for every selector except the challenge submission. The
Bridge bytecode drops to 24,258 bytes. Legacy ECDSA fraud storage and methods
are untouched.

## What the code establishes

**Admission (FRD-01, FRD-02, TF-04).**

- Any 32-byte digest is accepted with a strict BIP340 signature under the
  wallet's Q, verified by the installed C-07 verifier (address and code hash
  from the funding configuration).
- A signature outside the honest profile (another hash type, an annex, a
  foreign script, a raw digest) is therefore actionable.
- Accepted wallet states: `ReadyUnfunded`, `Live`, `MovingFunds`, `Closing`
  and `Terminated`.
- Admission never uses ECDSA recovery.

**Canonical identity (TF-06, FRD-04).** The challenge key is
`keccak256("tbtc-v2/frost-fraud-challenge/v1" hash ‖ scheme 2 ‖ walletId ‖ digest)`.
The wallet ID is derived from the x-only key, so no encoding or parity alias
yields a second challenge, bond or timeout. One challenge per key.

**Transaction defense (FRD-03, TF-05).**

- The contract rebuilds the BIP341 message for the challenged input:
  `SIGHASH_DEFAULT`, epoch 0, no annex, with sha_prevouts, sha_amounts,
  sha_scriptpubkeys, sha_sequences, sha_outputs and the input index.
- It then takes the `TapSighash` tagged hash.
- The spend is either:
  - **key path:** the challenged prevout script must be `OP_1 PUSH32 Q`;
  - **script path (spend type 2, key version 0, no code separator):** the
    challenged outpoint must be one of this wallet's revealed deposits, its
    prevout script the deposit output key, and the leaf hash that of the
    deposit's wallet leaf over Q.
- Inputs must have empty scriptSigs. At most 128 inputs and 128 outputs.
- `SIGHASH_DEFAULT` commits to every input, prevout and output, so a matching
  digest authorizes that one transaction. The prevout values and scripts in
  the defense need no chain check: a signature over wrong prevouts spends
  nothing.

**Authorization of the transaction (FRD-03).**

| Kind | Evidence |
| --- | --- |
| Proven | `provenTransactions[txHash] == walletId`, written by deposit sweep (including resolution), movement and incoming sweep proofs |
| Intent | an admitted C-04 intent for this wallet names the hash as its payment, its cancellation, a retained cancellation alternative, or its sweep resolution; it need not have mined (losing replacements included) |
| Movement | the C-06 commitment for the given period, retired or not: one input (the committed main), outputs to the committed targets in order with the equal split and the fee cap stored with the commitment, mined or not |

A different legitimate spend of the same input never defeats an unauthorized
digest, because the digest itself must be rebuilt from the authorized
transaction.

**Heartbeat.**

- The digest is the tagged hash `"tbtc-v2/frost-heartbeat/v1"` over
  `walletId ‖ uint64 nonce` (big-endian).
- Its tag differs from `TapSighash` and BIP340's tags, so it cannot equal a
  transaction digest under the usual SHA-256 assumptions.
- The nonce rule ("current nonce") is K-08's. The contract accepts any nonce
  the wallet signed in this domain.

**Resolution.**

- A defeat sends the bond to the treasury.
- A timeout:
  - refunds the challenger;
  - terminates the wallet (the eligibility counter drops if it was eligible),
    keeping its key, custody and C-06 duties;
  - emits `FrostFraudChallengeDefeatTimedOut`.
- Each challenge resolves once. `openChallenges` counts unresolved challenges
  per wallet for the C-09 closure ledger.

**Storage.** `FrostFraudState.Storage` (three slots) is taken from the Bridge
gap, 14 → 11.

## Evidence

`test/bridge/Frost.Fraud.test.ts` runs through the real Bridge proxy with
real BIP340 signatures under each wallet's Q. Every transaction digest comes
from btcd (`frost-tapscript-digest.go`, `CalcTaprootSignatureHash` and
`CalcTapscriptSignaturehash`), so each successful defense is a differential
check of the on-chain reconstruction. The tests cover:

- admission and refusals (wrong message, other wallet, wrong key, malformed
  signature, short bond, unknown wallet);
- proven key-path, unmined movement, script-path deposit leaf and intent
  defenses;
- unauthorized spends that stay actionable, then timeout and termination;
- the heartbeat domain;
- the call-value guard.

The intent case writes a controlled C-04 intent marker. The reservation path
that writes real intents is covered by the C-04 suites.

## Open gates

- **D-05 and C-07 qualification.** This is the reference verifier; its
  specialist review and the P-C07-BIP340 proof are C-07's.
- **Unmined deposit and incoming sweeps.** A sweep signature that was
  broadcast but never mined has no on-chain authorization record, so it
  cannot be defended. K-06 never rebroadcasts a late sweep and quarantines it,
  but a sweep that loses a race to a depositor refund is public and
  undefendable. This needs an on-chain sweep intent or a conflict-proof
  defense (D-05, OPEN).
- **C-09:** the sanction route on timeout (D-03), a closure ledger that
  includes `openChallenges`, and closing-period rules for challenges against
  `Closing` wallets.
- **K-08:** the host heartbeat purpose and nonce rule, evidence retention
  (P-K08-EVIDENCE-RETAINED) and defense submission before the deadline.
- **Gas.** The worst-case shape (128 inputs and outputs, script path) is not
  measured against the entrypoint budget.
- **Legacy ECDSA wallets** keep the legacy BIP143 path; nothing here changes
  them.
