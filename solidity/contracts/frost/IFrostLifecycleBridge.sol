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
}
