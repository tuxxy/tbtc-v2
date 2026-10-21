// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "./FrostRedemptionTransaction.sol";
import "./FrostCancellationCertificate.sol";
import "./FrostCancellationHistory.sol";

/// @notice Fixed linked admission and individual sponsor-budget collection.
library FrostCancellationAdmissions {
    event FrostCancellationAuthorized(
        bytes32 indexed reservationId,
        bytes32 transactionHash,
        uint64 fee,
        address sponsor
    );

    function enter(BridgeState.Storage storage self) private {
        require(!self.frostFunding.entered, "FROST redemption reentry");
        self.frostFunding.entered = true;
    }

    function leave(BridgeState.Storage storage self) private {
        self.frostFunding.entered = false;
    }

    function checkWindow(BridgeState.Storage storage self, uint64 validUntil)
        private
        view
    {
        require(
            validUntil >= block.number &&
                uint256(validUntil) <=
                block.number +
                    self
                        .frostRedemptions
                        .configuration
                        .maximumCertificateBlocks,
            "FROST certificate window"
        );
    }

    function authorizeCancellation(
        BridgeState.Storage storage self,
        FrostCancellationCertificate.Authorization calldata authorization,
        BitcoinTx.Info calldata transaction,
        uint16[] calldata seats,
        bytes calldata signatures
    ) external {
        enter(self);
        FrostRedemptionLedger.Intent storage intent = self
            .frostRedemptions
            .ledger
            .intents[authorization.reservationId];
        require(
            FrostRedemptionLedger.unresolved(intent),
            "FROST cancellation intent state"
        );
        FrostWallets.Wallet storage wallet = self.frost.wallets[
            bytes20(intent.certificate.walletId)
        ];
        checkWindow(self, authorization.validUntilBlock);
        FrostRedemptionTransaction.Result
            memory result = FrostRedemptionTransaction.validateCancellation(
                transaction,
                wallet.descriptor.outputKey,
                intent.inputs
            );
        FrostRedemptionTransaction.validateFees(
            result,
            intent.certificate.minimumFee,
            intent.certificate.maximumFee,
            intent.certificate.maximumSatPerVByte
        );
        require(
            result.txHash == authorization.transactionHash &&
                result.snapshot == authorization.snapshot &&
                result.fee == authorization.fee,
            "FROST cancellation changed intent"
        );
        require(
            result.fee >
                FrostCancellationHistory.maximumFee(
                    self.frostRedemptions.cancellationHistory,
                    intent,
                    authorization.reservationId
                ),
            "FROST cancellation fee not increased"
        );
        self
            .frostCustody
            .wallets[intent.certificate.walletId]
            .cancellationExposure = FrostRedemptionLedger
            .cancellationExposureFor(
                self.frostRedemptions.ledger,
                self.frostCustody,
                authorization.reservationId,
                result.fee
            );
        require(
            FrostCancellationCertificate.validate(
                address(this),
                wallet.descriptor,
                authorization,
                seats,
                signatures
            ),
            "FROST cancellation certificate"
        );
        require(
            block.number <= type(uint64).max,
            "FROST cancellation block overflow"
        );
        FrostCancellationHistory.Record memory admitted;
        admitted.transactionHash = result.txHash;
        admitted.snapshot = result.snapshot;
        admitted.fee = result.fee;
        admitted.sponsor = msg.sender;
        admitted.admittedBlock = uint64(block.number);
        admitted.validUntilBlock = authorization.validUntilBlock;
        admitted.seats = seats;
        admitted.signatures = signatures;
        FrostCancellationHistory.append(
            self.frostRedemptions.cancellationHistory,
            intent,
            authorization.reservationId,
            admitted
        );
        self.bank.transferBalanceFrom(msg.sender, address(this), result.fee);
        emit FrostCancellationAuthorized(
            authorization.reservationId,
            result.txHash,
            result.fee,
            msg.sender
        );
        leave(self);
    }

    event FrostCancellationBudgetReturned(
        bytes32 indexed reservationId,
        bytes32 indexed transactionHash,
        address sponsor,
        uint64 fee
    );

    function claimCancellationBudget(
        BridgeState.Storage storage self,
        bytes32 id,
        bytes32 transactionHash
    ) external {
        enter(self);
        (address sponsor, uint64 fee) = FrostCancellationHistory.takeRefund(
            self.frostRedemptions.cancellationHistory,
            self.frostRedemptions.ledger.intents[id],
            id,
            transactionHash
        );
        self.bank.transferBalance(sponsor, fee);
        emit FrostCancellationBudgetReturned(id, transactionHash, sponsor, fee);
        leave(self);
    }
}
