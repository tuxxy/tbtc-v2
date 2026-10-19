// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "../bridge/BitcoinTx.sol";
import "./FrostCustody.sol";
import "./FrostWallets.sol";
import "./FrostFundingState.sol";
import "./FrostMovementState.sol";
import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";
import {BytesLib} from "@keep-network/bitcoin-spv-sol/contracts/BytesLib.sol";

/// @notice C-06 FROST fund movement and receiving sweeps.
/// A commitment binds ordered target labels and their immutable descriptors.
/// A movement proof records every output as a pending incoming obligation of
/// its committed target, whatever the target's state by then. The target's own
/// key is the only recovery: an incoming output leaves the pending set only
/// through a proven sweep by that target, and a timeout escalates it instead
/// of dropping it.
library FrostMovement {
    using BTCUtils for bytes;
    using BytesLib for bytes;

    uint16 internal constant MAX_SWEEP_INPUTS = 128;

    event FrostMovingFundsCommitted(
        bytes32 indexed walletId,
        uint32 period,
        bytes32 mainOutpoint,
        bytes20[] targets,
        bytes32[] descriptorHashes
    );
    event FrostMovingFundsCompleted(
        bytes32 indexed walletId,
        bytes32 indexed transactionHash
    );
    event FrostIncomingRecorded(
        bytes32 indexed outpoint,
        bytes32 indexed target,
        bytes32 source,
        uint64 value,
        bytes32 transactionHash,
        uint32 outputIndex
    );
    event FrostMovedFundsSwept(
        bytes32 indexed walletId,
        bytes32 indexed transactionHash,
        uint64 value
    );
    event FrostMovingFundsEscalated(bytes32 indexed walletId);
    event FrostMovingFundsTimeoutReset(bytes32 indexed walletId);
    event FrostIncomingEscalated(bytes32 indexed outpoint);
    event FrostMovingFundsBelowDust(bytes32 indexed walletId, uint64 value);
    event FrostWalletReopened(bytes32 indexed walletId);
    event FrostDepositExpired(bytes32 indexed depositKey);

    /// @notice Commit the targets of a FROST wallet in MovingFunds. Any seat
    /// operator may submit. The commitment is accepted once per period.
    function commit(
        BridgeState.Storage storage self,
        bytes32 walletId,
        uint16 seat,
        bytes20[] calldata targets
    ) external {
        FrostWallets.Wallet storage source = self.frost.wallets[
            bytes20(walletId)
        ];
        require(
            walletId != bytes32(0) &&
                source.id == walletId &&
                source.state == FrostWallets.State.MovingFunds,
            "FROST movement source"
        );
        require(
            seat < source.descriptor.operators.length &&
                source.descriptor.operators[seat] == msg.sender,
            "FROST movement operator"
        );
        FrostMovementState.Storage storage movement = self.frostMovement;
        FrostMovementState.Commitment storage commitment = FrostMovementState
            .current(movement, walletId);
        require(
            commitment.mainOutpoint == bytes32(0) &&
                !movement.lifecycles[walletId].dust,
            "FROST movement committed"
        );
        requireClear(self, walletId);
        FrostCustody.Wallet storage custody = self.frostCustody.wallets[
            walletId
        ];
        require(
            custody.mainOutpoint != bytes32(0) &&
                custody.value > 0 &&
                self.frostCustody.outputs[custody.mainOutpoint].value ==
                custody.value,
            "FROST movement balance"
        );
        uint256 maxTransfer = self.walletMaxBtcTransfer;
        uint256 needed = (uint256(custody.value) + maxTransfer - 1) /
            maxTransfer;
        uint256 expected = movement.eligibleTargets < needed
            ? movement.eligibleTargets
            : needed;
        require(expected > 0, "FROST movement no target");
        require(targets.length == expected, "FROST movement target count");
        uint160 previous = 0;
        for (uint256 i = 0; i < targets.length; i++) {
            bytes20 label = targets[i];
            require(
                uint160(label) > previous && label != bytes20(walletId),
                "FROST movement target order"
            );
            previous = uint160(label);
            FrostWallets.Wallet storage target = self.frost.wallets[label];
            require(
                FrostWallets.isMovementTarget(target),
                "FROST movement target"
            );
            commitment.targets.push(label);
            commitment.descriptorHashes.push(target.descriptorHash);
            movement.inboundCommitments[target.id]++;
        }
        commitment.mainOutpoint = custody.mainOutpoint;
        /* solhint-disable-next-line not-rely-on-time */
        commitment.committedAt = uint64(block.timestamp);
        emit FrostMovingFundsCommitted(
            walletId,
            movement.lifecycles[walletId].period,
            commitment.mainOutpoint,
            commitment.targets,
            commitment.descriptorHashes
        );
    }

    /// @notice Prove the committed movement. Outputs follow the commitment in
    /// order, each `OP_1 PUSH32 Q` of its committed target, with the legacy
    /// equal split and total fee cap. The source moves to Closing.
    function prove(
        BridgeState.Storage storage self,
        bytes32 walletId,
        BitcoinTx.Info calldata transaction,
        BitcoinTx.Proof calldata proof
    ) external {
        FrostMovementState.Storage storage movement = self.frostMovement;
        FrostMovementState.Commitment storage commitment = FrostMovementState
            .current(movement, walletId);
        FrostWallets.Wallet storage source = self.frost.wallets[
            bytes20(walletId)
        ];
        require(
            walletId != bytes32(0) &&
                source.id == walletId &&
                commitment.mainOutpoint != bytes32(0) &&
                commitment.provenAt == 0 &&
                (source.state == FrostWallets.State.MovingFunds ||
                    source.state == FrostWallets.State.Terminated),
            "FROST movement commitment"
        );
        require(transaction.version == hex"02000000", "FROST movement version");
        bytes32 txHash = BitcoinTx.validateProof(self, transaction, proof);
        FrostCustody.Wallet storage custody = self.frostCustody.wallets[
            walletId
        ];
        bytes32 main = commitment.mainOutpoint;
        {
            bytes memory inputs = transaction.inputVector;
            require(
                inputs.length == 42 &&
                    inputs[0] == 0x01 &&
                    inputs[37] == 0x00 &&
                    inputKey(inputs, 1) == main &&
                    custody.mainOutpoint == main &&
                    custody.activeReservation == bytes32(0) &&
                    !self.spentMainUTXOs[uint256(main)],
                "FROST movement input"
            );
        }
        uint64 mainValue = self.frostCustody.outputs[main].value;
        uint256 total = recordOutputs(
            self,
            walletId,
            commitment,
            transaction.outputVector,
            txHash
        );
        require(
            total <= mainValue &&
                mainValue - total <= self.movingFundsTxMaxTotalFee,
            "FROST movement fee"
        );
        self.frostCustody.outputs[main].spent = true;
        custody.value -= mainValue;
        custody.mainOutpoint = bytes32(0);
        custody.stateVersion += 1;
        self.spentMainUTXOs[uint256(main)] = true;
        /* solhint-disable-next-line not-rely-on-time */
        commitment.provenAt = uint64(block.timestamp);
        if (source.state == FrostWallets.State.MovingFunds) {
            source.state = FrostWallets.State.Closing;
            movement.lifecycles[walletId].closingStartedAt = commitment
                .provenAt;
        }
        emit FrostMovingFundsCompleted(walletId, txHash);
    }

    function recordOutputs(
        BridgeState.Storage storage self,
        bytes32 walletId,
        FrostMovementState.Commitment storage commitment,
        bytes memory outputs,
        bytes32 txHash
    ) private returns (uint256 total) {
        uint256 n = commitment.targets.length;
        require(
            outputs.length == 1 + n * 43 && uint8(outputs[0]) == n,
            "FROST movement output count"
        );
        uint64[] memory values = new uint64[](n);
        for (uint256 i = 0; i < n; i++) {
            bytes memory output = outputs.slice(1 + i * 43, 43);
            FrostWallets.Wallet storage target = self.frost.wallets[
                commitment.targets[i]
            ];
            require(
                target.descriptorHash == commitment.descriptorHashes[i] &&
                    keccak256(output.slice(8, 3)) == keccak256(hex"225120") &&
                    output.slice(11, 32).toBytes32() ==
                    target.descriptor.outputKey,
                "FROST movement output key"
            );
            values[i] = output.extractValue();
            total += values[i];
        }
        uint256 remainder = total % n;
        uint256 minimum = (total - remainder) / n;
        for (uint256 i = 0; i < n; i++) {
            require(
                values[i] > 0 &&
                    values[i] >= minimum &&
                    values[i] <= minimum + remainder,
                "FROST movement split"
            );
            bytes32 targetId = self.frost.wallets[commitment.targets[i]].id;
            recordIncoming(
                self,
                targetId,
                walletId,
                txHash,
                uint32(i),
                values[i]
            );
            self.frostMovement.inboundCommitments[targetId]--;
        }
    }

    /// @dev Records one output as its target's pending incoming obligation.
    function recordIncoming(
        BridgeState.Storage storage self,
        bytes32 targetId,
        bytes32 sourceId,
        bytes32 txHash,
        uint32 index,
        uint64 value
    ) internal {
        bytes32 key = FrostCustody.outpointKey(txHash, index);
        FrostMovementState.Incoming storage incoming = self
            .frostMovement
            .incoming[key];
        require(
            incoming.state == FrostMovementState.IncomingState.Unknown &&
                !self.spentMainUTXOs[uint256(key)] &&
                self.frostCustody.outputs[key].walletId == bytes32(0),
            "FROST incoming duplicate"
        );
        incoming.target = targetId;
        incoming.source = sourceId;
        incoming.value = value;
        /* solhint-disable-next-line not-rely-on-time */
        incoming.createdAt = uint64(block.timestamp);
        incoming.state = FrostMovementState.IncomingState.Pending;
        self.frostMovement.pendingIncoming[targetId]++;
        emit FrostIncomingRecorded(
            key,
            targetId,
            sourceId,
            value,
            txHash,
            index
        );
    }

    /// @notice Prove a target's sweep of incoming moved outputs. Inputs are
    /// the target's main (required when present) and one or more of its
    /// pending or escalated incoming outputs. A Closing target that gains a
    /// main returns to MovingFunds with a fresh commitment period.
    function sweep(
        BridgeState.Storage storage self,
        bytes32 walletId,
        BitcoinTx.Info calldata transaction,
        BitcoinTx.Proof calldata proof
    ) external {
        FrostWallets.Wallet storage wallet = self.frost.wallets[
            bytes20(walletId)
        ];
        FrostWallets.State state = wallet.state;
        require(
            walletId != bytes32(0) &&
                wallet.id == walletId &&
                (state == FrostWallets.State.ReadyUnfunded ||
                    state == FrostWallets.State.Live ||
                    state == FrostWallets.State.MovingFunds ||
                    state == FrostWallets.State.Closing ||
                    state == FrostWallets.State.Terminated),
            "FROST incoming wallet"
        );
        require(transaction.version == hex"02000000", "FROST incoming version");
        bytes32 txHash = BitcoinTx.validateProof(self, transaction, proof);
        uint64 value;
        {
            bytes memory outputs = transaction.outputVector;
            require(
                outputs.length == 44 && outputs[0] == 0x01,
                "FROST incoming output count"
            );
            bytes memory output = outputs.slice(1, 43);
            require(
                keccak256(output.slice(8, 3)) == keccak256(hex"225120") &&
                    output.slice(11, 32).toBytes32() ==
                    wallet.descriptor.outputKey,
                "FROST incoming output key"
            );
            value = output.extractValue();
        }
        FrostCustody.Wallet storage custody = self.frostCustody.wallets[
            walletId
        ];
        require(
            custody.activeReservation == bytes32(0),
            "FROST incoming main reserved"
        );
        uint256 total = consumeIncoming(
            self,
            walletId,
            transaction.inputVector
        );
        require(
            value > 0 &&
                total >= value &&
                total - value <= self.movedFundsSweepTxMaxTotalFee,
            "FROST incoming fee"
        );
        bytes32 main = custody.mainOutpoint;
        if (main != bytes32(0)) {
            self.frostCustody.outputs[main].spent = true;
            custody.value -= self.frostCustody.outputs[main].value;
            custody.mainOutpoint = bytes32(0);
            self.spentMainUTXOs[uint256(main)] = true;
        }
        require(
            !self.spentMainUTXOs[uint256(FrostCustody.outpointKey(txHash, 0))],
            "FROST incoming output consumed"
        );
        FrostCustody.credit(
            self.frostCustody,
            walletId,
            custody.generation,
            txHash,
            0,
            value
        );
        if (state == FrostWallets.State.ReadyUnfunded) {
            wallet.state = FrostWallets.State.Live;
        } else if (state == FrostWallets.State.Closing) {
            // A late arrival reopens the wallet: its new main must move again.
            wallet.state = FrostWallets.State.MovingFunds;
            FrostMovementState.Lifecycle storage lifecycle = self
                .frostMovement
                .lifecycles[walletId];
            lifecycle.period += 1;
            /* solhint-disable-next-line not-rely-on-time */
            lifecycle.movingFundsRequestedAt = uint64(block.timestamp);
            lifecycle.closingStartedAt = 0;
            lifecycle.dust = false;
            emit FrostWalletReopened(walletId);
        }
        emit FrostMovedFundsSwept(walletId, txHash, value);
    }

    function consumeIncoming(
        BridgeState.Storage storage self,
        bytes32 walletId,
        bytes memory inputs
    ) private returns (uint256 total) {
        (uint256 extra, uint256 count) = inputs.parseVarInt();
        require(
            extra == 0 && count > 0 && count <= MAX_SWEEP_INPUTS,
            "FROST incoming inputs bound"
        );
        require(inputs.length == 1 + count * 41, "FROST incoming input length");
        bytes32 main = self.frostCustody.wallets[walletId].mainOutpoint;
        bool mainFound = false;
        uint256 incomingCount = 0;
        for (uint256 i = 0; i < count; i++) {
            uint256 offset = 1 + i * 41;
            require(inputs[offset + 36] == 0x00, "FROST incoming scriptSig");
            bytes32 key = inputKey(inputs, offset);
            require(
                !self.spentMainUTXOs[uint256(key)],
                "FROST incoming input consumed"
            );
            if (main != bytes32(0) && key == main) {
                require(!mainFound, "FROST incoming main duplicate");
                mainFound = true;
                total += self.frostCustody.outputs[key].value;
                continue;
            }
            FrostMovementState.Incoming storage incoming = self
                .frostMovement
                .incoming[key];
            require(
                incoming.target == walletId &&
                    (incoming.state ==
                        FrostMovementState.IncomingState.Pending ||
                        incoming.state ==
                        FrostMovementState.IncomingState.Escalated),
                "FROST incoming input"
            );
            incoming.state = FrostMovementState.IncomingState.Swept;
            self.spentMainUTXOs[uint256(key)] = true;
            self.frostMovement.pendingIncoming[walletId]--;
            total += incoming.value;
            incomingCount++;
        }
        require(
            incomingCount > 0 && mainFound == (main != bytes32(0)),
            "FROST incoming input set"
        );
    }

    /// @notice Escalate an unproven commitment past the moving funds timeout.
    /// The commitment stays provable; C-09 attaches the sanction.
    function notifyMovingFundsTimeout(
        BridgeState.Storage storage self,
        bytes32 walletId
    ) external {
        FrostMovementState.Commitment storage commitment = FrostMovementState
            .current(self.frostMovement, walletId);
        require(
            walletId != bytes32(0) &&
                self.frost.wallets[bytes20(walletId)].id == walletId &&
                self.frost.wallets[bytes20(walletId)].state ==
                FrostWallets.State.MovingFunds &&
                commitment.provenAt == 0 &&
                !commitment.escalated,
            "FROST movement timeout state"
        );
        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp >
                uint256(
                    self
                        .frostMovement
                        .lifecycles[walletId]
                        .movingFundsRequestedAt
                ) +
                    self.movingFundsTimeout,
            "FROST movement timeout"
        );
        commitment.escalated = true;
        emit FrostMovingFundsEscalated(walletId);
    }

    /// @notice With no eligible target, restart the moving funds clock.
    function resetMovingFundsTimeout(
        BridgeState.Storage storage self,
        bytes32 walletId
    ) external {
        FrostMovementState.Lifecycle storage lifecycle = self
            .frostMovement
            .lifecycles[walletId];
        require(
            walletId != bytes32(0) &&
                self.frost.wallets[bytes20(walletId)].id == walletId &&
                self.frost.wallets[bytes20(walletId)].state ==
                FrostWallets.State.MovingFunds &&
                FrostMovementState
                    .current(self.frostMovement, walletId)
                    .mainOutpoint ==
                bytes32(0) &&
                self.frostMovement.eligibleTargets == 0,
            "FROST movement reset state"
        );
        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp >
                uint256(lifecycle.movingFundsRequestedAt) +
                    self.movingFundsTimeoutResetDelay,
            "FROST movement reset delay"
        );
        /* solhint-disable-next-line not-rely-on-time */
        lifecycle.movingFundsRequestedAt = uint64(block.timestamp);
        FrostMovementState
            .current(self.frostMovement, walletId)
            .escalated = false;
        emit FrostMovingFundsTimeoutReset(walletId);
    }

    /// @notice Escalate an incoming output its target has not swept in time.
    /// It stays sweepable by the target and keeps blocking its closure.
    function notifyMovedFundsSweepTimeout(
        BridgeState.Storage storage self,
        bytes32 outpoint
    ) external {
        FrostMovementState.Incoming storage incoming = self
            .frostMovement
            .incoming[outpoint];
        require(
            incoming.state == FrostMovementState.IncomingState.Pending,
            "FROST incoming timeout state"
        );
        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp >
                uint256(incoming.createdAt) + self.movedFundsSweepTimeout,
            "FROST incoming timeout"
        );
        incoming.state = FrostMovementState.IncomingState.Escalated;
        emit FrostIncomingEscalated(outpoint);
    }

    /// @notice Record a below-dust main as retained dust and begin closing.
    /// Unlike the legacy rule, every other obligation must be clear first.
    function notifyBelowDust(BridgeState.Storage storage self, bytes32 walletId)
        external
    {
        FrostWallets.Wallet storage wallet = self.frost.wallets[
            bytes20(walletId)
        ];
        FrostMovementState.Lifecycle storage lifecycle = self
            .frostMovement
            .lifecycles[walletId];
        uint64 value = self.frostCustody.wallets[walletId].value;
        require(
            walletId != bytes32(0) &&
                wallet.id == walletId &&
                wallet.state == FrostWallets.State.MovingFunds &&
                FrostMovementState
                    .current(self.frostMovement, walletId)
                    .mainOutpoint ==
                bytes32(0) &&
                value < self.movingFundsDustThreshold,
            "FROST movement dust state"
        );
        requireClear(self, walletId);
        lifecycle.dust = true;
        wallet.state = FrostWallets.State.Closing;
        /* solhint-disable-next-line not-rely-on-time */
        lifecycle.closingStartedAt = uint64(block.timestamp);
        emit FrostMovingFundsBelowDust(walletId, value);
    }

    /// @notice Stop counting a revealed, unswept deposit past its refund
    /// locktime. The depositor can refund it without operators; a later sweep
    /// of it is still credited but does not decrement the count again.
    function expireDeposit(BridgeState.Storage storage self, bytes32 key)
        external
    {
        FrostFundingState.Deposit storage deposit = self.frostFunding.deposits[
            key
        ];
        require(
            deposit.revealedAt != 0 &&
                deposit.sweptAt == 0 &&
                deposit.expiredAt == 0,
            "FROST deposit expiry state"
        );
        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp > deposit.terms.refundLocktime,
            "FROST deposit not expired"
        );
        /* solhint-disable-next-line not-rely-on-time */
        deposit.expiredAt = uint64(block.timestamp);
        self.frostFunding.pendingReveals[deposit.terms.fullWalletId]--;
        emit FrostDepositExpired(key);
    }

    /// @dev Obligations that block a commitment or a dust closure.
    function requireClear(BridgeState.Storage storage self, bytes32 walletId)
        private
        view
    {
        require(
            self.frostCustody.wallets[walletId].activeReservation ==
                bytes32(0) &&
                self.frostRedemptions.ledger.escrow[walletId] == 0 &&
                self.frostMovement.pendingIncoming[walletId] == 0 &&
                self.frostMovement.inboundCommitments[walletId] == 0 &&
                self.frostFunding.pendingReveals[walletId] == 0,
            "FROST movement obligations"
        );
    }

    function inputKey(bytes memory inputs, uint256 offset)
        private
        pure
        returns (bytes32)
    {
        bytes32 hash = inputs.slice(offset, 32).toBytes32();
        uint32 outputIndex;
        for (uint256 j = 0; j < 4; j++)
            outputIndex |=
                uint32(uint8(inputs[offset + 32 + j])) <<
                uint32(8 * j);
        return FrostCustody.outpointKey(hash, outputIndex);
    }
}
