// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../frost/FrostRedemptionLedger.sol";

/// @dev Synthetic financial frame only: no custody, funding, signature or SPV witness.
contract FrostCancellationCapacityFixture {
    address private immutable owner = msg.sender;
    FrostRedemptionLedger.Storage private ledger;
    FrostCustody.Storage private custody;

    modifier onlyOwner() {
        require(msg.sender == owner, "Fixture owner only");
        _;
    }

    function seed(
        bytes32 walletId,
        bytes32 intentId,
        uint64 value,
        uint64 pendingNet,
        uint64 reservedNet,
        bool active
    ) external onlyOwner {
        custody.wallets[walletId].value = value;
        custody.wallets[walletId].activeReservation = active
            ? intentId
            : bytes32(0);
        custody.wallets[walletId].cancellationExposure = 0;
        ledger.netLiability[walletId] = pendingNet;
        ledger.intents[intentId].certificate.walletId = walletId;
        ledger.intents[intentId].reservedNet = reservedNet;
        ledger.intents[intentId].state = FrostRedemptionLedger
            .IntentState
            .Reserved;
    }

    function authorizeForTest(bytes32 id, uint64 fee)
        external
        onlyOwner
        returns (uint64 exposure)
    {
        exposure = FrostRedemptionLedger.cancellationExposureFor(
            ledger,
            custody,
            id,
            fee
        );
        custody
            .wallets[ledger.intents[id].certificate.walletId]
            .cancellationExposure = exposure;
        ledger.intents[id].cancellationFee = fee;
    }

    function requestCapacityForTest(bytes32 walletId, uint64 newNet)
        external
        onlyOwner
    {
        FrostRedemptionLedger.requireRequestCapacity(
            ledger,
            custody,
            walletId,
            newNet
        );
        ledger.netLiability[walletId] += newNet;
    }

    function frame(bytes32 walletId, bytes32 id)
        external
        view
        returns (
            uint64 value,
            uint64 pendingNet,
            uint64 reservedNet,
            bytes32 activeIntent,
            uint64 exposure,
            uint64 cancellationFee
        )
    {
        FrostCustody.Wallet storage wallet = custody.wallets[walletId];
        FrostRedemptionLedger.Intent storage intent = ledger.intents[id];
        return (
            wallet.value,
            ledger.netLiability[walletId],
            intent.reservedNet,
            wallet.activeReservation,
            wallet.cancellationExposure,
            intent.cancellationFee
        );
    }
}
