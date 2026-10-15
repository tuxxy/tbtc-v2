// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

/// @notice Common qualified-custody schema owned by C-05 and consumed by C-04.
/// @dev Separate from the registry FrostWallet ABI. The Bridge owns Storage;
/// funding admission proves wallet identity, funding value/script and inclusion
/// before calling credit. Redemption consumers own proof-backed spend transitions.
library FrostCustody {
    struct Wallet {
        uint64 generation;
        uint64 stateVersion;
        uint64 value;
        bytes32 mainOutpoint;
        bytes32 activeReservation;
        uint64 cancellationExposure;
    }

    struct Output {
        bytes32 walletId;
        uint64 value;
        bool spent;
    }

    struct Storage {
        mapping(bytes32 => Wallet) wallets;
        mapping(bytes32 => Output) outputs;
    }

    uint64 internal constant MAX_SATOSHI = 2100000000000000;

    /// @dev Caller must have validated the full wallet ID and recognized output.
    /// generation is the current uint64 custody intent counter (first credit 0),
    /// never the registry uint32 readiness generation. Credit does not advance it.
    /// No public credit setter exists. Existing outputs, including spent records,
    /// are immutable here. An existing main outpoint is never replaced by credit;
    /// clearing/replacing it requires a separate canonical spend-proof consumer.
    /// During a reservation, additive proven deposits preserve plan generation,
    /// version and main outpoint. The consumer must spend only captured inputs
    /// and subtract their values, retaining all later credited outputs/value.
    function credit(
        Storage storage self,
        bytes32 walletId,
        uint64 generation,
        bytes32 rawTxHash,
        uint32 outputIndex,
        uint64 value
    ) internal returns (bytes32 key) {
        require(walletId != bytes32(0), "FROST custody wallet");
        require(value > 0 && value <= MAX_SATOSHI, "FROST custody value");
        key = outpointKey(rawTxHash, outputIndex);
        require(
            self.outputs[key].walletId == bytes32(0),
            "FROST custody duplicate"
        );
        Wallet storage wallet = self.wallets[walletId];
        bool reserved = wallet.activeReservation != bytes32(0);
        if (reserved) {
            // Deposit-only recognition cannot initialize or replace plan custody.
            require(
                wallet.stateVersion != 0 && wallet.mainOutpoint != bytes32(0),
                "FROST custody reservation state"
            );
        }
        if (wallet.stateVersion == 0) {
            wallet.generation = generation;
            wallet.stateVersion = 1;
        } else {
            require(
                wallet.generation == generation,
                "FROST custody generation"
            );
            // An admitted plan captures its inputs and version. New proven
            // deposits are additional custody, never extra inputs to that plan.
            if (!reserved) wallet.stateVersion += 1;
        }
        require(
            uint256(wallet.value) + value <= MAX_SATOSHI,
            "FROST custody total"
        );
        wallet.value += value;
        if (wallet.mainOutpoint == bytes32(0)) wallet.mainOutpoint = key;
        self.outputs[key] = Output(walletId, value, false);
    }

    /// @dev Raw Bitcoin hash bytes, without display-order reversal; index is
    /// Solidity packed uint32 (four big-endian bytes), not Bitcoin wire encoding.
    function outpointKey(bytes32 rawTxHash, uint32 outputIndex)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(rawTxHash, outputIndex));
    }
}
