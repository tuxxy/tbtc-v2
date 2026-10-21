// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "./FrostRedemptionTransaction.sol";
import "./FrostCancellationCertificate.sol";
import "./FrostCancellationHistory.sol";
import "./FrostCancellationAdmissions.sol";

/// @notice Fixed linked proof and cancellation consumer; Bridge storage is shared.
library FrostRedemptionSettlement {
    event FrostRedemptionPaid(
        bytes32 indexed reservationId,
        bytes32 transactionHash
    );
    event FrostCancellationAuthorized(
        bytes32 indexed reservationId,
        bytes32 transactionHash,
        uint64 fee,
        address sponsor
    );
    event FrostCancellationConfirmed(
        bytes32 indexed reservationId,
        bytes32 transactionHash
    );

    function enter(BridgeState.Storage storage self) private {
        require(!self.frostFunding.entered, "FROST redemption reentry");
        self.frostFunding.entered = true;
    }

    function leave(BridgeState.Storage storage self) private {
        self.frostFunding.entered = false;
    }

    function paymentRequests(
        FrostRedemptionLedger.Storage storage ledger,
        FrostRedemptionLedger.Intent storage intent
    ) private view returns (FrostSigningIntent.Request[] memory requests) {
        requests = new FrostSigningIntent.Request[](intent.requestIds.length);
        for (uint256 i = 0; i < requests.length; i++)
            requests[i] = FrostSigningIntent.Request(
                intent.requestIds[i],
                intent.payouts[i],
                ledger.requests[intent.requestIds[i]].script
            );
    }

    function consumeSharedInputs(
        BridgeState.Storage storage self,
        FrostRedemptionLedger.Intent storage intent
    ) private {
        for (uint256 i = 0; i < intent.inputs.length; i++) {
            uint256 key = uint256(
                FrostRedemptionLedger.outpointKey(
                    intent.inputs[i].txHash,
                    intent.inputs[i].txOutputIndex
                )
            );
            require(
                !self.spentMainUTXOs[key],
                "FROST shared input already consumed"
            );
            self.spentMainUTXOs[key] = true;
        }
    }

    function refundResolved(BridgeState.Storage storage self, bytes32 requestId)
        external
    {
        enter(self);
        FrostRedemptionLedger.refundResolved(
            self.frostRedemptions.ledger,
            self.bank,
            requestId
        );
        leave(self);
    }

    function claimCancellationBudget(
        BridgeState.Storage storage self,
        bytes32 id,
        bytes32 transactionHash
    ) external {
        FrostCancellationAdmissions.claimCancellationBudget(
            self,
            id,
            transactionHash
        );
    }

    function submitPayment(
        BridgeState.Storage storage self,
        bytes32 id,
        BitcoinTx.Info calldata transaction,
        BitcoinTx.Proof calldata proof
    ) external {
        enter(self);
        FrostRedemptionLedger.Intent storage intent = self
            .frostRedemptions
            .ledger
            .intents[id];
        require(
            FrostRedemptionLedger.unresolved(intent),
            "FROST payment intent state"
        );
        FrostWallets.Wallet storage wallet = self.frost.wallets[
            bytes20(intent.certificate.walletId)
        ];
        FrostRedemptionTransaction.Result
            memory result = FrostRedemptionTransaction.validateRedemption(
                transaction,
                wallet.descriptor.outputKey,
                intent.inputs,
                paymentRequests(self.frostRedemptions.ledger, intent)
            );
        require(
            result.txHash == intent.transactionHash &&
                result.snapshot == intent.snapshot,
            "FROST payment changed intent"
        );
        require(
            BitcoinTx.validateProof(self, transaction, proof) == result.txHash,
            "FROST payment proof identity"
        );
        consumeSharedInputs(self, intent);
        if (intent.cancellationFee > 0) {
            FrostCancellationHistory.recordFirstReturn(
                self.frostRedemptions.cancellationHistory,
                intent,
                id
            );
        }
        FrostRedemptionLedger.pay(
            self.frostRedemptions.ledger,
            self.frostCustody,
            self.bank,
            self.treasury,
            id,
            result.changeValue,
            result.changeIndex
        );
        emit FrostRedemptionPaid(id, result.txHash);
        leave(self);
    }

    function authorizeCancellation(
        BridgeState.Storage storage self,
        FrostCancellationCertificate.Authorization calldata authorization,
        BitcoinTx.Info calldata transaction,
        uint16[] calldata seats,
        bytes calldata signatures
    ) external {
        FrostCancellationAdmissions.authorizeCancellation(
            self,
            authorization,
            transaction,
            seats,
            signatures
        );
    }

    function submitCancellation(
        BridgeState.Storage storage self,
        bytes32 id,
        BitcoinTx.Info calldata transaction,
        BitcoinTx.Proof calldata proof
    ) external {
        enter(self);
        FrostRedemptionLedger.Intent storage intent = self
            .frostRedemptions
            .ledger
            .intents[id];
        require(
            FrostRedemptionLedger.unresolved(intent) &&
                intent.cancellationHash != bytes32(0),
            "FROST cancellation intent state"
        );
        FrostWallets.Wallet storage wallet = self.frost.wallets[
            bytes20(intent.certificate.walletId)
        ];
        FrostRedemptionTransaction.Result
            memory result = FrostRedemptionTransaction.validateCancellation(
                transaction,
                wallet.descriptor.outputKey,
                intent.inputs
            );
        FrostCancellationHistory.Record
            memory selected = FrostCancellationHistory.get(
                self.frostRedemptions.cancellationHistory,
                intent,
                id,
                result.txHash
            );
        require(
            result.snapshot == selected.snapshot && result.fee == selected.fee,
            "FROST cancellation changed intent"
        );
        require(
            BitcoinTx.validateProof(self, transaction, proof) == result.txHash,
            "FROST cancellation proof identity"
        );
        consumeSharedInputs(self, intent);
        FrostCancellationHistory.recordWinner(
            self.frostRedemptions.cancellationHistory,
            intent,
            id,
            result.txHash
        );
        FrostRedemptionLedger.cancelSelected(
            self.frostRedemptions.ledger,
            self.frostCustody,
            self.bank,
            id,
            result.txHash,
            result.fee,
            result.changeValue,
            result.changeIndex
        );
        emit FrostCancellationConfirmed(id, result.txHash);
        leave(self);
    }
}
