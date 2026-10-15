// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;
import "./FrostFundingState.sol";

/// @notice C-05 installation hooks for the eventual C-11 authority bundle.
/// @dev The caller authenticates governance. The record is an approval reference,
/// not an on-chain proof of qualification; G-F evidence remains a release duty.
/// Install only the exact independently qualified immutable verifier runtime.
library FrostFundingConfiguration {
    event FrostFundingInstalled(
        address indexed verifier,
        bytes32 runtimeHash,
        bytes32 qualificationRecord,
        bytes32 bitcoinGenesis
    );
    event FrostFundingGatesChanged(bool addressesEnabled, bool revealEnabled);

    function install(
        FrostFundingState.Storage storage self,
        address verifier,
        bytes32 runtimeHash,
        bytes32 record,
        bytes32 genesis
    ) internal {
        require(
            self.configuration.verifier == address(0),
            "FROST funding already installed"
        );
        require(
            verifier.code.length > 0 &&
                runtimeHash != bytes32(0) &&
                verifier.codehash == runtimeHash &&
                record != bytes32(0) &&
                genesis != bytes32(0),
            "FROST funding installation"
        );
        self.configuration = FrostFundingState.Configuration(
            verifier,
            runtimeHash,
            record,
            genesis,
            false,
            false
        );
        emit FrostFundingInstalled(verifier, runtimeHash, record, genesis);
    }

    function setGates(
        FrostFundingState.Storage storage self,
        bool addressesEnabled,
        bool revealEnabled
    ) internal {
        FrostFundingState.Configuration storage config = self.configuration;
        require(config.verifier != address(0), "FROST funding not installed");
        // A paused or unavailable verifier must not prevent the emergency stop.
        if (addressesEnabled || revealEnabled)
            require(
                config.verifier.code.length > 0 &&
                    config.verifier.codehash == config.verifierCodeHash,
                "FROST verifier identity"
            );
        config.addressesEnabled = addressesEnabled;
        config.revealEnabled = revealEnabled;
        emit FrostFundingGatesChanged(addressesEnabled, revealEnabled);
    }
}
