// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "./FrostDepositProfile.sol";

/// @notice Only the C-07 subset used by deposit admission; ABI identity is exact.
interface IFrostDepositVerifier {
    function isValidKey(bytes32 key) external view returns (bool);

    function tapTweak(bytes32 internalKey, bytes32 root)
        external
        view
        returns (
            bool valid,
            bytes32 outputKey,
            uint8 parity
        );
}

/// @notice C-05 receipt/accounting storage, additive to all existing Bridge slots.
library FrostFundingState {
    struct Configuration {
        address verifier;
        bytes32 verifierCodeHash;
        bytes32 qualificationRecord;
        bytes32 bitcoinGenesis;
        bool addressesEnabled;
        bool revealEnabled;
    }
    struct Deposit {
        FrostDepositProfile.Terms terms;
        bytes32 receipt;
        bytes32 fundingTransactionHash;
        uint32 fundingOutputIndex;
        bytes32 depositOutputKey;
        bytes32 walletKey;
        bytes32 merkleRoot;
        uint8 outputParity;
        uint64 treasuryFee;
        uint64 maximumSweepFee;
        uint64 revealedAt;
        uint64 sweptAt;
    }
    struct Storage {
        mapping(bytes32 => Deposit) deposits;
        mapping(bytes32 => uint64) pendingReveals;
        Configuration configuration;
        bool entered;
    }
}
