// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;
import "../frost/FrostRedemptions.sol";

/// @dev GAS ONLY: controlled descriptor/configuration and synthetic custody/Bank
/// issuance. Not a public funded-origin witness. Executes full production
/// admission including authenticated signatures, parsing and archival writes.
contract FrostFullAdmissionGasFixture {
    BridgeState.Storage private bridge;
    Bank public immutable bank;
    address private immutable owner = msg.sender;
    modifier onlyOwner() {
        require(msg.sender == owner, "Fixture owner only");
        _;
    }

    constructor() {
        bank = new Bank();
        bank.updateBridge(address(this));
    }

    function issueForComponent(address recipient, uint256 amount)
        external
        onlyOwner
    {
        bank.increaseBalance(recipient, amount);
    }

    function creditForComponent(
        bytes32 id,
        uint64 generation,
        bytes32 txHash,
        uint32 index,
        uint64 amount
    ) external onlyOwner {
        FrostCustody.credit(
            bridge.frostCustody,
            id,
            generation,
            txHash,
            index,
            amount
        );
    }

    function request(FrostRedemptionLedger.Admission calldata admission)
        external
        returns (bytes32)
    {
        require(msg.sender == admission.balanceOwner, "Fixture balance owner");
        return
            FrostRedemptionLedger.request(
                bridge.frostRedemptions.ledger,
                bank,
                admission
            );
    }

    function wallet(bytes32 id)
        external
        view
        returns (FrostCustody.Wallet memory)
    {
        return bridge.frostCustody.wallets[id];
    }

    function configureForGas(
        FrostTypes.Descriptor calldata descriptor,
        bytes32 genesis
    ) external onlyOwner {
        bytes32 id = FrostTypes.walletId(descriptor.outputKey);
        FrostWallets.Wallet storage w = bridge.frost.wallets[bytes20(id)];
        w.descriptor = descriptor;
        w.id = id;
        w.descriptorHash = FrostTypes.descriptorHash(descriptor);
        w.state = FrostWallets.State.Live;
        w.capabilityVersion = 1;
        bridge.frostRedemptions.configuration = FrostRedemptionState
            .Configuration(
                genesis,
                2,
                10000,
                true,
                address(0),
                bytes32(uint256(1))
            );
        bridge.redemptionTxMaxTotalFee = 200000;
    }

    function fullAdmissionForGas(
        FrostRedemptionState.ReservationProposal calldata proposal
    ) external onlyOwner returns (bytes32) {
        return FrostRedemptions.reserve(bridge, proposal);
    }
}
