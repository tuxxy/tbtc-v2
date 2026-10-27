// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "./IFrostMovementBridge.sol";
import "./FrostMovement.sol";
import "./FrostFraudDispatch.sol";
import "./FrostExposureState.sol";
import "./FrostLegacyRecovery.sol";

interface IFrostMovementGovernance {
    function governance() external view returns (address);
}

/// @notice Selector dispatch for the C-06 entrypoints, reached from the end of
/// FrostBridge.dispatch so FrostBridge stays within its size limit.
library FrostMovementDispatch {
    event FrostDrainEnabled(bool enabled);

    function dispatch(BridgeState.Storage storage self, bytes calldata input)
        external
        returns (bytes memory)
    {
        bytes4 selector = bytes4(input[:4]);
        bytes calldata args = input[4:];
        if (selector == IFrostMovementBridge.resetLegacyMovingFundsTimeout.selector) {
            (bytes20 source, BitcoinTx.UTXO memory main) = abi.decode(args, (bytes20, BitcoinTx.UTXO));
            FrostLegacyRecovery.resetWithMain(self, source, main);
        } else if (
            selector ==
            IFrostMovementBridge.submitFrostMovingFundsCommitment.selector
        ) {
            (bytes32 id, uint16 seat, bytes20[] memory targets) = abi.decode(
                args,
                (bytes32, uint16, bytes20[])
            );
            FrostMovement.commit(self, id, seat, targets);
        } else if (
            selector ==
            IFrostMovementBridge.submitFrostMovingFundsProof.selector ||
            selector ==
            IFrostMovementBridge.submitFrostMovedFundsSweepProof.selector
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
            if (
                selector ==
                IFrostMovementBridge.submitFrostMovingFundsProof.selector
            ) FrostMovement.prove(self, id, transaction, proof);
            else FrostMovement.sweep(self, id, transaction, proof);
        } else if (
            selector ==
            IFrostMovementBridge.notifyFrostMovingFundsTimeout.selector
        ) {
            FrostMovement.notifyMovingFundsTimeout(
                self,
                abi.decode(args, (bytes32))
            );
        } else if (
            selector ==
            IFrostMovementBridge.resetFrostMovingFundsTimeout.selector
        ) {
            FrostMovement.resetMovingFundsTimeout(
                self,
                abi.decode(args, (bytes32))
            );
        } else if (
            selector ==
            IFrostMovementBridge.notifyFrostMovedFundsSweepTimeout.selector
        ) {
            FrostMovement.notifyMovedFundsSweepTimeout(
                self,
                abi.decode(args, (bytes32))
            );
        } else if (
            selector ==
            IFrostMovementBridge.notifyFrostMovingFundsBelowDust.selector
        ) {
            FrostMovement.notifyBelowDust(self, abi.decode(args, (bytes32)));
        } else if (
            selector ==
            IFrostMovementBridge.releaseFrostDrainOnConflict.selector
        ) {
            (
                bytes20 source,
                BitcoinTx.UTXO memory main,
                BitcoinTx.Info memory transaction,
                BitcoinTx.Proof memory proof
            ) = abi.decode(
                    args,
                    (bytes20, BitcoinTx.UTXO, BitcoinTx.Info, BitcoinTx.Proof)
                );
            FrostMovement.releaseDrainOnConflict(
                self,
                source,
                main,
                transaction,
                proof
            );
        } else if (
            selector == IFrostMovementBridge.frostDrainTargets.selector
        ) {
            return
                abi.encode(
                    self.frostMovement.drainTargets[abi.decode(args, (bytes20))]
                );
        } else if (
            selector == IFrostMovementBridge.setFrostDrainEnabled.selector
        ) {
            require(
                msg.sender ==
                    IFrostMovementGovernance(address(this)).governance(),
                "Caller is not governance"
            );
            bool enabled = abi.decode(args, (bool));
            // C-10: drains reserve custody, so they need the controller.
            require(
                !enabled || self.frostExposure.controller != address(0),
                "FROST exposure not installed"
            );
            self.frostMovement.drainEnabled = enabled;
            emit FrostDrainEnabled(enabled);
        } else if (
            selector == IFrostMovementBridge.frostMovingFundsCommitment.selector
        ) {
            (bytes32 id, uint32 period) = abi.decode(args, (bytes32, uint32));
            return
                abi.encode(
                    self.frostMovement.commitments[
                        FrostMovementState.commitmentKey(id, period)
                    ]
                );
        } else if (
            selector == IFrostMovementBridge.frostWalletLifecycle.selector
        ) {
            return
                abi.encode(
                    self.frostMovement.lifecycles[abi.decode(args, (bytes32))]
                );
        } else if (selector == IFrostMovementBridge.frostIncoming.selector) {
            return
                abi.encode(
                    self.frostMovement.incoming[abi.decode(args, (bytes32))]
                );
        } else if (
            selector == IFrostMovementBridge.frostMovementCounters.selector
        ) {
            bytes32 id = abi.decode(args, (bytes32));
            return
                abi.encode(
                    self.frostMovement.pendingIncoming[id],
                    self.frostMovement.inboundCommitments[id],
                    self.frostMovement.eligibleTargets,
                    self.frostMovement.drainEnabled
                );
        } else {
            return FrostFraudDispatch.dispatch(self, input);
        }
        return bytes("");
    }
}
