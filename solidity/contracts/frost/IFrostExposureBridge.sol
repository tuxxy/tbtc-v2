// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BitcoinTx.sol";

/// @notice C-10 entrypoints: the exposure controller, the deposit custody
/// reservation and the legacy DKG creation modes.
interface IFrostExposureBridge {
    event FrostExposureControllerInstalled(address controller);
    event FrostDepositReserved(bytes32 indexed outpoint, uint64 amount);
    event LegacyDkgDrainBegun();
    event LegacyDkgDrainAborted(bytes32 policyRecord);
    event FrostCutoverCompleted(bytes32 manifestHash);
    event FrostDepositReservationMarginSet(uint32 margin);

    /// @notice Governance, once. The controller must name this Bridge.
    function installFrostExposureController(address controller) external;

    function frostExposureController() external view returns (address);

    /// @notice Reserve a revealed deposit's custody and issuance against the
    /// budget, with an SPV proof of its funding transaction. Permissionless.
    /// Refused within the reservation margin of the refund locktime.
    function reserveFrostDeposit(
        bytes32 outpoint,
        BitcoinTx.Info calldata fundingTx,
        BitcoinTx.Proof calldata proof
    ) external;

    /// @return Whether the deposit is reserved and not yet swept.
    function frostDepositReserved(bytes32 outpoint)
        external
        view
        returns (bool);

    function frostDrainReservationId(bytes20 source)
        external
        view
        returns (bytes32);

    /// @notice Governance: LegacyOpen to LegacyDraining. Records whether a
    /// legacy DKG is in flight; only its callback may still register.
    function beginLegacyDkgDrain() external;

    /// @notice Governance: LegacyDraining back to LegacyOpen, naming the
    /// reviewed policy that allows it.
    function abortLegacyDkgDrain(bytes32 policyRecord) external;

    /// @notice Governance: LegacyDraining to FrostOnly, permanently. The
    /// legacy DKG must be IDLE and its sortition pool unlocked.
    function completeFrostCutover(bytes32 manifestHash) external;

    /// @return 0 LegacyOpen, 1 LegacyDraining, 2 FrostOnly.
    function frostCreationMode() external view returns (uint8);

    function frostCutoverManifest() external view returns (bytes32);

    /// @notice Governance: seconds a reserved deposit must keep before its
    /// refund locktime (D-10 OPEN).
    function setFrostDepositReservationMargin(uint32 margin) external;

    function frostDepositReservationMargin() external view returns (uint32);
}
