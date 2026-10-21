// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";

/// @notice Versioned policy adapter; legacy watchtower keys are never repurposed.
interface IFrostRedemptionWatchtower {
    function requestPolicy(
        bytes32 walletId,
        bytes calldata script,
        address balanceOwner,
        address redeemer,
        uint64 gross
    )
        external
        view
        returns (
            bool allowed,
            bytes32 policyId,
            uint64 delaySeconds
        );

    function isAllowed(bytes32 requestId, bytes32 policyId)
        external
        view
        returns (bool);
}

/// @notice Fixed linked FROST request escrow and recovery entrypoints.
library FrostRedemptionRequests {
    event FrostRedemptionsConfigured(
        bytes32 genesis,
        uint64 finalityBlocks,
        uint64 maximumCertificateBlocks,
        address watchtower,
        bytes32 legacyTransitionEvidence
    );
    event FrostRedemptionsEnabled(bool enabled);
    event FrostWalletQuarantined(
        bytes32 indexed walletId,
        bytes32 indexed reservationId,
        uint64 stateVersion,
        bytes32 reasonHash,
        bytes32 evidenceHash
    );

    /// @dev Governance authentication is enforced by the fixed Bridge dispatch.
    /// This records containment authority, not proof of private-key loss.
    /// Existing signatures and escrow survive; proof recovery is independent.
    function quarantine(
        BridgeState.Storage storage self,
        bytes32 walletId,
        uint64 expectedStateVersion,
        bytes32 reasonHash,
        bytes32 evidenceHash
    ) external {
        enter(self);
        FrostWallets.Wallet storage wallet = self.frost.wallets[
            bytes20(walletId)
        ];
        FrostCustody.Wallet storage custody = self.frostCustody.wallets[
            walletId
        ];
        require(
            walletId != bytes32(0) &&
                wallet.id == walletId &&
                !wallet.quarantined &&
                custody.value > 0 &&
                custody.stateVersion > 0 &&
                custody.stateVersion == expectedStateVersion,
            "FROST quarantine wallet state"
        );
        require(
            reasonHash != bytes32(0) &&
                evidenceHash != bytes32(0) &&
                block.number <= type(uint64).max,
            "FROST quarantine evidence"
        );
        uint64 nextVersion = custody.stateVersion + 1;
        bytes32 active = custody.activeReservation;
        if (active != bytes32(0)) {
            FrostRedemptionLedger.Intent storage intent = self
                .frostRedemptions
                .ledger
                .intents[active];
            require(
                intent.certificate.walletId == walletId &&
                    FrostRedemptionLedger.unresolved(intent),
                "FROST quarantine intent state"
            );
            intent.state = FrostRedemptionLedger.IntentState.Quarantined;
        }
        if (FrostWallets.isMovementTarget(wallet))
            self.frostMovement.eligibleTargets--;
        wallet.quarantined = true;
        custody.stateVersion = nextVersion;
        self.frostRedemptions.quarantines[walletId][
            nextVersion
        ] = FrostRedemptionState.QuarantineRecord({
            reservationId: active,
            reasonHash: reasonHash,
            evidenceHash: evidenceHash,
            authority: msg.sender,
            recordedBlock: uint64(block.number),
            previousStateVersion: expectedStateVersion,
            stateVersion: nextVersion
        });
        emit FrostWalletQuarantined(
            walletId,
            active,
            nextVersion,
            reasonHash,
            evidenceHash
        );
        leave(self);
    }

    function enter(BridgeState.Storage storage self) private {
        require(!self.frostFunding.entered, "FROST redemption reentry");
        self.frostFunding.entered = true;
    }

    function leave(BridgeState.Storage storage self) private {
        self.frostFunding.entered = false;
    }

    function configure(
        BridgeState.Storage storage self,
        bytes32 genesis,
        uint64 finalityBlocks,
        uint64 maximumCertificateBlocks,
        address watchtower,
        bytes32 legacyTransitionEvidence
    ) external {
        enter(self);
        FrostRedemptionState.Configuration storage config = self
            .frostRedemptions
            .configuration;
        require(
            !config.enabled &&
                genesis != bytes32(0) &&
                finalityBlocks > 0 &&
                maximumCertificateBlocks > 0 &&
                legacyTransitionEvidence != bytes32(0),
            "FROST redemption configuration"
        );
        require(
            config.bitcoinGenesis == bytes32(0) ||
                config.bitcoinGenesis == genesis,
            "FROST genesis immutable"
        );
        require(
            watchtower == address(0) || watchtower.code.length > 0,
            "FROST watchtower code"
        );
        require(
            self.redemptionWatchtower == address(0) || watchtower != address(0),
            "FROST legacy watchtower transition"
        );
        config.bitcoinGenesis = genesis;
        config.finalityBlocks = finalityBlocks;
        config.maximumCertificateBlocks = maximumCertificateBlocks;
        config.watchtower = watchtower;
        config.legacyTransitionEvidence = legacyTransitionEvidence;
        emit FrostRedemptionsConfigured(
            genesis,
            finalityBlocks,
            maximumCertificateBlocks,
            watchtower,
            legacyTransitionEvidence
        );
        leave(self);
    }

    /// @dev Governance owns D-08 and the release gate; an evidence hash is a
    /// retained approval reference, not a contract proof of reconciliation.
    function setEnabled(BridgeState.Storage storage self, bool enabled)
        external
    {
        enter(self);
        require(
            !enabled ||
                self.frostRedemptions.configuration.bitcoinGenesis !=
                bytes32(0),
            "FROST redemption not configured"
        );
        require(
            !enabled ||
                (self.frostFunding.configuration.verifier != address(0) &&
                    self.frostFunding.configuration.bitcoinGenesis ==
                    self.frostRedemptions.configuration.bitcoinGenesis),
            "FROST redemption funding network"
        );
        self.frostRedemptions.configuration.enabled = enabled;
        emit FrostRedemptionsEnabled(enabled);
        leave(self);
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

    function request(
        BridgeState.Storage storage self,
        bytes32 walletId,
        bytes calldata script,
        uint64 gross,
        address redeemer
    ) external returns (bytes32 id) {
        enter(self);
        require(
            self.frostRedemptions.configuration.enabled,
            "FROST redemptions disabled"
        );
        FrostWallets.Wallet storage wallet = liveWallet(self, walletId);
        require(
            gross >= self.redemptionDustThreshold &&
                FrostSigningIntent.supportedScript(script),
            "FROST request amount or script"
        );
        require(
            keccak256(script) !=
                keccak256(
                    abi.encodePacked(hex"5120", wallet.descriptor.outputKey)
                ),
            "FROST self redemption"
        );
        uint64 treasuryFee = self.redemptionTreasuryFeeDivisor > 0
            ? gross / self.redemptionTreasuryFeeDivisor
            : 0;
        require(
            gross > treasuryFee &&
                gross - treasuryFee > self.redemptionTxMaxFee,
            "FROST positive net payout"
        );
        FrostRedemptionLedger.Storage storage ledger = self
            .frostRedemptions
            .ledger;
        FrostRedemptionLedger.requireRequestCapacity(
            ledger,
            self.frostCustody,
            walletId,
            gross - treasuryFee
        );
        FrostRedemptionState.RequestPolicy memory policy;
        policy.watchtower = self.frostRedemptions.configuration.watchtower;
        uint64 delay;
        if (policy.watchtower != address(0)) {
            bool allowed;
            (allowed, policy.policyId, delay) = IFrostRedemptionWatchtower(
                policy.watchtower
            ).requestPolicy(walletId, script, msg.sender, redeemer, gross);
            require(
                allowed && policy.policyId != bytes32(0),
                "FROST watchtower request refused"
            );
        }
        require(
            delay < self.redemptionTimeout &&
                // Captured request/deadline timing is required by KC-SF-V3 C-04.
                // solhint-disable-next-line not-rely-on-time
                block.timestamp + delay <= type(uint64).max,
            "FROST watchtower timing"
        );
        // Captured request/deadline timing is required by KC-SF-V3 C-04.
        // solhint-disable-next-line not-rely-on-time
        policy.notBefore = uint64(block.timestamp + delay);
        FrostRedemptionLedger.Admission memory admission = FrostRedemptionLedger
            .Admission(
                walletId,
                wallet.descriptorHash,
                msg.sender,
                redeemer,
                gross,
                treasuryFee,
                self.redemptionTxMaxFee,
                self.redemptionTimeout,
                self.frostRedemptions.configuration.finalityBlocks,
                script
            );
        id = FrostRedemptionLedger.request(ledger, self.bank, admission);
        self.frostRedemptions.requestPolicies[id] = policy;
        leave(self);
    }

    function observeTimeout(BridgeState.Storage storage self, bytes32 id)
        external
    {
        enter(self);
        FrostRedemptionLedger.observeTimeout(self.frostRedemptions.ledger, id);
        leave(self);
    }

    function refundUnreserved(BridgeState.Storage storage self, bytes32 id)
        external
    {
        enter(self);
        FrostRedemptionLedger.refundUnreserved(
            self.frostRedemptions.ledger,
            self.bank,
            id
        );
        leave(self);
    }
}
