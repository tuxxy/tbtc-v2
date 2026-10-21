// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../frost/FrostDepositAdmission.sol";
import "../frost/FrostExposureController.sol";

/// @dev Component-only seeded wallet/configuration. This bypasses registration,
/// readiness and governance; it is not evidence of a funded wallet lifecycle.
contract FrostDepositAdmissionFixture {
    BridgeState.Storage private bridge;
    FrostFundingState.Storage private funding;

    constructor() {
        // C-10: reveals stop under containment, so they read a controller.
        bridge.frostExposure.controller = address(
            new FrostExposureController(address(this), address(this))
        );
    }

    function seedConfiguration(address verifier, bytes32 genesis) external {
        funding.configuration = FrostFundingState.Configuration(
            verifier,
            verifier.codehash,
            bytes32(0),
            genesis,
            true,
            true
        );
        bridge.depositDustThreshold = 1000;
        bridge.depositTreasuryFeeDivisor = 100;
        bridge.depositTxMaxFee = 100;
        bridge.depositRevealAheadPeriod = 3600;
    }

    function seedWallet(
        bytes32 id,
        bytes32 descriptorHash,
        bytes32 key,
        FrostWallets.State state,
        bool quarantined,
        uint32 capability
    ) external {
        FrostWallets.Wallet storage w = bridge.frost.wallets[bytes20(id)];
        w.id = id;
        w.descriptorHash = descriptorHash;
        w.descriptor.outputKey = key;
        w.state = state;
        w.quarantined = quarantined;
        w.capabilityVersion = capability;
    }

    function gates(bool addresses, bool reveals) external {
        funding.configuration.addressesEnabled = addresses;
        funding.configuration.revealEnabled = reveals;
    }

    function fees(
        uint64 dust,
        uint64 divisor,
        uint64 maximum
    ) external {
        bridge.depositDustThreshold = dust;
        bridge.depositTreasuryFeeDivisor = divisor;
        bridge.depositTxMaxFee = maximum;
    }

    function seedOccupied(
        bytes32 outpoint,
        bool legacy,
        bool spent
    ) external {
        bridge.deposits[uint256(outpoint)].revealedAt = legacy ? 1 : 0;
        bridge.spentMainUTXOs[uint256(outpoint)] = spent;
    }

    function seedCustody(bytes32 outpoint, bytes32 walletId) external {
        bridge.frostCustody.outputs[outpoint].walletId = walletId;
    }

    function trustVault(address vault, bool trusted) external {
        bridge.isVaultTrusted[vault] = trusted;
    }

    function verifierIdentity(address verifier, bytes32 codeHash) external {
        funding.configuration.verifier = verifier;
        funding.configuration.verifierCodeHash = codeHash;
    }

    function rebate(address staking) external {
        bridge.rebateStaking = staking;
    }

    function setEntered(bool value) external {
        funding.entered = value;
    }

    function seedPending(bytes32 walletId, uint64 count) external {
        funding.pendingReveals[walletId] = count;
    }

    function output(FrostDepositProfile.Terms calldata terms)
        external
        view
        returns (FrostDepositAdmission.Output memory)
    {
        return FrostDepositAdmission.output(bridge, funding, terms);
    }

    function construction(FrostDepositProfile.Terms calldata terms)
        external
        view
        returns (FrostDepositAdmission.Construction memory)
    {
        return FrostDepositAdmission.construction(bridge, funding, terms);
    }

    function refundConstruction(bytes32 outpoint)
        external
        view
        returns (FrostDepositAdmission.Construction memory)
    {
        return FrostDepositAdmission.refundConstruction(funding, outpoint);
    }

    function reveal(
        FrostDepositProfile.Terms calldata terms,
        BitcoinTx.Info calldata transaction,
        uint32 index
    ) external returns (bytes32) {
        return
            FrostDepositAdmission.reveal(
                bridge,
                funding,
                terms,
                transaction,
                index
            );
    }

    function deposit(bytes32 outpoint)
        external
        view
        returns (FrostFundingState.Deposit memory)
    {
        return funding.deposits[outpoint];
    }

    function pending(bytes32 walletId) external view returns (uint64) {
        return funding.pendingReveals[walletId];
    }

    function entered() external view returns (bool) {
        return funding.entered;
    }

    /// @dev Compare all receipt fields plus touched shared identity/wallet state.
    function frame(bytes32 outpoint, bytes32 walletId)
        external
        view
        returns (bytes32)
    {
        return
            keccak256(
                abi.encode(
                    funding.deposits[outpoint],
                    funding.pendingReveals[walletId],
                    funding.entered,
                    bridge.deposits[uint256(outpoint)],
                    bridge.spentMainUTXOs[uint256(outpoint)],
                    bridge.frostCustody.outputs[outpoint],
                    bridge.frostCustody.wallets[walletId],
                    bridge.frost.wallets[bytes20(walletId)],
                    funding.configuration
                )
            );
    }
}
