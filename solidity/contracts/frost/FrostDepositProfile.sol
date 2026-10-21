// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

/// @notice Proposed local D-04 NUMS/two-leaf byte profile; not deposit admission.
/// @dev Admission/C-07 must authenticate the terms, validate Q/refundKey on the
/// curve, verify tapTweak32(internalKey, root), and bind exact funding value/script
/// and outpoint. Encoding a key here is not a curve or spendability check.
library FrostDepositProfile {
    struct Terms {
        uint256 chainId;
        address bridge;
        bytes32 bitcoinGenesis;
        bytes32 fullWalletId;
        bytes32 descriptorHash;
        address depositor;
        address vault;
        bytes8 blinding;
        uint64 amount;
        bytes32 refundKey;
        uint32 refundLocktime;
        bytes32 extraData;
    }

    bytes32 internal constant RECEIPT_DOMAIN =
        keccak256("tbtc-v2/frost-deposit-receipt/v1");
    uint8 internal constant LEAF_VERSION = 0xc0;
    uint256 internal constant MAX_SATOSHI = 2100000000000000;

    /// @dev BIP341's H = lift_x(SHA256(uncompressed secp256k1 generator)).
    /// This proposed profile fixes H, not H+rG, and assumes its log is unknown.
    function internalKey() internal pure returns (bytes32) {
        return
            0x50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0;
    }

    function receipt(Terms memory terms) internal pure returns (bytes32) {
        require(
            terms.chainId != 0 &&
                terms.bridge != address(0) &&
                terms.bitcoinGenesis != bytes32(0) &&
                terms.fullWalletId != bytes32(0) &&
                terms.descriptorHash != bytes32(0) &&
                terms.depositor != address(0),
            "FROST deposit domain"
        );
        require(
            terms.amount > 0 && terms.amount <= MAX_SATOSHI,
            "FROST deposit amount"
        );
        require(terms.refundLocktime >= 500000000, "FROST refund timestamp");
        // Flat Solidity ABI encoding: uints/addresses left pad, bytes8 right pads.
        // No funding tx hash: including it would make output construction circular.
        return
            sha256(
                abi.encode(
                    RECEIPT_DOMAIN,
                    terms.chainId,
                    terms.bridge,
                    terms.bitcoinGenesis,
                    terms.fullWalletId,
                    terms.descriptorHash,
                    terms.depositor,
                    terms.vault,
                    terms.blinding,
                    terms.amount,
                    terms.refundKey,
                    terms.refundLocktime,
                    terms.extraData
                )
            );
    }

    /// @return script PUSH32(receipt) DROP PUSH32(Q) CHECKSIG.
    function walletLeaf(Terms memory terms, bytes32 outputKey)
        internal
        pure
        returns (bytes memory script)
    {
        return
            abi.encodePacked(
                hex"20",
                receipt(terms),
                hex"7520",
                outputKey,
                hex"ac"
            );
    }

    /// @return script PUSH32(receipt) DROP minimal timestamp CLTV DROP
    /// PUSH32(refundKey) CHECKSIG. CLTV's positive uint32 may need five bytes.
    function refundLeaf(Terms memory terms)
        internal
        pure
        returns (bytes memory script)
    {
        bytes32 boundReceipt = receipt(terms);
        bytes memory lock = scriptNumber(terms.refundLocktime);
        return
            abi.encodePacked(
                hex"20",
                boundReceipt,
                hex"75",
                lock,
                hex"b17520",
                terms.refundKey,
                hex"ac"
            );
    }

    function leafHash(bytes memory script) internal pure returns (bytes32) {
        return
            taggedHash(
                sha256("TapLeaf"),
                abi.encodePacked(
                    bytes1(LEAF_VERSION),
                    compactSize(script.length),
                    script
                )
            );
    }

    function branchHash(bytes32 first, bytes32 second)
        internal
        pure
        returns (bytes32)
    {
        if (uint256(first) > uint256(second)) (first, second) = (second, first);
        return taggedHash(sha256("TapBranch"), abi.encodePacked(first, second));
    }

    /// @notice Exactly the generated wallet and refund leaves; no optional branch.
    function root(Terms memory terms, bytes32 outputKey)
        internal
        pure
        returns (bytes32)
    {
        return
            branchHash(
                leafHash(walletLeaf(terms, outputKey)),
                leafHash(refundLeaf(terms))
            );
    }

    /// @dev Parity is the output key parity returned/verified by C-07 TapTweak.
    /// The sibling must be the other generated leaf hash, not an arbitrary proof.
    function controlBlock(bytes32 sibling, uint8 parity)
        internal
        pure
        returns (bytes memory)
    {
        require(parity < 2, "FROST control parity");
        return
            abi.encodePacked(
                bytes1(LEAF_VERSION | parity),
                internalKey(),
                sibling
            );
    }

    function taggedHash(bytes32 tag, bytes memory payload)
        private
        pure
        returns (bytes32)
    {
        return sha256(abi.encodePacked(tag, tag, payload));
    }

    function scriptNumber(uint32 timestamp)
        private
        pure
        returns (bytes memory)
    {
        // Receipt validation enforces timestamp >= 500M, so OP_0/OP_1..16
        // shortcuts never apply. Serialize positive signed-magnitude little endian.
        bytes memory scratch = new bytes(5);
        uint256 length;
        uint32 remaining = timestamp;
        while (remaining != 0) {
            scratch[length++] = bytes1(uint8(remaining));
            remaining >>= 8;
        }
        if (uint8(scratch[length - 1]) & 0x80 != 0) scratch[length++] = 0x00;
        bytes memory encoded = new bytes(length + 1);
        encoded[0] = bytes1(uint8(length));
        for (uint256 i = 0; i < length; i++) encoded[i + 1] = scratch[i];
        return encoded;
    }

    function compactSize(uint256 size) private pure returns (bytes memory) {
        if (size < 253) return abi.encodePacked(uint8(size));
        if (size <= type(uint16).max)
            return abi.encodePacked(hex"fd", littleEndian(size, 2));
        if (size <= type(uint32).max)
            return abi.encodePacked(hex"fe", littleEndian(size, 4));
        require(size <= type(uint64).max, "FROST script size");
        return abi.encodePacked(hex"ff", littleEndian(size, 8));
    }

    function littleEndian(uint256 value, uint256 width)
        private
        pure
        returns (bytes memory result)
    {
        result = new bytes(width);
        for (uint256 i = 0; i < width; i++)
            result[i] = bytes1(uint8(value >> (8 * i)));
    }
}
