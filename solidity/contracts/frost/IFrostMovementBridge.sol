// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BitcoinTx.sol";
import "./FrostMovementState.sol";

/// @notice C-06 movement entrypoints of the Bridge's FROST extension.
interface IFrostMovementBridge {
    event FrostMovingFundsCommitted(
        bytes32 indexed walletId,
        uint32 period,
        bytes32 mainOutpoint,
        bytes20[] targets,
        bytes32[] descriptorHashes
    );
    event FrostMovingFundsCompleted(
        bytes32 indexed walletId,
        bytes32 indexed transactionHash
    );
    event FrostIncomingRecorded(
        bytes32 indexed outpoint,
        bytes32 indexed target,
        bytes32 source,
        uint64 value,
        bytes32 transactionHash,
        uint32 outputIndex
    );
    event FrostMovedFundsSwept(
        bytes32 indexed walletId,
        bytes32 indexed transactionHash,
        uint64 value
    );
    event FrostMovingFundsEscalated(bytes32 indexed walletId);
    event FrostMovingFundsTimeoutReset(bytes32 indexed walletId);
    event FrostIncomingEscalated(bytes32 indexed outpoint);
    event FrostMovingFundsBelowDust(bytes32 indexed walletId, uint64 value);
    event FrostWalletReopened(bytes32 indexed walletId);
    event FrostDepositExpired(bytes32 indexed depositKey);

    function submitFrostMovingFundsCommitment(
        bytes32 walletId,
        uint16 seat,
        bytes20[] calldata targets
    ) external;

    function submitFrostMovingFundsProof(
        bytes32 walletId,
        BitcoinTx.Info calldata transaction,
        BitcoinTx.Proof calldata proof
    ) external;

    function submitFrostMovedFundsSweepProof(
        bytes32 walletId,
        BitcoinTx.Info calldata transaction,
        BitcoinTx.Proof calldata proof
    ) external;

    function notifyFrostMovingFundsTimeout(bytes32 walletId) external;

    function resetFrostMovingFundsTimeout(bytes32 walletId) external;

    function notifyFrostMovedFundsSweepTimeout(bytes32 outpoint) external;

    function notifyFrostMovingFundsBelowDust(bytes32 walletId) external;

    function notifyFrostDepositExpired(bytes32 depositKey) external;

    function frostMovingFundsCommitment(bytes32 walletId, uint32 period)
        external
        view
        returns (FrostMovementState.Commitment memory);

    function frostWalletLifecycle(bytes32 walletId)
        external
        view
        returns (FrostMovementState.Lifecycle memory);

    function frostIncoming(bytes32 outpoint)
        external
        view
        returns (FrostMovementState.Incoming memory);

    function frostMovementCounters(bytes32 walletId)
        external
        view
        returns (
            uint64 pendingIncoming,
            uint64 inboundCommitments,
            uint64 eligibleTargets
        );
}
