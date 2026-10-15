// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "./FrostRedemptionLedger.sol";

/// @notice Cancellation alternatives and their independently funded budgets.
/// @dev The first cancellation remains in Intent. Callers authenticate each
/// transaction, enforce the captured fee envelope, and fund its entire budget.
/// This library neither transfers Bank balances nor proves a Bitcoin spend.
library FrostCancellationHistory {
    struct Record {
        bytes32 transactionHash;
        bytes32 snapshot;
        uint64 fee;
        address sponsor;
        uint64 admittedBlock;
        uint64 validUntilBlock;
        uint16[] seats;
        bytes signatures;
        bool budgetSettled;
    }

    struct History {
        bytes32[] extraHashes;
        mapping(bytes32 => Record) extras;
        uint64 maximumFee;
        bytes32 winningHash;
        bool firstBudgetSettled;
    }

    struct Storage {
        mapping(bytes32 => History) histories;
    }

    function count(
        Storage storage self,
        FrostRedemptionLedger.Intent storage intent,
        bytes32 id
    ) internal view returns (uint256) {
        return
            self.histories[id].extraHashes.length +
            (intent.cancellationHash == bytes32(0) ? 0 : 1);
    }

    function at(
        Storage storage self,
        FrostRedemptionLedger.Intent storage intent,
        bytes32 id,
        uint256 index
    ) internal view returns (bytes32) {
        if (intent.cancellationHash != bytes32(0)) {
            if (index == 0) return intent.cancellationHash;
            index -= 1;
        }
        require(
            index < self.histories[id].extraHashes.length,
            "FROST cancellation history index"
        );
        return self.histories[id].extraHashes[index];
    }

    function maximumFee(
        Storage storage self,
        FrostRedemptionLedger.Intent storage intent,
        bytes32 id
    ) internal view returns (uint64) {
        uint64 recorded = self.histories[id].maximumFee;
        return
            recorded > intent.cancellationFee
                ? recorded
                : intent.cancellationFee;
    }

    function get(
        Storage storage self,
        FrostRedemptionLedger.Intent storage intent,
        bytes32 id,
        bytes32 hash
    ) internal view returns (Record memory approval) {
        History storage history = self.histories[id];
        require(known(history, intent, hash), "FROST cancellation unknown");
        if (hash == intent.cancellationHash) {
            approval = Record({
                transactionHash: intent.cancellationHash,
                snapshot: intent.cancellationSnapshot,
                fee: intent.cancellationFee,
                sponsor: intent.cancellationSponsor,
                admittedBlock: intent.cancellationAdmittedBlock,
                validUntilBlock: intent.cancellationValidUntilBlock,
                seats: intent.cancellationSeats,
                signatures: intent.cancellationSignatures,
                budgetSettled: firstSettled(history, intent)
            });
        } else {
            approval = history.extras[hash];
        }
    }

    function append(
        Storage storage self,
        FrostRedemptionLedger.Intent storage intent,
        bytes32 id,
        Record memory approval
    ) internal {
        History storage history = self.histories[id];
        require(
            FrostRedemptionLedger.unresolved(intent) &&
                history.winningHash == bytes32(0),
            "FROST cancellation history state"
        );
        require(
            approval.transactionHash != bytes32(0) &&
                !known(history, intent, approval.transactionHash),
            "FROST cancellation history duplicate"
        );
        require(
            approval.fee > maximumFee(self, intent, id) &&
                approval.sponsor != address(0) &&
                !approval.budgetSettled,
            "FROST cancellation history budget"
        );
        if (intent.cancellationHash == bytes32(0)) {
            intent.cancellationHash = approval.transactionHash;
            intent.cancellationSnapshot = approval.snapshot;
            intent.cancellationFee = approval.fee;
            intent.cancellationSponsor = approval.sponsor;
            intent.cancellationAdmittedBlock = approval.admittedBlock;
            intent.cancellationValidUntilBlock = approval.validUntilBlock;
            intent.cancellationSeats = approval.seats;
            intent.cancellationSignatures = approval.signatures;
        } else {
            history.extras[approval.transactionHash] = approval;
            history.extraHashes.push(approval.transactionHash);
        }
        history.maximumFee = approval.fee;
    }

    /// @dev Record the proven winner before terminal cancellation settlement.
    /// Otherwise a legacy Cancelled record could be reinterpreted to reopen a
    /// first budget that was already burned. Caller performs the actual burn.
    function recordWinner(
        Storage storage self,
        FrostRedemptionLedger.Intent storage intent,
        bytes32 id,
        bytes32 hash
    ) internal {
        History storage history = self.histories[id];
        require(
            FrostRedemptionLedger.unresolved(intent) &&
                history.winningHash == bytes32(0),
            "FROST cancellation winner state"
        );
        require(known(history, intent, hash), "FROST cancellation unknown");
        if (hash == intent.cancellationHash) {
            require(
                !firstSettled(history, intent),
                "FROST cancellation budget settled"
            );
            history.firstBudgetSettled = true;
        } else {
            require(
                !history.extras[hash].budgetSettled,
                "FROST cancellation budget settled"
            );
            history.extras[hash].budgetSettled = true;
        }
        history.winningHash = hash;
    }

    /// @dev Mark the existing first-budget automatic return; no Bank action.
    function recordFirstReturn(
        Storage storage self,
        FrostRedemptionLedger.Intent storage intent,
        bytes32 id
    ) internal {
        require(
            intent.cancellationHash != bytes32(0),
            "FROST cancellation unknown"
        );
        self.histories[id].firstBudgetSettled = true;
    }

    /// @dev The guarded caller transfers this entire budget to the returned
    /// sponsor. The marker precedes that external action; a failure must revert
    /// the whole caller transaction. No certificate or history traversal occurs.
    function takeRefund(
        Storage storage self,
        FrostRedemptionLedger.Intent storage intent,
        bytes32 id,
        bytes32 hash
    ) internal returns (address sponsor, uint64 fee) {
        require(
            intent.state == FrostRedemptionLedger.IntentState.Paid ||
                intent.state == FrostRedemptionLedger.IntentState.Cancelled ||
                intent.state ==
                FrostRedemptionLedger.IntentState.ConflictResolved,
            "FROST cancellation refund state"
        );
        History storage history = self.histories[id];
        require(known(history, intent, hash), "FROST cancellation unknown");
        require(
            hash != history.winningHash,
            "FROST cancellation winning budget"
        );
        if (hash == intent.cancellationHash) {
            require(
                !firstSettled(history, intent),
                "FROST cancellation budget settled"
            );
            history.firstBudgetSettled = true;
            return (intent.cancellationSponsor, intent.cancellationFee);
        }
        Record storage approval = history.extras[hash];
        require(!approval.budgetSettled, "FROST cancellation budget settled");
        approval.budgetSettled = true;
        return (approval.sponsor, approval.fee);
    }

    function known(
        History storage history,
        FrostRedemptionLedger.Intent storage intent,
        bytes32 hash
    ) private view returns (bool) {
        return
            hash != bytes32(0) &&
            (hash == intent.cancellationHash ||
                history.extras[hash].transactionHash == hash);
    }

    /// @dev Old payment/sweep settlement returned the first budget, and old
    /// cancellation burned it. No migration writes are needed for those records.
    /// A recorded different winner leaves the first budget collectible unless
    /// its explicit marker says that it has already been returned.
    function firstSettled(
        History storage history,
        FrostRedemptionLedger.Intent storage intent
    ) private view returns (bool) {
        return
            history.firstBudgetSettled ||
            intent.state == FrostRedemptionLedger.IntentState.Paid ||
            intent.state ==
            FrostRedemptionLedger.IntentState.ConflictResolved ||
            (intent.state == FrostRedemptionLedger.IntentState.Cancelled &&
                (history.winningHash == bytes32(0) ||
                    history.winningHash == intent.cancellationHash));
    }
}
