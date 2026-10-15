# C-04 canonical redemption and cancellation transaction boundary

`FrostRedemptionTransaction` is a pure byte validator, not Bridge admission or
Bitcoin proof verification. It takes `BitcoinTx.Info` without witness data,
exact output key Q, ordered recognized `BitcoinTx.UTXO[]`, and (for redemption)
ordered net `FrostSigningIntent.Request[]`. Its API uses memory for decoded calls.

`Result` contains `bytes32 snapshot`, `bytes32 txHash`, `uint64 fee`,
`uint64 changeValue`, `uint32 changeIndex`, and `uint256 virtualSize`.
`validateRedemption` and `validateCancellation` return that result or revert.
`validateFees(result, minimum, maximum, maximumSatPerVByte)` supplies an optional
full-width policy check; the parent must enforce captured-request fees and policy
on the same result, not use parsing success as fee-policy authorization.

## Frozen bytes and profile

- Version is exactly wire bytes `02000000`; locktime and sequence are included
  unchanged. Input and output counts use minimal Bitcoin CompactSize and lie
  in 1–256. Both vectors are consumed exactly, with no trailing data.
- Every input has a nonzero exact ordered recognized transaction hash/index,
  empty scriptSig, complete sequence and a positive recognized value. Duplicate
  outpoints refuse; distinct indices of the same transaction remain distinct.
- Each value and both aggregate value sums are at most 2,100,000,000,000,000
  satoshis. The fee is input sum minus output sum and must be strictly positive.
  Checked arithmetic and comparisons occur before conversion to uint64.
- Redemption has 1–255 payees and exactly one additional output. Payee values
  and full supported legacy scripts match in order; IDs must be nonzero.
  The last output is positive exact `OP_1 PUSH32 Q` change. No second tweak,
  HASH160 lookup, P2TR payee extension or change discovery policy is introduced.
- Cancellation has exactly one positive exact-Q output, at change index zero.
  It uses the same canonical input, fee and snapshot rules. The parent must
  supply/verify recognized inputs that include the previously reserved conflict
  outpoint; there is no old-reservation argument from which this library could
  independently prove that cross-transaction relation.
- Q is checked as a canonical liftable secp256k1 x coordinate with pure public
  field arithmetic. This does not authenticate the wallet/descriptor that owns Q.

The snapshot is exactly K-04 INTENT-V2's snapshot sub-format: SHA-256 of ASCII
`keep-core/taproot-snapshot/v1` (no NUL), 32-byte Q, complete unsigned canonical
non-witness serialization, then for each input in order its uint64 value in
little endian, CompactSize script length `22` (hex, 34 decimal), and the exact
34-byte Q script. No opaque snapshot is accepted.

`txHash` is the double-SHA-256 raw digest of that same unsigned non-witness
serialization, in Bitcoin internal/wire hash order. Reverse bytes only for RPC
or explorer display. It is neither the snapshot commitment nor a wtxid.

Signed virtual size assumes precisely one 64-byte SIGHASH_DEFAULT key-path
signature per input, no annex and no explicit sighash byte. For stripped size S
and input count N, signed weight is `4*S + 2 + 66*N`, and vsize is its ceiling
quotient by four. The two extra bytes are the witness marker/flag; each witness
has one-byte stack count, one-byte 64 length, and 64 signature bytes. This is a
size derivation, not signature or witness validation.

## Parent custody, request and fee obligations

`BitcoinTx.UTXO` carries no script or funding proof. Recognized input values and
outpoints must come from authoritative custody whose script is exactly this Q
script. The validator compares those outpoints in order and binds their values
and Q scripts in the snapshot; it cannot establish the supplied records' origin.
The parent must also authenticate the source wallet and reserved main conflict
input and connect cancellation/replacements to that recorded conflict outpoint.

Payees must be derived from funded requests and captured gross/treasury/fee
policy. Request distinctness is the parent's atomic Requested-to-Reserved guard;
this byte validator does not consume requests or establish escrow eligibility.
The monetary cap is not a dust, inclusion, finality, maturity or production fee
policy. Captured caps, actual fee allocation, min/max/rate, admission and proof
relations remain separate required parent checks.

`validateFees` rejects invalid/nonpositive min/max/rate domains and monetary-cap
excess, then checks the derived positive fee and size. Its division/remainder
rate check refuses fractional excess without overflowing multiplication. A
caller-constructed Result is not authorized by this arithmetic helper.

Tests include both unchanged Go intent-vector transactions/snapshots, independent
non-witness hash and signed serialization size, all four recipient shapes,
multiple prevouts, minimal CompactSize boundaries, truncation/trailing data,
malformed amounts/scripts/outpoints, duplicate input, cancellation and full-width
fee policy. No funding, settlement, model proof, mutation campaign or production
milestone exit is claimed.
