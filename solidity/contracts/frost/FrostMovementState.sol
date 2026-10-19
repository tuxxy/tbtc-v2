// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

/// @notice C-06 movement storage, additive to every existing Bridge slot.
/// Incoming moved outputs use the shared `keccak256(txHash ‖ uint32 index)`
/// outpoint key, so one replay space spans the legacy and FROST handlers.
library FrostMovementState {
    enum IncomingState {
        Unknown,
        Pending,
        Escalated,
        Swept
    }

    /// @dev One commitment per MovingFunds period. Targets are ascending
    /// labels; each descriptor hash is the target's immutable descriptor at
    /// commitment, and its label binds the target key Q.
    struct Commitment {
        bytes32 mainOutpoint;
        uint64 committedAt;
        uint64 provenAt;
        bool escalated;
        // Set when another proven spend consumed the committed main.
        bool retired;
        // The movingFundsTxMaxTotalFee in force at commitment: the fee policy
        // this commitment authorizes, for its proof and its C-08 defense.
        uint64 maxFee;
        bytes20[] targets;
        bytes32[] descriptorHashes;
    }

    struct Lifecycle {
        // Commitments are kept per period for defenses; a reopened wallet
        // starts the next period.
        uint32 period;
        uint64 movingFundsRequestedAt;
        uint64 closingStartedAt;
        bool dust;
        // C-09: readiness time (wallet age) and fraud termination time.
        uint64 readyAt;
        uint64 terminatedAt;
    }

    /// @dev `source` is a FROST wallet ID, or a legacy wallet label left-aligned.
    struct Incoming {
        bytes32 target;
        bytes32 source;
        uint64 value;
        uint64 createdAt;
        IncomingState state;
        // K-08: movedFundsSweepTxMaxTotalFee at recording, the incoming
        // output's part of a self-transfer defense's fee cap. Appended last;
        // the struct is a mapping value, so no other slot moves.
        uint64 sweepFeeCap;
    }

    struct Storage {
        // keccak256(walletId ‖ uint32 period) => commitment
        mapping(bytes32 => Commitment) commitments;
        mapping(bytes32 => Lifecycle) lifecycles;
        mapping(bytes32 => Incoming) incoming;
        // Recorded incoming outputs not yet swept, per target wallet ID.
        mapping(bytes32 => uint64) pendingIncoming;
        // Committed but unproven movements naming the target, per wallet ID.
        mapping(bytes32 => uint64) inboundCommitments;
        // FROST targets of a legacy source's drain commitment and their
        // descriptor hashes at commitment, until proven or released by a
        // proven conflicting spend of the legacy main. The legacy commitment
        // hash keeps its legacy format, so legacy validators read it as is.
        mapping(bytes20 => bytes20[]) drainTargets;
        mapping(bytes20 => bytes32[]) drainDescriptorHashes;
        // FROST wallets that may be named by a new commitment.
        uint64 eligibleTargets;
        // Legacy ECDSA sources may commit to FROST targets (G-F gate).
        bool drainEnabled;
    }

    function commitmentKey(bytes32 walletId, uint32 period)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(walletId, period));
    }

    function current(Storage storage self, bytes32 walletId)
        internal
        view
        returns (Commitment storage)
    {
        return
            self.commitments[
                commitmentKey(walletId, self.lifecycles[walletId].period)
            ];
    }
}
