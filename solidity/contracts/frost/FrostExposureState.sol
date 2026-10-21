// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "./IFrostExposureController.sol";

/// @notice C-10 Bridge storage and the internal hooks every FROST inflow
/// path calls. Two slots, additive to all earlier Bridge slots.
library FrostExposureState {
    // Creation modes. The zero default keeps an upgraded proxy LegacyOpen.
    uint8 internal constant LEGACY_OPEN = 0;
    uint8 internal constant LEGACY_DRAINING = 1;
    uint8 internal constant FROST_ONLY = 2;

    bytes32 internal constant DRAIN_DOMAIN =
        keccak256("tbtc-v2/frost-exposure/drain/v1");

    struct Storage {
        // Installed once; there is no replacement or removal.
        address controller;
        uint8 creationMode;
        // Set when the drain begins with a legacy DKG in flight; that DKG's
        // callback alone may still register during LegacyDraining.
        bool legacyDkgInFlight;
        // Seconds a reserved deposit must keep before its refund locktime
        // (D-10 OPEN): the host never sweeps inside this margin.
        uint32 depositReservationMargin;
        bytes32 cutoverManifest;
    }

    /// @dev A drain is keyed by its source and the committed main. Any
    /// change of that main releases the drain first (C-10 review of #14), so
    /// the commitment, proof and release all see the same key.
    function drainId(bytes20 source, bytes32 mainUtxoHash)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(DRAIN_DOMAIN, source, mainUtxoHash));
    }

    /// @dev The installed controller; every caller fails closed without one.
    function controllerOf(Storage storage self)
        internal
        view
        returns (IFrostExposureController)
    {
        require(self.controller != address(0), "FROST exposure not installed");
        return IFrostExposureController(self.controller);
    }

    /// @dev New admissions (reveals) stop under containment.
    function requireAdmission(Storage storage self) internal view {
        require(!controllerOf(self).contained(), "FROST exposure contained");
    }
}
