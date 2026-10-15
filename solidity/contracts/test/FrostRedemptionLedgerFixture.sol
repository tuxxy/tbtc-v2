// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../frost/FrostRedemptionLedger.sol";

/// @dev Controlled ledger fixture, not a custody proof or production funding route.
contract FrostRedemptionLedgerFixture {
    Bank public immutable bank;
    address private immutable owner;
    FrostRedemptionLedger.Storage private ledger;

    constructor() {
        owner = msg.sender;
        bank = new Bank();
        bank.updateBridge(address(this));
    }

    function creditForTest(address recipient, uint256 amount) external {
        require(msg.sender == owner, "Fixture owner only");
        bank.increaseBalance(recipient, amount);
    }

    function request(FrostRedemptionLedger.Admission calldata admission)
        external
        returns (bytes32)
    {
        require(msg.sender == admission.balanceOwner, "Fixture balance owner");
        return FrostRedemptionLedger.request(ledger, bank, admission);
    }

    function observeTimeout(bytes32 id) external {
        FrostRedemptionLedger.observeTimeout(ledger, id);
    }

    function refundUnreserved(bytes32 id) external {
        FrostRedemptionLedger.refundUnreserved(ledger, bank, id);
    }

    function getRequest(bytes32 id)
        external
        view
        returns (FrostRedemptionLedger.Request memory)
    {
        return ledger.requests[id];
    }

    function escrow(bytes32 walletId) external view returns (uint64) {
        return ledger.escrow[walletId];
    }

    function netLiability(bytes32 walletId) external view returns (uint64) {
        return ledger.netLiability[walletId];
    }

    function nonce(bytes32 walletId) external view returns (uint64) {
        return ledger.requestNonce[walletId];
    }
}
