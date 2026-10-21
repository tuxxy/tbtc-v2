// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../frost/FrostCancellationHistory.sol";

/// @dev Synthetic history unit fixture only. No Bank balances, funded custody,
/// operator authentication, signatures, SPV or production lifecycle are proved.
contract FrostCancellationHistoryFixture {
    address private immutable owner = msg.sender;
    FrostRedemptionLedger.Storage private ledger;
    FrostCancellationHistory.Storage private history;
    mapping(bytes32 => bool) private initialized;

    modifier onlyOwner() {
        require(msg.sender == owner, "Fixture owner only");
        _;
    }

    /// @dev Write only old Intent fields. In particular, do NOT append through
    /// History or initialize a maximum, winner or first-budget settlement marker.
    function initializeLegacyForTest(
        bytes32 id,
        FrostRedemptionLedger.IntentState state,
        FrostCancellationHistory.Record calldata first
    ) external onlyOwner {
        require(
            id != bytes32(0) && !initialized[id],
            "Fixture already initialized"
        );
        require(
            state != FrostRedemptionLedger.IntentState.Unknown,
            "Fixture state"
        );
        require(!first.budgetSettled, "Fixture first marker");
        initialized[id] = true;
        FrostRedemptionLedger.Intent storage intent = ledger.intents[id];
        intent.state = state;
        intent.cancellationHash = first.transactionHash;
        intent.cancellationSnapshot = first.snapshot;
        intent.cancellationFee = first.fee;
        intent.cancellationSponsor = first.sponsor;
        intent.cancellationAdmittedBlock = first.admittedBlock;
        intent.cancellationValidUntilBlock = first.validUntilBlock;
        intent.cancellationSeats = first.seats;
        intent.cancellationSignatures = first.signatures;
    }

    function setStateForTest(
        bytes32 id,
        FrostRedemptionLedger.IntentState state
    ) external onlyOwner {
        require(initialized[id], "Fixture not initialized");
        ledger.intents[id].state = state;
    }

    function appendForTest(
        bytes32 id,
        FrostCancellationHistory.Record calldata approval
    ) external onlyOwner {
        FrostCancellationHistory.append(
            history,
            ledger.intents[id],
            id,
            approval
        );
    }

    function recordWinnerForTest(bytes32 id, bytes32 hash) external onlyOwner {
        FrostCancellationHistory.recordWinner(
            history,
            ledger.intents[id],
            id,
            hash
        );
    }

    function recordFirstReturnForTest(bytes32 id) external onlyOwner {
        FrostCancellationHistory.recordFirstReturn(
            history,
            ledger.intents[id],
            id
        );
    }

    /// @dev Returns and consumes budget metadata only; there is no Bank transfer.
    function takeRefundForTest(bytes32 id, bytes32 hash)
        external
        onlyOwner
        returns (address sponsor, uint64 fee)
    {
        return
            FrostCancellationHistory.takeRefund(
                history,
                ledger.intents[id],
                id,
                hash
            );
    }

    function getIntent(bytes32 id)
        external
        view
        returns (FrostRedemptionLedger.Intent memory)
    {
        return ledger.intents[id];
    }

    function rawHistory(bytes32 id)
        external
        view
        returns (
            uint256 extraCount,
            uint64 maximumFee,
            bytes32 winningHash,
            bool firstBudgetSettled
        )
    {
        FrostCancellationHistory.History storage stored = history.histories[id];
        return (
            stored.extraHashes.length,
            stored.maximumFee,
            stored.winningHash,
            stored.firstBudgetSettled
        );
    }

    function count(bytes32 id) external view returns (uint256) {
        return FrostCancellationHistory.count(history, ledger.intents[id], id);
    }

    function at(bytes32 id, uint256 index) external view returns (bytes32) {
        return
            FrostCancellationHistory.at(history, ledger.intents[id], id, index);
    }

    function maximumFee(bytes32 id) external view returns (uint64) {
        return
            FrostCancellationHistory.maximumFee(
                history,
                ledger.intents[id],
                id
            );
    }

    function get(bytes32 id, bytes32 hash)
        external
        view
        returns (FrostCancellationHistory.Record memory)
    {
        return
            FrostCancellationHistory.get(history, ledger.intents[id], id, hash);
    }
}
