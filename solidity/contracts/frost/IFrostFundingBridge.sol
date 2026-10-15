// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;
import "./FrostDepositAdmission.sol";

interface IFrostFundingBridge {
    event FrostFundingInstalled(
        address indexed verifier,
        bytes32 runtimeHash,
        bytes32 qualificationRecord,
        bytes32 bitcoinGenesis
    );
    event FrostFundingGatesChanged(bool addressesEnabled, bool revealEnabled);

    function configureFrostFunding(
        address verifier,
        bytes32 runtimeHash,
        bytes32 qualificationRecord,
        bytes32 bitcoinGenesis
    ) external;

    function setFrostFundingGates(bool addressesEnabled, bool revealEnabled)
        external;

    function frostDepositConstruction(FrostDepositProfile.Terms calldata terms)
        external
        view
        returns (FrostDepositAdmission.Construction memory);

    function frostDepositRefundConstruction(bytes32 outpoint)
        external
        view
        returns (FrostDepositAdmission.Construction memory);

    function revealFrostDeposit(
        FrostDepositProfile.Terms calldata terms,
        BitcoinTx.Info calldata transaction,
        uint32 outputIndex
    ) external returns (bytes32);

    function frostDepositOutput(FrostDepositProfile.Terms calldata terms)
        external
        view
        returns (FrostDepositAdmission.Output memory);

    function frostDeposit(bytes32 outpoint)
        external
        view
        returns (bytes memory);
}
