// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "../bridge/BitcoinTx.sol";
import "./FrostExposureState.sol";
import "./IFrostExposureBridge.sol";
import {EcdsaDkg} from "@keep-network/ecdsa/contracts/libraries/EcdsaDkg.sol";

interface IFrostExposureGovernance {
    function governance() external view returns (address);
}

/// @dev The views of the legacy ECDSA registry and its sortition pool that
/// the cutover reads; the deployed WalletRegistry and SortitionPool have both.
interface ILegacyDkgPool {
    function sortitionPool() external view returns (address);

    function isLocked() external view returns (bool);
}

/// @notice C-10 entrypoints, reached from FrostFraudDispatch: the exposure
/// controller installation, deposit custody reservations and the one-way
/// legacy DKG creation modes. The mode checks themselves sit in `Wallets`.
library FrostExposure {
    event FrostExposureControllerInstalled(address controller);
    event FrostDepositReserved(bytes32 indexed outpoint, uint64 amount);
    event LegacyDkgDrainBegun();
    event LegacyDkgDrainAborted(bytes32 policyRecord);
    event FrostCutoverCompleted(bytes32 manifestHash);
    event FrostDepositReservationMarginSet(uint32 margin);

    /// @dev The selectors `dispatch` serves; `reserveFrostDeposit` is decoded
    /// by the caller because its proof arguments must reach calldata.
    function handles(bytes4 selector) internal pure returns (bool) {
        return
            selector ==
            IFrostExposureBridge.installFrostExposureController.selector ||
            selector == IFrostExposureBridge.frostExposureController.selector ||
            selector == IFrostExposureBridge.frostDepositReserved.selector ||
            selector == IFrostExposureBridge.frostDrainReservationId.selector ||
            selector == IFrostExposureBridge.beginLegacyDkgDrain.selector ||
            selector == IFrostExposureBridge.abortLegacyDkgDrain.selector ||
            selector == IFrostExposureBridge.completeFrostCutover.selector ||
            selector == IFrostExposureBridge.frostCreationMode.selector ||
            selector == IFrostExposureBridge.frostCutoverManifest.selector ||
            selector ==
            IFrostExposureBridge.frostDepositReservationMargin.selector ||
            selector ==
            IFrostExposureBridge.setFrostDepositReservationMargin.selector;
    }

    function dispatch(BridgeState.Storage storage self, bytes calldata input)
        external
        returns (bytes memory)
    {
        bytes4 selector = bytes4(input[:4]);
        bytes calldata args = input[4:];
        FrostExposureState.Storage storage exposure = self.frostExposure;
        if (selector == IFrostExposureBridge.frostExposureController.selector)
            return abi.encode(exposure.controller);
        if (selector == IFrostExposureBridge.frostCreationMode.selector)
            return abi.encode(exposure.creationMode);
        if (selector == IFrostExposureBridge.frostCutoverManifest.selector)
            return abi.encode(exposure.cutoverManifest);
        if (
            selector ==
            IFrostExposureBridge.frostDepositReservationMargin.selector
        ) return abi.encode(exposure.depositReservationMargin);
        if (selector == IFrostExposureBridge.frostDepositReserved.selector) {
            FrostFundingState.Deposit storage deposit = self
                .frostFunding
                .deposits[abi.decode(args, (bytes32))];
            return abi.encode(deposit.reservedAt != 0 && deposit.sweptAt == 0);
        }
        if (selector == IFrostExposureBridge.frostDrainReservationId.selector) {
            bytes20 source = abi.decode(args, (bytes20));
            return
                abi.encode(
                    FrostExposureState.drainId(
                        source,
                        self.registeredWallets[source].mainUtxoHash
                    )
                );
        }
        require(
            msg.sender == IFrostExposureGovernance(address(this)).governance(),
            "Caller is not governance"
        );
        if (
            selector ==
            IFrostExposureBridge.installFrostExposureController.selector
        ) {
            address controller = abi.decode(args, (address));
            require(
                exposure.controller == address(0),
                "FROST exposure installed"
            );
            require(
                controller.code.length > 0 &&
                    IFrostExposureController(controller).bridge() ==
                    address(this),
                "FROST exposure controller"
            );
            exposure.controller = controller;
            emit FrostExposureControllerInstalled(controller);
        } else if (
            selector == IFrostExposureBridge.beginLegacyDkgDrain.selector
        ) {
            require(
                exposure.creationMode == FrostExposureState.LEGACY_OPEN,
                "Legacy DKG not open"
            );
            exposure.creationMode = FrostExposureState.LEGACY_DRAINING;
            exposure.legacyDkgInFlight =
                self.ecdsaWalletRegistry.getWalletCreationState() !=
                EcdsaDkg.State.IDLE;
            emit LegacyDkgDrainBegun();
        } else if (
            selector == IFrostExposureBridge.abortLegacyDkgDrain.selector
        ) {
            bytes32 policyRecord = abi.decode(args, (bytes32));
            require(
                exposure.creationMode == FrostExposureState.LEGACY_DRAINING &&
                    policyRecord != bytes32(0),
                "Legacy DKG drain abort"
            );
            exposure.creationMode = FrostExposureState.LEGACY_OPEN;
            emit LegacyDkgDrainAborted(policyRecord);
        } else if (
            selector ==
            IFrostExposureBridge.setFrostDepositReservationMargin.selector
        ) {
            exposure.depositReservationMargin = abi.decode(args, (uint32));
            emit FrostDepositReservationMarginSet(
                exposure.depositReservationMargin
            );
        } else {
            // completeFrostCutover, the only remaining selector `handles` admits.
            bytes32 manifestHash = abi.decode(args, (bytes32));
            require(
                exposure.creationMode == FrostExposureState.LEGACY_DRAINING &&
                    manifestHash != bytes32(0),
                "FROST cutover state"
            );
            require(
                self.frost.registry != address(0),
                "FROST cutover registry"
            );
            require(
                self.ecdsaWalletRegistry.getWalletCreationState() ==
                    EcdsaDkg.State.IDLE,
                "Legacy DKG not idle"
            );
            require(
                !ILegacyDkgPool(
                    ILegacyDkgPool(address(self.ecdsaWalletRegistry))
                        .sortitionPool()
                ).isLocked(),
                "Legacy sortition pool locked"
            );
            exposure.creationMode = FrostExposureState.FROST_ONLY;
            exposure.cutoverManifest = manifestHash;
            emit FrostCutoverCompleted(manifestHash);
        }
        return bytes("");
    }

    /// @notice Reserve a revealed, unswept deposit once its funding
    /// transaction is proven: custody and issuance equal to its amount.
    function reserveDeposit(
        BridgeState.Storage storage self,
        bytes32 outpoint,
        BitcoinTx.Info calldata fundingTx,
        BitcoinTx.Proof calldata proof
    ) external {
        FrostFundingState.Deposit storage deposit = self.frostFunding.deposits[
            outpoint
        ];
        require(
            deposit.revealedAt != 0 && deposit.sweptAt == 0,
            "FROST deposit not pending"
        );
        require(deposit.reservedAt == 0, "FROST deposit reserved");
        // A reservation never releases, so it is refused once the deposit
        // can be refunded before a sweep could land: the funding proof shows
        // the output existed, not that it is still unspent.
        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp + self.frostExposure.depositReservationMargin <
                deposit.terms.refundLocktime,
            "FROST deposit refund window"
        );
        require(
            BitcoinTx.validateProof(self, fundingTx, proof) ==
                deposit.fundingTransactionHash,
            "FROST funding proof"
        );
        uint64 amount = deposit.terms.amount;
        /* solhint-disable-next-line not-rely-on-time */
        deposit.reservedAt = uint64(block.timestamp);
        FrostExposureState.controllerOf(self.frostExposure).reserveDeposit(
            amount
        );
        emit FrostDepositReserved(outpoint, amount);
    }
}
