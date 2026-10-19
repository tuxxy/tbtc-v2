// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "./FrostWallets.sol";
import "./FrostMovementState.sol";
import "./FrostFraudState.sol";
import "./IFrostLifecycleBridge.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {BytesLib} from "@keep-network/bitcoin-spv-sol/contracts/BytesLib.sol";

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
/// Operator inactivity (K-08) is claimed against the wallet's immutable
/// descriptor: at least `threshold` seats outside the claimed set sign the
/// claim with their descriptor operator keys, under a per-wallet nonce. A
/// claim emits the claimed seats and operators; one that reports a heartbeat
/// failure moves a Live wallet's funds, as legacy notifyWalletHeartbeatFailed
/// does, and is only recorded in any other state.
///
/// Sanctions are notification-only (D-03 test value, OPEN): the FROST
/// registry has no seize route, so each sanctionable event emits
/// FrostSanctionNotified with the wallet's immutable descriptor hash, which
/// carries the original seat and operator attribution.
library FrostLifecycle {
    using BytesLib for bytes;

    bytes32 internal constant REASON_REDEMPTION_TIMEOUT =
        keccak256("redemption-timeout");
    bytes32 internal constant REASON_INACTIVITY = keccak256("inactivity");
    bytes32 internal constant REASON_HEARTBEAT_FAILURE =
        keccak256("heartbeat-failure");
    bytes32 internal constant INACTIVITY_DOMAIN =
        keccak256("tbtc-v2/frost-inactivity/v1");

    struct InactivityClaim {
        bytes32 walletId;
        uint64 nonce;
        uint16[] inactiveSeats;
        bool heartbeatFailed;
        uint16[] signingSeats;
        bytes signatures;
    }

    event FrostWalletMovingFunds(bytes32 indexed walletId, bytes32 reason);
    event FrostWalletClosing(bytes32 indexed walletId);
    event FrostWalletClosed(bytes32 indexed walletId);
    event FrostSanctionNotified(
        bytes32 indexed walletId,
        bytes32 descriptorHash,
        bytes32 reason
    );
    event FrostOperatorInactivityNotified(
        bytes32 indexed walletId,
        uint64 nonce,
        uint16[] inactiveSeats,
        address[] inactiveOperators,
        bool heartbeatFailed
    );

    function dispatch(BridgeState.Storage storage self, bytes calldata input)
        external
        returns (bytes memory)
    {
        bytes4 selector = bytes4(input[:4]);
        // These take more than one word; decode them before the single ID.
        if (
            selector ==
            IFrostLifecycleBridge.notifyFrostOperatorInactivity.selector
        ) {
            InactivityClaim memory claim;
            (
                claim.walletId,
                claim.nonce,
                claim.inactiveSeats,
                claim.heartbeatFailed,
                claim.signingSeats,
                claim.signatures
            ) = abi.decode(
                input[4:],
                (bytes32, uint64, uint16[], bool, uint16[], bytes)
            );
            notifyInactivity(self, claim);
            return bytes("");
        }
        if (
            selector ==
            IFrostLifecycleBridge.frostInactivityClaimDigest.selector
        ) {
            (
                bytes32 walletId,
                uint64 nonce,
                uint16[] memory inactiveSeats,
                bool heartbeatFailed
            ) = abi.decode(input[4:], (bytes32, uint64, uint16[], bool));
            return
                abi.encode(
                    inactivityDigest(
                        self,
                        walletId,
                        nonce,
                        inactiveSeats,
                        heartbeatFailed
                    )
                );
        }
        bytes32 id = abi.decode(input[4:], (bytes32));
        if (selector == IFrostLifecycleBridge.frostInactivityNonce.selector)
            return
                abi.encode(self.frostMovement.lifecycles[id].inactivityNonce);
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

    /// @notice An inactivity claim over the wallet's immutable descriptor.
    /// At least `threshold` seats outside the strictly ascending claimed set
    /// sign it with their descriptor operator keys (65-byte r ‖ s ‖ v over
    /// the Ethereum signed message of the claim digest), under the current
    /// per-wallet nonce. No external calls.
    function notifyInactivity(
        BridgeState.Storage storage self,
        InactivityClaim memory claim
    ) private {
        bytes32 id = claim.walletId;
        FrostWallets.Wallet storage wallet = self.frost.wallets[bytes20(id)];
        FrostWallets.State state = wallet.state;
        require(
            id != bytes32(0) &&
                wallet.id == id &&
                (state == FrostWallets.State.ReadyUnfunded ||
                    state == FrostWallets.State.Live ||
                    state == FrostWallets.State.MovingFunds ||
                    state == FrostWallets.State.Closing ||
                    state == FrostWallets.State.Terminated),
            "FROST inactivity wallet"
        );
        FrostMovementState.Lifecycle storage lifecycle = self
            .frostMovement
            .lifecycles[id];
        require(
            claim.nonce == lifecycle.inactivityNonce,
            "FROST inactivity nonce"
        );
        address[] memory inactiveOperators = claimedOperators(
            wallet.descriptor.operators,
            claim.inactiveSeats
        );
        verifySigners(
            wallet,
            ECDSA.toEthSignedMessageHash(
                inactivityDigest(
                    self,
                    id,
                    claim.nonce,
                    claim.inactiveSeats,
                    claim.heartbeatFailed
                )
            ),
            claim
        );
        lifecycle.inactivityNonce = claim.nonce + 1;
        emit FrostOperatorInactivityNotified(
            id,
            claim.nonce,
            claim.inactiveSeats,
            inactiveOperators,
            claim.heartbeatFailed
        );
        emit FrostSanctionNotified(
            id,
            wallet.descriptorHash,
            REASON_INACTIVITY
        );
        if (claim.heartbeatFailed && state == FrostWallets.State.Live)
            moveFunds(self, id, REASON_HEARTBEAT_FAILURE);
    }

    /// @dev The claimed seats are non-empty, strictly ascending and in the
    /// roster; returns their descriptor operators.
    function claimedOperators(
        address[] storage operators,
        uint16[] memory seats
    ) private view returns (address[] memory claimed) {
        require(seats.length > 0, "FROST inactivity seats");
        claimed = new address[](seats.length);
        uint256 previous;
        for (uint256 i = 0; i < seats.length; i++) {
            uint256 seat = seats[i];
            require(
                seat > previous && seat <= operators.length,
                "FROST inactivity seats"
            );
            previous = seat;
            claimed[i] = operators[seat - 1];
        }
    }

    /// @dev At least `threshold` strictly ascending roster seats outside the
    /// claimed set, each signed by its descriptor operator.
    function verifySigners(
        FrostWallets.Wallet storage wallet,
        bytes32 message,
        InactivityClaim memory claim
    ) private view {
        address[] storage operators = wallet.descriptor.operators;
        uint16[] memory seats = claim.signingSeats;
        uint16[] memory inactive = claim.inactiveSeats;
        require(
            seats.length >= wallet.descriptor.threshold &&
                claim.signatures.length == seats.length * 65,
            "FROST inactivity signers"
        );
        uint256 previous;
        uint256 j;
        for (uint256 i = 0; i < seats.length; i++) {
            uint256 seat = seats[i];
            // Both lists ascend, so one walk finds a claimed signer.
            while (j < inactive.length && inactive[j] < seat) j++;
            require(
                seat > previous &&
                    seat <= operators.length &&
                    (j == inactive.length || inactive[j] != seat),
                "FROST inactivity signers"
            );
            previous = seat;
            (address signer, ECDSA.RecoverError error) = ECDSA.tryRecover(
                message,
                claim.signatures.slice(i * 65, 65)
            );
            require(
                error == ECDSA.RecoverError.NoError &&
                    signer == operators[seat - 1],
                "FROST inactivity signature"
            );
        }
    }

    /// @notice The digest each signing seat's operator signs as an Ethereum
    /// signed message.
    function inactivityDigest(
        BridgeState.Storage storage self,
        bytes32 id,
        uint64 nonce,
        uint16[] memory inactiveSeats,
        bool heartbeatFailed
    ) private view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    INACTIVITY_DOMAIN,
                    block.chainid,
                    address(this),
                    id,
                    self.frost.wallets[bytes20(id)].descriptorHash,
                    nonce,
                    inactiveSeats,
                    heartbeatFailed
                )
            );
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
