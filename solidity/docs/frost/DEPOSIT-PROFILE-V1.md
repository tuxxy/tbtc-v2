# Proposed D-04 local NUMS two-leaf deposit profile v1

Status: proposed local construction, not production D-04 approval, C-05 admission
exit, cryptographic qualification or Bitcoin spendability evidence. Byte/schema
changes require a new profile/version and repeated affected interoperability checks.

## API and fixed receipt bytes

`FrostDepositProfile.Terms` fields in order are: `uint256 chainId`, `address bridge`,
`bytes32 bitcoinGenesis`, `bytes32 fullWalletId`, `bytes32 descriptorHash`,
`address depositor`, `address vault`, `bytes8 blinding`, `uint64 amount`,
`bytes32 refundKey`, `uint32 refundLocktime`, `bytes32 extraData`.

`receipt(Terms)` returns SHA-256 of **flat Solidity ABI encoding** of
`keccak256("tbtc-v2/frost-deposit-receipt/v1")`, followed by those twelve fields.
The preimage is thirteen static 32-byte words (416 bytes), not packed encoding,
JSON or a signature digest. Integers/addresses left-pad; bytes8 blinding right-pads.
Hash/key bytes are unchanged; Bitcoin genesis uses configured internal/wire bytes.
RPC display reversal must happen before constructing the terms.

The structural domain requires positive chainId and nonzero bridge, genesis,
full wallet ID, descriptor hash and depositor. Vault, blinding and extraData zero
are permitted. Amount is positive and at most 2,100,000,000,000,000 satoshis,
with full uint64 comparisons. Refund locktime is uint32 Unix time at least
500,000,000. These are construction constraints, not authenticated chain/wallet
state, funding, dust or fee-policy checks.

No funding transaction hash appears in the receipt: its output commits to that
receipt, so including its hash would be circular. The separate admission record
must bind the actual funding outpoint and exact funding value/script afterward.

## Exact leaves, hashes and controls

`walletLeaf(Terms,Q)` returns 68 bytes:

`PUSH32(receipt) DROP PUSH32(Q) CHECKSIG`

Wire bytes: `20 || receipt || 75 20 || Q || ac`. Q is the registered wallet's
x-only signing key; no second tweak applies to this leaf key.

`refundLeaf(Terms)` returns:

`PUSH32(receipt) DROP minimalScriptNum(refundLocktime) CLTV DROP PUSH32(refundKey) CHECKSIG`

It is 75 bytes below 2^31 and 76 bytes from 2^31 through uint32 maximum. ScriptNum
is minimal positive signed-magnitude little endian; a high sign bit adds one zero
byte, with direct push prefix 04 or 05. Terms validation precedes serialization.
Refund spends must satisfy CLTV transaction locktime, nonfinal sequence and
Bitcoin inclusion rules; the script timestamp alone proves no current spendability.

`leafHash(script)` fixes BIP342 leaf version c0 and applies BIP341 tagged SHA-256
TapLeaf to `c0 || canonicalCompactSize(script.length) || script`.
`root(Terms,Q)` has exactly the generated wallet/refund leaves. Their hashes are
lexicographically sorted as raw 32-byte strings and tagged-hashed as TapBranch.
No byte reversal, optional third leaf, caller-selected version or OP_SUCCESS is
introduced. Generic leafHash/branchHash helpers do not change root's fixed tree
or authorize arbitrary scripts.

`internalKey()` fixes BIP341's H:

`50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0`

BIP341 identifies H as the lifted SHA-256 of the standard uncompressed secp256k1
generator. This proposal fixes H rather than privacy-randomized H+rG; its unknown-
discrete-log assumption is required. Tests independently reproduce the generator hash.

`controlBlock(bytes32 sibling,uint8 parity)` returns exactly 65 bytes:

`(c0 | parity) || H || sibling`

Parity must be 0/1, selected from the **tweaked deposit output point's** parity,
not wallet-Q parity. Wallet spends use refundLeafHash as sibling; refund spends
use walletLeafHash. Vectors retain both parity-shaped candidates; only verified
TapTweak parity chooses the valid one. This helper does not verify inclusion in
an admitted output by itself.

## Admission, C-07 and later qualification

This encoder deliberately does not simulate Q/refundKey curve validation. It can
encode invalid key bytes. Before admission, parent/C-07 must authenticate exact
terms and registered wallet/descriptor, validate canonical x-only Q/refundKey,
verify `tapTweak32(H, root)` separately, and match the exact tweaked output script
`OP_1 PUSH32 outputKey`, parity, funding outpoint and amount in the admission record.
Vault/depositor/extraData entitlement, credit and custody conservation are parent duties.

Proposed script witnesses carry the Schnorr signature, generated leaf and its
65-byte control block, without annex or extra branches. Tests here do not compute
TapTweak, verify signatures, fund outputs or run Bitcoin Core. Qualification still
requires real Core wallet/refund leaf spends and negative early-refund, final-
sequence, wrong-key/script/control cases; C-07 verifier evidence; and actual
admission/proof correspondence and production policy. No deposit is authorized
by this local profile proposal.

## Independent fixed vectors and primary sources

[TypeScript encoder](../../test/data/frost/deposit-profile.ts) manually builds ABI
words, ScriptNum, CompactSize and tagged hashes using Node SHA-256; existing ethers
supplies only the Keccak domain hash. [Vectors](../../test/data/frost/deposit-profile-v1.json)
cover timestamp floor, 2^31-1, 2^31 and maximum uint256 domain/monetary/uint32-time
bounds. Large integer fields are decimal strings, never JavaScript Number.
Regenerate explicitly with:

`node -r ts-node/register/transpile-only test/data/frost/deposit-profile.ts --write-vectors`

Official primary sources checked:

- [BIP341 NUMS and tree/control construction](https://github.com/bitcoin/bips/blob/master/bip-0341.mediawiki#constructing-and-spending-taproot-outputs).
- [BIP342 c0 tapscript rules](https://github.com/bitcoin/bips/blob/master/bip-0342.mediawiki#specification).
- [BIP65 five-byte positive uint32 CLTV exception](https://github.com/bitcoin/bips/blob/master/bip-0065.mediawiki#detailed-specification).
