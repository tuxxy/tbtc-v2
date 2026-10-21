// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "./FrostRedemptionState.sol";
import "./IFrostFundingBridge.sol";
import "./IFrostMovementBridge.sol";
import "./IFrostFraudBridge.sol";
import "./IFrostLifecycleBridge.sol";
import "./IFrostExposureBridge.sol";
import "./FrostCancellationCertificate.sol";
import "./FrostCancellationHistory.sol";

/// @notice Explicit ABI for the Bridge's separately linked FROST entrypoints.
interface IFrostBridge is
    IFrostFundingBridge,
    IFrostMovementBridge,
    IFrostFraudBridge,
    IFrostLifecycleBridge,
    IFrostExposureBridge
{
    function frostCancellationWinner(bytes32 reservationId)
        external
        view
        returns (bytes32);

    function frostCancellationCount(bytes32 reservationId)
        external
        view
        returns (uint256);

    function frostCancellationHash(bytes32 reservationId, uint256 index)
        external
        view
        returns (bytes32);

    function frostCancellationAlternative(
        bytes32 reservationId,
        bytes32 transactionHash
    ) external view returns (FrostCancellationHistory.Record memory);

    function claimFrostCancellationBudget(
        bytes32 reservationId,
        bytes32 transactionHash
    ) external;

    function refundResolvedFrostRedemption(bytes32 requestId) external;

    function submitFrostSweepResolutionProof(
        FrostDepositSweep.Resolution calldata resolution
    ) external;

    function quarantineFrostWallet(
        bytes32 walletId,
        uint64 expectedStateVersion,
        bytes32 reasonHash,
        bytes32 evidenceHash
    ) external;

    function frostWalletQuarantine(bytes32 walletId, uint64 stateVersion)
        external
        view
        returns (FrostRedemptionState.QuarantineRecord memory);

    function configureFrostRedemptions(
        bytes32 genesis,
        uint64 finalityBlocks,
        uint64 maximumCertificateBlocks,
        address watchtower,
        bytes32 legacyTransitionEvidence
    ) external;

    function setFrostRedemptionsEnabled(bool enabled) external;

    function requestFrostRedemption(
        bytes32 walletId,
        bytes calldata script,
        uint64 gross,
        address redeemer
    ) external returns (bytes32);

    function reserveFrostRedemption(
        FrostRedemptionState.ReservationProposal calldata proposal
    ) external returns (bytes32);

    function submitFrostRedemptionProof(
        bytes32 reservationId,
        BitcoinTx.Info calldata transaction,
        BitcoinTx.Proof calldata proof
    ) external;

    function authorizeFrostCancellation(
        FrostCancellationCertificate.Authorization calldata authorization,
        BitcoinTx.Info calldata transaction,
        uint16[] calldata seats,
        bytes calldata signatures
    ) external;

    function submitFrostCancellationProof(
        bytes32 reservationId,
        BitcoinTx.Info calldata transaction,
        BitcoinTx.Proof calldata proof
    ) external;

    function notifyFrostRedemptionTimeout(bytes32 requestId) external;

    function refundUnreservedFrostRedemption(bytes32 requestId) external;

    function frostRedemptionConfiguration()
        external
        view
        returns (FrostRedemptionState.Configuration memory);

    function frostRedemptionRequest(bytes32 requestId)
        external
        view
        returns (FrostRedemptionLedger.Request memory);

    function frostRedemptionPolicy(bytes32 requestId)
        external
        view
        returns (FrostRedemptionState.RequestPolicy memory);

    function frostReservation(bytes32 reservationId)
        external
        view
        returns (FrostRedemptionLedger.Intent memory);

    function frostWalletCustody(bytes32 walletId)
        external
        view
        returns (FrostCustody.Wallet memory);

    function frostRedemptionEscrow(bytes32 walletId)
        external
        view
        returns (uint64 gross, uint64 netLiability);

    function configureFrostRegistry(address registry) external;

    function setFrostRequestsEnabled(bool enabled) external;

    function requestNewFrostWallet() external;

    function __snowfallWalletCreated(bytes calldata descriptor, uint64 deadline)
        external;

    function __snowfallWalletReady(
        bytes32 id,
        bytes32 descriptorHash,
        uint32 generation,
        uint32 capabilityVersion
    ) external;

    function __snowfallWalletExpired(bytes32 id) external;

    function frostRegistry() external view returns (address);

    function walletScheme(bytes20 label) external view returns (uint8);

    function walletDescriptor(bytes20 label)
        external
        view
        returns (bytes memory);

    function resolveWallet(address registry, bytes32 id)
        external
        view
        returns (bytes20);

    function resolveWalletOutput(bytes32 q) external view returns (bytes20);

    function resolveFrostOutputScript(bytes calldata output)
        external
        view
        returns (bytes20);

    function isFrostFundingTarget(bytes20 label) external view returns (bool);
}
