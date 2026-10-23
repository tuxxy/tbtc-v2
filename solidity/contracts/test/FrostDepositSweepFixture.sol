// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../frost/FrostDepositAdmission.sol";
import "../frost/FrostDepositSweep.sol";
import "../frost/FrostExposureController.sol";

/// @dev Difficulty-zero regtest oracle only. Production BitcoinTx still checks
/// Merkle/coinbase inclusion, header linkage and individual header PoW. The
/// accumulated-work threshold is unqualified at integer difficulty zero.
contract FrostDepositRegtestRelay is IRelay {
    function getCurrentEpochDifficulty() external pure returns (uint256) {
        return 0;
    }

    function getPrevEpochDifficulty() external pure returns (uint256) {
        return 0;
    }
}

/// @dev Component root is controlled registry/configuration metadata only.
/// There are deliberately no custody, deposit or Bank credit seed functions.
contract FrostDepositSweepFixture {
    address private immutable owner;
    Bank public immutable bank;
    BridgeState.Storage private bridge;

    constructor(address treasury) {
        owner = msg.sender;
        bank = new Bank();
        bank.updateBridge(address(this));
        bridge.bank = bank;
        bridge.relay = new FrostDepositRegtestRelay();
        bridge.txProofDifficultyFactor = 1;
        bridge.treasury = treasury;
        bridge.depositDustThreshold = 1;
        bridge.depositTreasuryFeeDivisor = 100;
        bridge.depositTxMaxFee = 2000;
        bridge.depositRevealAheadPeriod = 30;
        // C-10: an exposure controller this fixture governs, with test
        // ceilings (D-10 values OPEN); every sweep credit reports to it.
        FrostExposureController exposure = new FrostExposureController(
            address(this),
            address(this)
        );
        exposure.openBudgetPeriod(
            type(uint64).max,
            type(uint64).max,
            keccak256("C-10 fixture budget; D-10 OPEN")
        );
        bridge.frostExposure.controller = address(exposure);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Fixture owner only");
        _;
    }

    function seedWallet(FrostTypes.Descriptor calldata descriptor)
        external
        onlyOwner
    {
        bytes32 id = FrostTypes.walletId(descriptor.outputKey);
        FrostWallets.Wallet storage wallet = bridge.frost.wallets[bytes20(id)];
        wallet.descriptor = descriptor;
        wallet.id = id;
        wallet.descriptorHash = FrostTypes.descriptorHash(descriptor);
        wallet.state = FrostWallets.State.ReadyUnfunded;
        wallet.capabilityVersion = 1;
    }

    function configure(address verifier, bytes32 genesis) external onlyOwner {
        bridge.frostFunding.configuration = FrostFundingState.Configuration(
            verifier,
            verifier.codehash,
            keccak256("UNQUALIFIED component fixture record"),
            genesis,
            true,
            true
        );
    }

    function setGates(bool addresses, bool revealEnabled) external onlyOwner {
        bridge.frostFunding.configuration.addressesEnabled = addresses;
        bridge.frostFunding.configuration.revealEnabled = revealEnabled;
    }

    function setTreasuryForTest(address treasury) external onlyOwner {
        bridge.treasury = treasury;
    }

    function reveal(
        FrostDepositProfile.Terms calldata terms,
        BitcoinTx.Info calldata transaction,
        uint32 index
    ) external returns (bytes32) {
        return
            FrostDepositAdmission.reveal(
                bridge,
                bridge.frostFunding,
                terms,
                transaction,
                index
            );
    }

    function output(FrostDepositProfile.Terms calldata terms)
        external
        view
        returns (FrostDepositAdmission.Output memory)
    {
        return FrostDepositAdmission.output(bridge, bridge.frostFunding, terms);
    }

    function prove(FrostDepositSweep.Sweep calldata request) external {
        FrostDepositSweep.prove(
            bridge,
            bridge.frostFunding,
            bridge.frostCustody,
            request
        );
    }

    function deposit(bytes32 key)
        external
        view
        returns (FrostFundingState.Deposit memory)
    {
        return bridge.frostFunding.deposits[key];
    }

    function wallet(bytes32 id)
        external
        view
        returns (FrostCustody.Wallet memory)
    {
        return bridge.frostCustody.wallets[id];
    }

    function custodyOutput(bytes32 key)
        external
        view
        returns (FrostCustody.Output memory)
    {
        return bridge.frostCustody.outputs[key];
    }

    function pending(bytes32 id) external view returns (uint64) {
        return bridge.frostFunding.pendingReveals[id];
    }

    function spent(bytes32 key) external view returns (bool) {
        return bridge.spentMainUTXOs[uint256(key)];
    }

    function entered() external view returns (bool) {
        return bridge.frostFunding.entered;
    }

    function walletState(bytes32 id)
        external
        view
        returns (FrostWallets.State)
    {
        return bridge.frost.wallets[bytes20(id)].state;
    }

    function configuration()
        external
        view
        returns (FrostFundingState.Configuration memory)
    {
        return bridge.frostFunding.configuration;
    }
}
