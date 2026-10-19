// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "./FrostWallets.sol";
import "./FrostMovementState.sol";
import "./FrostFraudState.sol";

/// @notice C-09 FROST lifecycle routing and closure.
///
/// A wallet leaves ReadyUnfunded or Live for MovingFunds when it is old, when
/// a funded wallet's custody falls below the closure minimum, or when one of
/// its redemption requests timed out. It goes straight to Closing only when
/// it holds nothing and owes nothing. Closing (or Terminated) becomes Closed
/// only when the closure ledger is empty at the current head after the
/// closing period: no custody (or recorded dust), no pending or committed
/// incoming transfer, no unproven commitment, no redemption escrow or
/// reservation, and no open fraud challenge. A late incoming or deposit
/// sweep reopens a Closing or Closed wallet into MovingFunds. Closing
/// deletes nothing: the descriptor, custody records, commitments and
/// challenge history stay readable, and the key stays with its holders.
///
/// Sanctions are notification-only (D-03 test value, OPEN): the FROST
/// registry has no seize or inactivity route, so each sanctionable event
/// emits FrostSanctionNotified with the wallet's immutable descriptor hash,
/// which carries the original seat and operator attribution.
library FrostLifecycle {
    bytes32 internal constant REASON_REDEMPTION_TIMEOUT =
        keccak256("redemption-timeout");

    event FrostWalletMovingFunds(bytes32 indexed walletId, bytes32 reason);
    event FrostWalletClosing(bytes32 indexed walletId);
    event FrostWalletClosed(bytes32 indexed walletId);
    event FrostSanctionNotified(
        bytes32 indexed walletId,
        bytes32 descriptorHash,
        bytes32 reason
    );

    function dispatch(BridgeState.Storage storage self, bytes calldata input)
        external
        returns (bytes memory)
    {
        bytes4 selector = bytes4(input[:4]);
        bytes32 id = abi.decode(input[4:], (bytes32));
        if (
            selector == bytes4(keccak256("notifyFrostWalletCloseable(bytes32)"))
        ) notifyCloseable(self, id);
        else if (
            selector ==
            bytes4(keccak256("notifyFrostWalletRedemptionTimeout(bytes32)"))
        ) notifyRedemptionTimeout(self, id);
        else if (
            selector == bytes4(keccak256("finalizeFrostWalletClosing(bytes32)"))
        ) finalize(self, id);
        else if (
            selector == bytes4(keccak256("frostClosureObligations(bytes32)"))
        ) return abi.encode(obligations(self, id));
        else revert("FROST unknown selector");
        return bytes("");
    }

    /// @notice Age (any ready wallet) or low custody (a funded Live wallet).
    function notifyCloseable(BridgeState.Storage storage self, bytes32 id)
        private
    {
        FrostWallets.Wallet storage wallet = wallet_(self, id);
        FrostMovementState.Lifecycle storage lifecycle = self
            .frostMovement
            .lifecycles[id];
        bool old = lifecycle.readyAt != 0 &&
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp >= uint256(lifecycle.readyAt) + self.walletMaxAge;
        bool small = wallet.state == FrostWallets.State.Live &&
            self.frostCustody.wallets[id].value <
            self.walletClosureMinBtcBalance;
        require(
            (wallet.state == FrostWallets.State.ReadyUnfunded ||
                wallet.state == FrostWallets.State.Live) && (old || small),
            "FROST wallet not closeable"
        );
        moveFunds(self, id, keccak256(old ? bytes("age") : bytes("balance")));
    }

    /// @notice A timed-out redemption request moves its wallet's funds.
    function notifyRedemptionTimeout(
        BridgeState.Storage storage self,
        bytes32 requestId
    ) private {
        FrostRedemptionLedger.Request storage request = self
            .frostRedemptions
            .ledger
            .requests[requestId];
        bytes32 id = request.walletId;
        FrostWallets.Wallet storage wallet = wallet_(self, id);
        require(
            request.timeoutBlock != 0 &&
                (wallet.state == FrostWallets.State.ReadyUnfunded ||
                    wallet.state == FrostWallets.State.Live),
            "FROST redemption timeout state"
        );
        emit FrostSanctionNotified(
            id,
            wallet.descriptorHash,
            REASON_REDEMPTION_TIMEOUT
        );
        moveFunds(self, id, REASON_REDEMPTION_TIMEOUT);
    }

    function moveFunds(
        BridgeState.Storage storage self,
        bytes32 id,
        bytes32 reason
    ) private {
        FrostWallets.Wallet storage wallet = self.frost.wallets[bytes20(id)];
        if (FrostWallets.isMovementTarget(wallet))
            self.frostMovement.eligibleTargets--;
        FrostMovementState.Lifecycle storage lifecycle = self
            .frostMovement
            .lifecycles[id];
        if (self.frostCustody.wallets[id].value == 0 && owesNothing(self, id)) {
            wallet.state = FrostWallets.State.Closing;
            /* solhint-disable-next-line not-rely-on-time */
            lifecycle.closingStartedAt = uint64(block.timestamp);
            emit FrostWalletClosing(id);
        } else {
            wallet.state = FrostWallets.State.MovingFunds;
            /* solhint-disable-next-line not-rely-on-time */
            lifecycle.movingFundsRequestedAt = uint64(block.timestamp);
            emit FrostWalletMovingFunds(id, reason);
        }
    }

    /// @notice Close a wallet whose closure ledger is empty.
    function finalize(BridgeState.Storage storage self, bytes32 id) private {
        FrostWallets.Wallet storage wallet = wallet_(self, id);
        FrostMovementState.Lifecycle storage lifecycle = self
            .frostMovement
            .lifecycles[id];
        uint256 since = wallet.state == FrostWallets.State.Closing
            ? lifecycle.closingStartedAt
            : wallet.state == FrostWallets.State.Terminated
            ? lifecycle.terminatedAt
            : 0;
        require(since != 0, "FROST closure state");
        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp > since + self.walletClosingPeriod,
            "FROST closing period"
        );
        require(obligations(self, id) == 0, "FROST closure obligations");
        wallet.state = FrostWallets.State.Closed;
        emit FrostWalletClosed(id);
    }

    /// @notice Bit set of open closure obligations; zero means closable.
    /// 1 custody, 2 pending incoming, 4 committed incoming, 8 unproven
    /// commitment, 32 redemption escrow, 64 reservation, 128 open fraud
    /// challenge. Bit 16 is unused: revealed deposits never block closure,
    /// since a late sweep of a real deposit reopens the wallet.
    function obligations(BridgeState.Storage storage self, bytes32 id)
        private
        view
        returns (uint256 open)
    {
        FrostMovementState.Storage storage movement = self.frostMovement;
        FrostMovementState.Commitment storage commitment = FrostMovementState
            .current(movement, id);
        if (
            self.frostCustody.wallets[id].value != 0 &&
            !movement.lifecycles[id].dust
        ) open |= 1;
        if (movement.pendingIncoming[id] != 0) open |= 2;
        if (movement.inboundCommitments[id] != 0) open |= 4;
        if (commitment.mainOutpoint != bytes32(0) && commitment.provenAt == 0)
            open |= 8;
        if (self.frostRedemptions.ledger.escrow[id] != 0) open |= 32;
        if (self.frostCustody.wallets[id].activeReservation != bytes32(0))
            open |= 64;
        if (self.frostFraud.openChallenges[id] != 0) open |= 128;
    }

    function owesNothing(BridgeState.Storage storage self, bytes32 id)
        private
        view
        returns (bool)
    {
        return obligations(self, id) == 0;
    }

    function wallet_(BridgeState.Storage storage self, bytes32 id)
        private
        view
        returns (FrostWallets.Wallet storage wallet)
    {
        wallet = self.frost.wallets[bytes20(id)];
        require(id != bytes32(0) && wallet.id == id, "FROST lifecycle wallet");
    }
}
