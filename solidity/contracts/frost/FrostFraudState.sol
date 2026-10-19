// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

/// @notice C-08 FROST fraud storage, separate from the legacy ECDSA challenges.
library FrostFraudState {
    struct Challenge {
        bytes32 walletId;
        bytes32 digest;
        address challenger;
        uint64 reportedAt;
        bool resolved;
        uint256 depositAmount;
    }

    struct Storage {
        // keccak256(domain ‖ scheme ‖ walletId ‖ digest) => challenge
        mapping(bytes32 => Challenge) challenges;
        // Bitcoin transaction hash accepted by a FROST proof => wallet ID.
        mapping(bytes32 => bytes32) provenTransactions;
        // Unresolved challenges per wallet, for the C-09 closure ledger.
        mapping(bytes32 => uint64) openChallenges;
    }

    bytes32 internal constant CHALLENGE_DOMAIN =
        keccak256("tbtc-v2/frost-fraud-challenge/v1");
    uint8 internal constant SCHEME = 2;

    /// @dev Canonical in the wallet ID, which is derived from the x-only key,
    /// so no key encoding or parity alias can open a second challenge.
    function challengeKey(bytes32 walletId, bytes32 digest)
        internal
        pure
        returns (bytes32)
    {
        return
            keccak256(
                abi.encodePacked(CHALLENGE_DOMAIN, SCHEME, walletId, digest)
            );
    }
}
