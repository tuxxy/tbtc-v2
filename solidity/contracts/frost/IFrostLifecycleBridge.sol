// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

/// @notice C-09 lifecycle entrypoints of the Bridge's FROST extension.
interface IFrostLifecycleBridge {
    event FrostWalletMovingFunds(bytes32 indexed walletId, bytes32 reason);
    event FrostWalletClosing(bytes32 indexed walletId);
    event FrostWalletClosed(bytes32 indexed walletId);
    /// @dev Notification-only sanction (D-03 OPEN). The descriptor hash binds
    ///      the original seats and operators.
    event FrostSanctionNotified(
        bytes32 indexed walletId,
        bytes32 descriptorHash,
        bytes32 reason
    );
    /// @dev K-08 inactivity claim over the immutable descriptor; the seats
    ///      and their descriptor operators, in ascending seat order.
    event FrostOperatorInactivityNotified(
        bytes32 indexed walletId,
        uint64 nonce,
        uint16[] inactiveSeats,
        address[] inactiveOperators,
        bool heartbeatFailed
    );

    function notifyFrostWalletCloseable(bytes32 walletId) external;

    function notifyFrostWalletRedemptionTimeout(bytes32 requestId) external;

    function finalizeFrostWalletClosing(bytes32 walletId) external;

    /// @return open Bit set: 1 custody, 2 pending incoming, 4 committed
    ///         incoming, 8 unproven commitment, 32 redemption escrow,
    ///         64 reservation, 128 open challenge (16 is unused).
    function frostClosureObligations(bytes32 walletId)
        external
        view
        returns (uint256 open);

    /// @notice At least `threshold` signing seats outside `inactiveSeats`,
    ///         both strictly ascending, each with a 65-byte signature
    ///         (r ‖ s ‖ v) by its descriptor operator over the Ethereum signed
    ///         message of frostInactivityClaimDigest. `nonce` must equal
    ///         frostInactivityNonce. A heartbeat failure moves a Live wallet.
    function notifyFrostOperatorInactivity(
        bytes32 walletId,
        uint64 nonce,
        uint16[] calldata inactiveSeats,
        bool heartbeatFailed,
        uint16[] calldata signingSeats,
        bytes calldata signatures
    ) external;

    function frostInactivityNonce(bytes32 walletId)
        external
        view
        returns (uint64);

    function frostInactivityClaimDigest(
        bytes32 walletId,
        uint64 nonce,
        uint16[] calldata inactiveSeats,
        bool heartbeatFailed
    ) external view returns (bytes32);
}
