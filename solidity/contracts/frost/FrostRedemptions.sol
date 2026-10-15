// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "./FrostRedemptionState.sol";
import "./FrostRedemptionTransaction.sol";
import "./FrostRedemptionRequests.sol";

/// @notice Linked Bridge consumer for FROST escrow, serialized reservations and proofs.
library FrostRedemptions {
    function enter(BridgeState.Storage storage self) private {
        require(!self.frostFunding.entered, "FROST redemption reentry");
        self.frostFunding.entered = true;
    }

    function leave(BridgeState.Storage storage self) private {
        self.frostFunding.entered = false;
    }

    function liveWallet(BridgeState.Storage storage self, bytes32 id)
        private
        view
        returns (FrostWallets.Wallet storage wallet)
    {
        wallet = self.frost.wallets[bytes20(id)];
        require(
            wallet.id == id &&
                wallet.state == FrostWallets.State.Live &&
                !wallet.quarantined &&
                wallet.capabilityVersion > 0,
            "FROST redemption wallet unavailable"
        );
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

    function reserve(
        BridgeState.Storage storage self,
        FrostRedemptionState.ReservationProposal calldata proposal
    ) external returns (bytes32 id) {
        enter(self);
        require(
            self.frostRedemptions.configuration.enabled,
            "FROST redemptions disabled"
        );
        FrostWallets.Wallet storage wallet = liveWallet(
            self,
            proposal.certificate.walletId
        );
        checkWindow(self, proposal.certificate.validUntilBlock);
        require(
            proposal.certificate.maximumFee <= self.redemptionTxMaxTotalFee,
            "FROST reservation total fee policy"
        );
        for (uint256 i = 0; i < proposal.inputs.length; i++)
            require(
                !self.spentMainUTXOs[
                    uint256(
                        FrostRedemptionLedger.outpointKey(
                            proposal.inputs[i].txHash,
                            proposal.inputs[i].txOutputIndex
                        )
                    )
                ],
                "FROST shared input already consumed"
            );
        FrostRedemptionTransaction.Result
            memory result = FrostRedemptionTransaction.validateRedemption(
                proposal.transaction,
                wallet.descriptor.outputKey,
                proposal.inputs,
                proposal.requests
            );
        FrostRedemptionTransaction.validateFees(
            result,
            proposal.certificate.minimumFee,
            proposal.certificate.maximumFee,
            proposal.certificate.maximumSatPerVByte
        );
        uint256 allocation;
        for (uint256 i = 0; i < proposal.requests.length; i++) {
            FrostRedemptionLedger.Request storage pending = self
                .frostRedemptions
                .ledger
                .requests[proposal.requests[i].id];
            require(
                proposal.requests[i].value <=
                    pending.gross - pending.treasuryFee,
                "FROST payout exceeds captured net"
            );
            allocation +=
                pending.gross -
                pending.treasuryFee -
                proposal.requests[i].value;
            FrostRedemptionState.RequestPolicy storage policy = self
                .frostRedemptions
                .requestPolicies[proposal.requests[i].id];
            // Captured request/deadline timing is required by KC-SF-V3 C-04.
            // solhint-disable-next-line not-rely-on-time
            require(block.timestamp >= policy.notBefore, "FROST request delay");
            if (policy.watchtower != address(0))
                require(
                    IFrostRedemptionWatchtower(policy.watchtower).isAllowed(
                        proposal.requests[i].id,
                        policy.policyId
                    ),
                    "FROST watchtower admission refused"
                );
        }
        require(allocation == result.fee, "FROST fee allocation mismatch");
        FrostSigningIntent.Plan memory plan = FrostSigningIntent.Plan(
            result.snapshot,
            self.frostRedemptions.configuration.bitcoinGenesis,
            proposal.requests
        );
        require(
            FrostReservationCertificate.validate(
                address(this),
                wallet.descriptor,
                proposal.certificate,
                plan,
                proposal.seats,
                proposal.signatures
            ),
            "FROST reservation certificate"
        );
        id = FrostRedemptionLedger.reserve(
            self.frostRedemptions.ledger,
            self.frostCustody,
            proposal.certificate,
            plan,
            result.txHash,
            proposal.inputs,
            proposal.seats,
            proposal.signatures
        );
        leave(self);
    }
}
