// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";

/// @dev Component only: synthetic custody roots/certificates/intent and Bank
/// issuance. No funded origin, public Bridge lifecycle, signature or SPV claim.
/// Credit/reserve/request/pay/cancel execute the actual internal libraries and
/// real Bank against BridgeState.frostCustody and frostRedemptions.ledger.
contract FrostSharedCustodyLedgerFixture {
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

    function issueForComponent(address recipient, uint256 value)
        external
        onlyOwner
    {
        bank.increaseBalance(recipient, value);
    }

    function creditForComponent(
        bytes32 walletId,
        uint64 generation,
        bytes32 txHash,
        uint32 index,
        uint64 value
    ) external onlyOwner {
        FrostCustody.credit(
            bridge.frostCustody,
            walletId,
            generation,
            txHash,
            index,
            value
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

    /// @dev Synthetic commitment/snapshot and unauthenticated certificate;
    /// exercises reserve bookkeeping only, not certificate or SPV admission.
    function reserveForComponent(
        FrostReservationCertificate.Reservation calldata certificate,
        FrostSigningIntent.Plan calldata plan,
        bytes32 txHash,
        BitcoinTx.UTXO[] calldata inputs
    ) external onlyOwner returns (bytes32) {
        uint16[] memory seats = new uint16[](0);
        return
            FrostRedemptionLedger.reserve(
                bridge.frostRedemptions.ledger,
                bridge.frostCustody,
                certificate,
                plan,
                txHash,
                inputs,
                seats,
                hex""
            );
    }

    function fundCancellationForComponent(
        bytes32 id,
        bytes32 txHash,
        address sponsor,
        uint64 fee
    ) external onlyOwner {
        FrostRedemptionLedger.Storage storage ledger = bridge
            .frostRedemptions
            .ledger;
        FrostRedemptionLedger.Intent storage intent = ledger.intents[id];
        uint64 exposure = FrostRedemptionLedger.cancellationExposureFor(
            ledger,
            bridge.frostCustody,
            id,
            fee
        );
        intent.cancellationHash = txHash;
        intent.cancellationFee = fee;
        intent.cancellationSponsor = sponsor;
        bridge
            .frostCustody
            .wallets[intent.certificate.walletId]
            .cancellationExposure = exposure;
        bank.transferBalanceFrom(sponsor, address(this), fee);
    }

    function pay(
        bytes32 id,
        address treasury,
        uint64 change,
        uint32 index
    ) external onlyOwner {
        FrostRedemptionLedger.pay(
            bridge.frostRedemptions.ledger,
            bridge.frostCustody,
            bank,
            treasury,
            id,
            change,
            index
        );
    }

    function cancel(
        bytes32 id,
        uint64 change,
        uint32 index
    ) external onlyOwner {
        FrostRedemptionLedger.cancel(
            bridge.frostRedemptions.ledger,
            bridge.frostCustody,
            bank,
            id,
            change,
            index
        );
    }

    /// @dev Fault injection only, to test late settlement rejection atomicity.
    function corruptCapturedInput(
        bytes32 id,
        uint256 index,
        BitcoinTx.UTXO calldata input
    ) external onlyOwner {
        bridge.frostRedemptions.ledger.intents[id].inputs[index] = input;
    }

    function markSpentForComponent(bytes32 key) external onlyOwner {
        bridge.frostCustody.outputs[key].spent = true;
    }

    function wallet(bytes32 id)
        external
        view
        returns (FrostCustody.Wallet memory)
    {
        return bridge.frostCustody.wallets[id];
    }

    function output(bytes32 key)
        external
        view
        returns (FrostCustody.Output memory)
    {
        return bridge.frostCustody.outputs[key];
    }

    function requestRecord(bytes32 id)
        external
        view
        returns (FrostRedemptionLedger.Request memory)
    {
        return bridge.frostRedemptions.ledger.requests[id];
    }

    function intentRecord(bytes32 id)
        external
        view
        returns (FrostRedemptionLedger.Intent memory)
    {
        return bridge.frostRedemptions.ledger.intents[id];
    }

    function escrow(bytes32 walletId) external view returns (uint64) {
        return bridge.frostRedemptions.ledger.escrow[walletId];
    }

    function netLiability(bytes32 walletId) external view returns (uint64) {
        return bridge.frostRedemptions.ledger.netLiability[walletId];
    }

    function frame(
        bytes32 walletId,
        bytes32 intentId,
        bytes32[] calldata requests,
        bytes32[] calldata outputs
    ) external view returns (bytes32 result) {
        FrostRedemptionLedger.Storage storage ledger = bridge
            .frostRedemptions
            .ledger;
        result = keccak256(
            abi.encode(
                bridge.frostCustody.wallets[walletId],
                ledger.intents[intentId],
                ledger.escrow[walletId],
                ledger.netLiability[walletId],
                ledger.requestNonce[walletId]
            )
        );
        for (uint256 i = 0; i < requests.length; i++)
            result = keccak256(
                abi.encode(result, ledger.requests[requests[i]])
            );
        for (uint256 i = 0; i < outputs.length; i++)
            result = keccak256(
                abi.encode(result, bridge.frostCustody.outputs[outputs[i]])
            );
    }
}
