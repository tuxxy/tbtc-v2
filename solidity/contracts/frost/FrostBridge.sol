// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "./IFrostBridge.sol";
import "./FrostWallets.sol";
import "./FrostFundingConfiguration.sol";
import "./FrostRedemptions.sol";
import "./FrostRedemptionSettlement.sol";
import "./FrostRedemptionRequests.sol";

interface IFrostGovernance {
    function governance() external view returns (address);
}

/// @notice Fixed-selector extension linked into the Bridge bytecode. There is
/// no user-supplied delegate target. All state stays in BridgeState's new slots.
library FrostBridge {
    function dispatch(BridgeState.Storage storage self, bytes calldata input)
        external
        returns (bytes memory)
    {
        require(input.length >= 4, "FROST selector");
        bytes4 selector = bytes4(input[:4]);
        bytes calldata args = input[4:];
        if (selector == IFrostFundingBridge.frostCustodyOutput.selector) {
            return
                abi.encode(
                    self.frostCustody.outputs[abi.decode(args, (bytes32))]
                );
        } else if (
            selector == IFrostFundingBridge.configureFrostFunding.selector
        ) {
            require(
                msg.sender == IFrostGovernance(address(this)).governance(),
                "Caller is not governance"
            );
            (
                address verifier,
                bytes32 runtimeHash,
                bytes32 record,
                bytes32 genesis
            ) = abi.decode(args, (address, bytes32, bytes32, bytes32));
            FrostFundingConfiguration.install(
                self.frostFunding,
                verifier,
                runtimeHash,
                record,
                genesis
            );
        } else if (
            selector == IFrostFundingBridge.setFrostFundingGates.selector
        ) {
            require(
                msg.sender == IFrostGovernance(address(this)).governance(),
                "Caller is not governance"
            );
            (bool addressesEnabled, bool revealEnabled) = abi.decode(
                args,
                (bool, bool)
            );
            FrostFundingConfiguration.setGates(
                self.frostFunding,
                addressesEnabled,
                revealEnabled
            );
        } else if (
            selector == IFrostFundingBridge.frostDepositConstruction.selector
        ) {
            return
                abi.encode(
                    FrostDepositAdmission.construction(
                        self,
                        self.frostFunding,
                        abi.decode(args, (FrostDepositProfile.Terms))
                    )
                );
        } else if (
            selector ==
            IFrostFundingBridge.frostDepositRefundConstruction.selector
        ) {
            return
                abi.encode(
                    FrostDepositAdmission.refundConstruction(
                        self.frostFunding,
                        abi.decode(args, (bytes32))
                    )
                );
        } else if (
            selector == IFrostFundingBridge.frostDepositOutput.selector
        ) {
            return
                abi.encode(
                    FrostDepositAdmission.output(
                        self,
                        self.frostFunding,
                        abi.decode(args, (FrostDepositProfile.Terms))
                    )
                );
        } else if (
            selector == IFrostFundingBridge.revealFrostDeposit.selector
        ) {
            (
                FrostDepositProfile.Terms memory terms,
                BitcoinTx.Info memory transaction,
                uint32 index
            ) = abi.decode(
                    args,
                    (FrostDepositProfile.Terms, BitcoinTx.Info, uint32)
                );
            return
                abi.encode(
                    FrostDepositAdmission.reveal(
                        self,
                        self.frostFunding,
                        terms,
                        transaction,
                        index
                    )
                );
        } else if (
            selector ==
            IFrostFundingBridge.submitFrostDepositSweepProof.selector
        ) {
            require(
                self.isSpvMaintainer[msg.sender],
                "Caller is not SPV maintainer"
            );
            FrostDepositSweep.prove(
                self,
                self.frostFunding,
                self.frostCustody,
                abi.decode(args, (FrostDepositSweep.Sweep))
            );
        } else if (selector == IFrostFundingBridge.frostDeposit.selector) {
            return
                abi.encode(
                    abi.encode(
                        self.frostFunding.deposits[abi.decode(args, (bytes32))]
                    )
                );
        } else if (
            selector == IFrostBridge.configureFrostRedemptions.selector
        ) {
            require(
                msg.sender == IFrostGovernance(address(this)).governance(),
                "Caller is not governance"
            );
            (
                bytes32 genesis,
                uint64 finalityBlocks,
                uint64 maximumCertificateBlocks,
                address watchtower,
                bytes32 evidence
            ) = abi.decode(args, (bytes32, uint64, uint64, address, bytes32));
            FrostRedemptionRequests.configure(
                self,
                genesis,
                finalityBlocks,
                maximumCertificateBlocks,
                watchtower,
                evidence
            );
        } else if (
            selector == IFrostBridge.setFrostRedemptionsEnabled.selector
        ) {
            require(
                msg.sender == IFrostGovernance(address(this)).governance(),
                "Caller is not governance"
            );
            FrostRedemptionRequests.setEnabled(self, abi.decode(args, (bool)));
        } else if (selector == IFrostBridge.requestFrostRedemption.selector) {
            (
                bytes32 id,
                bytes memory script,
                uint64 gross,
                address redeemer
            ) = abi.decode(args, (bytes32, bytes, uint64, address));
            return
                abi.encode(
                    FrostRedemptionRequests.request(
                        self,
                        id,
                        script,
                        gross,
                        redeemer
                    )
                );
        } else if (selector == IFrostBridge.quarantineFrostWallet.selector) {
            require(
                msg.sender == IFrostGovernance(address(this)).governance(),
                "Caller is not governance"
            );
            (bytes32 id, uint64 version, bytes32 reason, bytes32 evidence) = abi
                .decode(args, (bytes32, uint64, bytes32, bytes32));
            FrostRedemptionRequests.quarantine(
                self,
                id,
                version,
                reason,
                evidence
            );
        } else if (selector == IFrostBridge.frostWalletQuarantine.selector) {
            (bytes32 id, uint64 version) = abi.decode(args, (bytes32, uint64));
            return abi.encode(self.frostRedemptions.quarantines[id][version]);
        } else if (selector == IFrostBridge.reserveFrostRedemption.selector) {
            FrostRedemptionState.ReservationProposal memory proposal = abi
                .decode(args, (FrostRedemptionState.ReservationProposal));
            return abi.encode(FrostRedemptions.reserve(self, proposal));
        } else if (
            selector == IFrostBridge.submitFrostRedemptionProof.selector ||
            selector == IFrostBridge.submitFrostCancellationProof.selector
        ) {
            require(
                self.isSpvMaintainer[msg.sender],
                "Caller is not SPV maintainer"
            );
            (
                bytes32 id,
                BitcoinTx.Info memory transaction,
                BitcoinTx.Proof memory proof
            ) = abi.decode(args, (bytes32, BitcoinTx.Info, BitcoinTx.Proof));
            if (selector == IFrostBridge.submitFrostRedemptionProof.selector)
                FrostRedemptionSettlement.submitPayment(
                    self,
                    id,
                    transaction,
                    proof
                );
            else
                FrostRedemptionSettlement.submitCancellation(
                    self,
                    id,
                    transaction,
                    proof
                );
        } else if (
            selector == IFrostBridge.authorizeFrostCancellation.selector
        ) {
            (
                FrostCancellationCertificate.Authorization memory authorization,
                BitcoinTx.Info memory transaction,
                uint16[] memory seats,
                bytes memory signatures
            ) = abi.decode(
                    args,
                    (
                        FrostCancellationCertificate.Authorization,
                        BitcoinTx.Info,
                        uint16[],
                        bytes
                    )
                );
            FrostRedemptionSettlement.authorizeCancellation(
                self,
                authorization,
                transaction,
                seats,
                signatures
            );
        } else if (
            selector == IFrostBridge.notifyFrostRedemptionTimeout.selector
        ) {
            FrostRedemptionRequests.observeTimeout(
                self,
                abi.decode(args, (bytes32))
            );
        } else if (
            selector == IFrostBridge.refundUnreservedFrostRedemption.selector
        ) {
            FrostRedemptionRequests.refundUnreserved(
                self,
                abi.decode(args, (bytes32))
            );
        } else if (
            selector == IFrostBridge.frostRedemptionConfiguration.selector
        ) {
            return abi.encode(self.frostRedemptions.configuration);
        } else if (selector == IFrostBridge.frostRedemptionRequest.selector) {
            return
                abi.encode(
                    self.frostRedemptions.ledger.requests[
                        abi.decode(args, (bytes32))
                    ]
                );
        } else if (selector == IFrostBridge.frostRedemptionPolicy.selector) {
            return
                abi.encode(
                    self.frostRedemptions.requestPolicies[
                        abi.decode(args, (bytes32))
                    ]
                );
        } else if (selector == IFrostBridge.frostReservation.selector) {
            return
                abi.encode(
                    self.frostRedemptions.ledger.intents[
                        abi.decode(args, (bytes32))
                    ]
                );
        } else if (selector == IFrostBridge.frostWalletCustody.selector) {
            return
                abi.encode(
                    self.frostCustody.wallets[abi.decode(args, (bytes32))]
                );
        } else if (selector == IFrostBridge.frostRedemptionEscrow.selector) {
            bytes32 id = abi.decode(args, (bytes32));
            return
                abi.encode(
                    self.frostRedemptions.ledger.escrow[id],
                    self.frostRedemptions.ledger.netLiability[id]
                );
        } else if (selector == IFrostBridge.configureFrostRegistry.selector) {
            require(
                msg.sender == IFrostGovernance(address(this)).governance(),
                "Caller is not governance"
            );
            FrostWallets.configure(self.frost, abi.decode(args, (address)));
        } else if (selector == IFrostBridge.setFrostRequestsEnabled.selector) {
            require(
                msg.sender == IFrostGovernance(address(this)).governance(),
                "Caller is not governance"
            );
            FrostWallets.setRequestsEnabled(
                self.frost,
                abi.decode(args, (bool))
            );
        } else if (selector == IFrostBridge.requestNewFrostWallet.selector) {
            FrostWallets.request(self.frost);
        } else if (selector == IFrostBridge.__snowfallWalletCreated.selector) {
            (bytes memory descriptor, uint64 deadline) = abi.decode(
                args,
                (bytes, uint64)
            );
            bytes20 label = FrostWallets.descriptorLabel(descriptor);
            FrostWallets.register(
                self.frost,
                descriptor,
                deadline,
                self.registeredWallets[label].state !=
                    Wallets.WalletState.Unknown
            );
        } else if (selector == IFrostBridge.__snowfallWalletReady.selector) {
            (
                bytes32 id,
                bytes32 descriptorHash,
                uint32 generation,
                uint32 capabilityVersion
            ) = abi.decode(args, (bytes32, bytes32, uint32, uint32));
            FrostWallets.ready(
                self.frost,
                id,
                descriptorHash,
                generation,
                capabilityVersion
            );
        } else if (selector == IFrostBridge.__snowfallWalletExpired.selector) {
            FrostWallets.expire(self.frost, abi.decode(args, (bytes32)));
        } else if (selector == IFrostBridge.frostRegistry.selector) {
            return abi.encode(self.frost.registry);
        } else if (selector == IFrostBridge.walletScheme.selector) {
            bytes20 label = abi.decode(args, (bytes20));
            return
                abi.encode(
                    self.registeredWallets[label].state !=
                        Wallets.WalletState.Unknown
                        ? uint8(1)
                        : self.frost.wallets[label].descriptor.scheme
                );
        } else if (selector == IFrostBridge.walletDescriptor.selector) {
            return
                abi.encode(
                    FrostWallets.descriptorBytes(
                        self.frost,
                        abi.decode(args, (bytes20))
                    )
                );
        } else if (selector == IFrostBridge.resolveWallet.selector) {
            (address registry, bytes32 id) = abi.decode(
                args,
                (address, bytes32)
            );
            return abi.encode(self.frost.identities[registry][id]);
        } else if (selector == IFrostBridge.resolveWalletOutput.selector) {
            return
                abi.encode(self.frost.outputKeys[abi.decode(args, (bytes32))]);
        } else if (selector == IFrostBridge.resolveFrostOutputScript.selector) {
            return
                abi.encode(
                    FrostWallets.resolveOutput(
                        self.frost,
                        abi.decode(args, (bytes))
                    )
                );
        } else if (selector == IFrostBridge.isFrostFundingTarget.selector) {
            FrostWallets.Wallet storage w = self.frost.wallets[
                abi.decode(args, (bytes20))
            ];
            return
                abi.encode(
                    w.state == FrostWallets.State.Live && !w.quarantined
                );
        } else {
            revert("FROST unknown selector");
        }
        return bytes("");
    }
}
