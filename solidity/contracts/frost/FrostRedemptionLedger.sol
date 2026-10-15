// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bank/Bank.sol";
import "./FrostSigningIntent.sol";
import "./FrostCustody.sol";
import "../bridge/BitcoinTx.sol";

/// @notice Separate FROST request escrow; legacy request keys and slots remain intact.
/// @dev The Bridge caller must first verify the registered wallet, capabilities,
///      custody capacity and watchtower policy. This library cannot admit custody.
library FrostRedemptionLedger {
    enum State {
        Unknown,
        Requested,
        Reserved,
        TimeoutPending,
        Paid,
        Refunded,
        Refundable
    }

    struct Request {
        bytes32 walletId;
        bytes32 descriptorHash;
        bytes32 reservationId;
        address redeemer;
        uint64 gross;
        uint64 treasuryFee;
        uint64 maximumBitcoinFee;
        uint64 deadline;
        uint64 finalityBlocks;
        uint64 timeoutBlock;
        State state;
        bytes script;
    }

    struct Storage {
        mapping(bytes32 => Request) requests;
        mapping(bytes32 => uint64) requestNonce;
        mapping(bytes32 => uint64) escrow;
        mapping(bytes32 => uint64) netLiability;
        mapping(bytes32 => Intent) intents;
    }

    enum IntentState {
        Unknown,
        Reserved,
        Paid,
        Cancelled,
        TimeoutPending,
        Quarantined,
        ConflictResolved
    }

    struct Intent {
        FrostReservationCertificate.Reservation certificate;
        uint64 admittedBlock;
        bytes32 snapshot;
        bytes32 transactionHash;
        IntentState state;
        bytes32[] requestIds;
        uint64[] payouts;
        BitcoinTx.UTXO[] inputs;
        uint16[] seats;
        bytes signatures;
        bytes32 cancellationHash;
        bytes32 cancellationSnapshot;
        uint64 cancellationFee;
        address cancellationSponsor;
        uint64 cancellationAdmittedBlock;
        uint16[] cancellationSeats;
        bytes cancellationSignatures;
        uint64 reservedNet;
        uint64 cancellationValidUntilBlock;
        // Append-only proof resolution archive; original/cancellation records remain.
        bytes32 sweepResolutionHash;
        uint64 sweepResolutionBlock;
        uint64 sweepResolutionValidUntilBlock;
        uint16[] sweepResolutionSeats;
        bytes32 sweepResolutionSignaturesHash;
        bytes32 sweepResolutionAuthorizationHash;
    }

    event FrostReservationAdmitted(
        bytes32 indexed reservationId,
        bytes32 indexed walletId,
        bytes32 intentCommitment,
        bytes32 transactionHash,
        uint64 generation,
        uint64 stateVersion
    );

    function outpointKey(bytes32 txHash, uint32 index)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(txHash, index));
    }

    /// @dev Caller authenticates the stored descriptor/certificate, rebuilds
    /// the canonical snapshot from recognized inputs, and checks the fee sum.
    function reserve(
        Storage storage self,
        FrostCustody.Storage storage custody,
        FrostReservationCertificate.Reservation memory certificate,
        FrostSigningIntent.Plan memory plan,
        bytes32 transactionHash,
        BitcoinTx.UTXO[] memory inputs,
        uint16[] memory seats,
        bytes memory signatures
    ) internal returns (bytes32 id) {
        FrostCustody.Wallet storage wallet = custody.wallets[
            certificate.walletId
        ];
        require(
            wallet.mainOutpoint != bytes32(0) &&
                wallet.activeReservation == bytes32(0),
            "FROST reservation custody state"
        );
        require(
            certificate.generation == wallet.generation + 1 &&
                certificate.stateVersion == wallet.stateVersion,
            "FROST reservation counter"
        );
        require(
            wallet.mainOutpoint ==
                outpointKey(
                    certificate.conflictTxHash,
                    certificate.conflictOutputIndex
                ),
            "FROST conflict is not main custody"
        );
        require(
            inputs.length > 0 &&
                inputs.length <= FrostSigningIntent.MAX_INPUTS &&
                transactionHash != bytes32(0),
            "FROST reservation inputs"
        );
        bool conflictFound;
        for (uint256 i = 0; i < inputs.length; i++) {
            bytes32 key = outpointKey(
                inputs[i].txHash,
                inputs[i].txOutputIndex
            );
            FrostCustody.Output storage output = custody.outputs[key];
            require(
                output.walletId == certificate.walletId &&
                    !output.spent &&
                    output.value == inputs[i].txOutputValue,
                "FROST input not recognized custody"
            );
            if (key == wallet.mainOutpoint) conflictFound = true;
        }
        require(conflictFound, "FROST conflict input missing");
        require(
            block.number <= type(uint64).max,
            "FROST admission block overflow"
        );
        id = FrostReservationCertificate.reservationId(
            address(this),
            certificate
        );
        Intent storage intent = self.intents[id];
        require(
            intent.state == IntentState.Unknown,
            "FROST intent already used"
        );
        require(
            plan.requests.length > 0 &&
                plan.requests.length <= FrostSigningIntent.MAX_REQUESTS,
            "FROST request batch"
        );
        // Each duplicate reaches Reserved on its second occurrence and rolls
        // back the entire admission. No quadratic request-ID scan is needed.
        for (uint256 i = 0; i < plan.requests.length; i++) {
            FrostSigningIntent.Request memory entitlement = plan.requests[i];
            Request storage pending = self.requests[entitlement.id];
            // Captured request/deadline timing is required by KC-SF-V3 C-04.
            // solhint-disable-next-line not-rely-on-time
            require(
                pending.state == State.Requested &&
                    pending.reservationId == bytes32(0) &&
                    // solhint-disable-next-line not-rely-on-time
                    block.timestamp < pending.deadline,
                "FROST request not reservable"
            );
            require(
                pending.walletId == certificate.walletId &&
                    pending.descriptorHash == certificate.descriptorHash &&
                    keccak256(pending.script) == keccak256(entitlement.script),
                "FROST request binding"
            );
            uint64 available = pending.gross - pending.treasuryFee;
            require(
                entitlement.value > 0 &&
                    entitlement.value <= available &&
                    available - entitlement.value <= pending.maximumBitcoinFee,
                "FROST captured request fee"
            );
            pending.state = State.Reserved;
            pending.reservationId = id;
            intent.reservedNet += available;
            intent.requestIds.push(entitlement.id);
            intent.payouts.push(entitlement.value);
        }
        intent.certificate = certificate;
        intent.admittedBlock = uint64(block.number);
        intent.snapshot = plan.snapshot;
        intent.transactionHash = transactionHash;
        intent.state = IntentState.Reserved;
        for (uint256 i = 0; i < inputs.length; i++)
            intent.inputs.push(inputs[i]);
        for (uint256 i = 0; i < seats.length; i++) intent.seats.push(seats[i]);
        intent.signatures = signatures;
        wallet.generation = certificate.generation;
        wallet.activeReservation = id;
        emit FrostReservationAdmitted(
            id,
            certificate.walletId,
            certificate.intentCommitment,
            transactionHash,
            certificate.generation,
            certificate.stateVersion
        );
    }

    function unresolved(Intent storage intent) internal view returns (bool) {
        return
            intent.state == IntentState.Reserved ||
            intent.state == IntentState.TimeoutPending ||
            intent.state == IntentState.Quarantined;
    }

    function requireRequestCapacity(
        Storage storage self,
        FrostCustody.Storage storage custody,
        bytes32 walletId,
        uint64 net
    ) internal view {
        FrostCustody.Wallet storage wallet = custody.wallets[walletId];
        require(
            uint256(self.netLiability[walletId]) + net <=
                wallet.value - wallet.cancellationExposure,
            "FROST insufficient recognized custody"
        );
    }

    function cancellationExposureFor(
        Storage storage self,
        FrostCustody.Storage storage custody,
        bytes32 id,
        uint64 fee
    ) internal view returns (uint64) {
        Intent storage intent = self.intents[id];
        FrostCustody.Wallet storage wallet = custody.wallets[
            intent.certificate.walletId
        ];
        require(
            wallet.activeReservation == id &&
                fee <= wallet.value &&
                self.netLiability[intent.certificate.walletId] >=
                intent.reservedNet &&
                wallet.value - fee >=
                self.netLiability[intent.certificate.walletId] -
                    intent.reservedNet,
            "FROST cancellation strands liabilities"
        );
        return fee > intent.reservedNet ? fee - intent.reservedNet : 0;
    }

    /// @dev The caller has verified SPV inclusion and the exact admitted bytes.
    function pay(
        Storage storage self,
        FrostCustody.Storage storage custody,
        Bank bank,
        address treasury,
        bytes32 id,
        uint64 changeValue,
        uint32 changeIndex
    ) internal {
        Intent storage intent = self.intents[id];
        require(unresolved(intent), "FROST intent already resolved");
        intent.state = IntentState.Paid;
        uint64 burn;
        uint64 fees;
        for (uint256 i = 0; i < intent.requestIds.length; i++) {
            Request storage pending = self.requests[intent.requestIds[i]];
            require(
                pending.reservationId == id &&
                    (pending.state == State.Reserved ||
                        pending.state == State.TimeoutPending),
                "FROST settlement request state"
            );
            pending.state = State.Paid;
            self.escrow[pending.walletId] -= pending.gross;
            uint64 net = pending.gross - pending.treasuryFee;
            self.netLiability[pending.walletId] -= net;
            burn += net;
            fees += pending.treasuryFee;
        }
        replaceCustody(
            self,
            custody,
            intent,
            intent.transactionHash,
            changeValue,
            changeIndex
        );
        bank.decreaseBalance(burn);
        if (fees > 0) bank.transferBalance(treasury, fees);
        // Confirmed payment spends the shared conflict input, invalidating the
        // approved cancellation. Its independent fee budget can now return.
        if (intent.cancellationFee > 0)
            bank.transferBalance(
                intent.cancellationSponsor,
                intent.cancellationFee
            );
    }

    /// @dev Cancellation fees have their own funded Bank budget. Burning that
    /// budget reconciles the lost custody; request escrow refunds remain whole.
    function cancel(
        Storage storage self,
        FrostCustody.Storage storage custody,
        Bank bank,
        bytes32 id,
        uint64 changeValue,
        uint32 changeIndex
    ) internal {
        Intent storage intent = self.intents[id];
        require(
            unresolved(intent) &&
                intent.cancellationHash != bytes32(0) &&
                intent.cancellationFee > 0,
            "FROST cancellation not authorized"
        );
        cancelSelected(
            self,
            custody,
            bank,
            id,
            intent.cancellationHash,
            intent.cancellationFee,
            changeValue,
            changeIndex
        );
    }

    /// @dev Caller proves and authenticates the selected immutable alternative.
    function cancelSelected(
        Storage storage self,
        FrostCustody.Storage storage custody,
        Bank bank,
        bytes32 id,
        bytes32 transactionHash,
        uint64 fee,
        uint64 changeValue,
        uint32 changeIndex
    ) internal {
        Intent storage intent = self.intents[id];
        require(
            unresolved(intent) && transactionHash != bytes32(0) && fee > 0,
            "FROST cancellation not authorized"
        );
        intent.state = IntentState.Cancelled;
        for (uint256 i = 0; i < intent.requestIds.length; i++) {
            Request storage pending = self.requests[intent.requestIds[i]];
            require(
                pending.reservationId == id &&
                    (pending.state == State.Reserved ||
                        pending.state == State.TimeoutPending),
                "FROST cancellation request state"
            );
            pending.state = State.Refunded;
            self.escrow[pending.walletId] -= pending.gross;
            self.netLiability[pending.walletId] -=
                pending.gross -
                pending.treasuryFee;
        }
        replaceCustody(
            self,
            custody,
            intent,
            transactionHash,
            changeValue,
            changeIndex
        );
        bank.decreaseBalance(fee);
        for (uint256 i = 0; i < intent.requestIds.length; i++) {
            Request storage pending = self.requests[intent.requestIds[i]];
            bank.transferBalance(pending.redeemer, pending.gross);
            emit FrostRedemptionRefunded(
                intent.requestIds[i],
                pending.redeemer,
                pending.gross
            );
        }
    }

    event FrostReservationResolvedBySweep(
        bytes32 indexed reservationId,
        bytes32 indexed transactionHash
    );

    /// @dev Only the qualified sweep consumer calls this after proving and
    /// replacing the captured main. Unspent non-main reservation inputs remain
    /// recognized custody; a Bitcoin conflict invalidates the entire payment.
    /// Sweep fees come exclusively from new deposits under their captured caps.
    /// Refunds become individually collectible; full escrow/liability remains
    /// held until collection. No redemption escrow or unused fee budget is burned.
    function resolveSweep(
        Storage storage self,
        FrostCustody.Storage storage custody,
        Bank bank,
        bytes32 id,
        bytes32 transactionHash
    ) internal {
        Intent storage intent = self.intents[id];
        FrostCustody.Wallet storage wallet = custody.wallets[
            intent.certificate.walletId
        ];
        require(
            unresolved(intent) &&
                wallet.activeReservation == id &&
                intent.sweepResolutionHash == transactionHash &&
                transactionHash != bytes32(0) &&
                wallet.mainOutpoint == outpointKey(transactionHash, 0),
            "FROST sweep resolution state"
        );
        intent.state = IntentState.ConflictResolved;
        for (uint256 i = 0; i < intent.requestIds.length; i++) {
            Request storage pending = self.requests[intent.requestIds[i]];
            require(
                pending.reservationId == id &&
                    (pending.state == State.Reserved ||
                        pending.state == State.TimeoutPending),
                "FROST sweep resolution request"
            );
            // Keep the complete Bank escrow and conservative pending liability
            // until the bounded per-request claim actually pays the redeemer.
            pending.state = State.Refundable;
        }
        wallet.activeReservation = bytes32(0);
        wallet.cancellationExposure = 0;
        wallet.stateVersion++;
        require(
            wallet.value >= self.netLiability[intent.certificate.walletId],
            "FROST remaining custody liabilities"
        );
        for (uint256 i = 0; i < intent.requestIds.length; i++) {
            Request storage pending = self.requests[intent.requestIds[i]];
            emit FrostRedemptionRefundAvailable(
                intent.requestIds[i],
                pending.redeemer,
                pending.gross
            );
        }
        if (intent.cancellationFee > 0)
            bank.transferBalance(
                intent.cancellationSponsor,
                intent.cancellationFee
            );
        emit FrostReservationResolvedBySweep(id, transactionHash);
    }

    event FrostRedemptionRefundAvailable(
        bytes32 indexed requestId,
        address redeemer,
        uint64 gross
    );

    /// @dev Permissionless collection always credits the captured redeemer.
    /// No expiry or off-chain assertion can make a reserved request refundable.
    function refundResolved(
        Storage storage self,
        Bank bank,
        bytes32 id
    ) internal {
        Request storage pending = self.requests[id];
        require(
            pending.state == State.Refundable &&
                pending.reservationId != bytes32(0) &&
                self.intents[pending.reservationId].state ==
                IntentState.ConflictResolved,
            "FROST resolved refund state"
        );
        pending.state = State.Refunded;
        self.escrow[pending.walletId] -= pending.gross;
        self.netLiability[pending.walletId] -=
            pending.gross -
            pending.treasuryFee;
        bank.transferBalance(pending.redeemer, pending.gross);
        emit FrostRedemptionRefunded(id, pending.redeemer, pending.gross);
    }

    function replaceCustody(
        Storage storage self,
        FrostCustody.Storage storage custody,
        Intent storage intent,
        bytes32 transactionHash,
        uint64 changeValue,
        uint32 changeIndex
    ) private {
        FrostCustody.Wallet storage wallet = custody.wallets[
            intent.certificate.walletId
        ];
        require(
            wallet.activeReservation ==
                FrostReservationCertificate.reservationId(
                    address(this),
                    intent.certificate
                ),
            "FROST active intent mismatch"
        );
        for (uint256 i = 0; i < intent.inputs.length; i++) {
            BitcoinTx.UTXO storage input = intent.inputs[i];
            FrostCustody.Output storage output = custody.outputs[
                outpointKey(input.txHash, input.txOutputIndex)
            ];
            require(
                !output.spent &&
                    output.walletId == intent.certificate.walletId &&
                    output.value == input.txOutputValue,
                "FROST spent reservation input"
            );
            output.spent = true;
            wallet.value -= output.value;
        }
        bytes32 key = outpointKey(transactionHash, changeIndex);
        require(
            changeValue > 0 && custody.outputs[key].walletId == bytes32(0),
            "FROST invalid custody change"
        );
        custody.outputs[key] = FrostCustody.Output(
            intent.certificate.walletId,
            changeValue,
            false
        );
        wallet.value += changeValue;
        require(
            wallet.value <= 2100000000000000 &&
                wallet.value >= self.netLiability[intent.certificate.walletId],
            "FROST remaining custody liabilities"
        );
        wallet.mainOutpoint = key;
        wallet.activeReservation = bytes32(0);
        wallet.cancellationExposure = 0;
        wallet.stateVersion++;
    }

    struct Admission {
        bytes32 walletId;
        bytes32 descriptorHash;
        address balanceOwner;
        address redeemer;
        uint64 gross;
        uint64 treasuryFee;
        uint64 maximumBitcoinFee;
        uint64 timeoutSeconds;
        uint64 finalityBlocks;
        bytes script;
    }

    event FrostRedemptionRequested(
        bytes32 indexed requestId,
        bytes32 indexed walletId,
        address redeemer,
        uint64 gross,
        uint64 treasuryFee,
        uint64 maximumBitcoinFee,
        uint64 deadline
    );
    event FrostRedemptionTimeoutPending(
        bytes32 indexed requestId,
        bytes32 indexed reservationId,
        uint64 timeoutBlock
    );
    event FrostRedemptionRefunded(
        bytes32 indexed requestId,
        address redeemer,
        uint64 gross
    );

    function request(
        Storage storage self,
        Bank bank,
        Admission memory admission
    ) internal returns (bytes32 id) {
        require(
            admission.walletId != bytes32(0) &&
                admission.descriptorHash != bytes32(0) &&
                admission.balanceOwner != address(0) &&
                admission.redeemer != address(0),
            "FROST request identity"
        );
        require(
            admission.gross <= 2100000000000000 &&
                admission.gross > admission.treasuryFee &&
                admission.gross - admission.treasuryFee >
                admission.maximumBitcoinFee,
            "FROST positive net payout"
        );
        require(
            admission.timeoutSeconds > 0 &&
                admission.finalityBlocks > 0 &&
                FrostSigningIntent.supportedScript(admission.script),
            "FROST request policy"
        );
        // Captured request/deadline timing is required by KC-SF-V3 C-04.
        // solhint-disable-next-line not-rely-on-time
        uint256 deadline = block.timestamp + admission.timeoutSeconds;
        require(deadline <= type(uint64).max, "FROST deadline overflow");
        uint64 nonce = self.requestNonce[admission.walletId] + 1;
        id = keccak256(
            abi.encode(
                "tbtc-v2/frost-redemption-request/v1",
                block.chainid,
                address(this),
                admission.walletId,
                admission.descriptorHash,
                nonce,
                keccak256(admission.script)
            )
        );
        require(
            self.requests[id].state == State.Unknown,
            "FROST request already used"
        );
        uint64 escrow = self.escrow[admission.walletId] + admission.gross;
        require(escrow <= 2100000000000000, "FROST escrow capacity");
        self.requestNonce[admission.walletId] = nonce;
        self.escrow[admission.walletId] = escrow;
        self.netLiability[admission.walletId] +=
            admission.gross -
            admission.treasuryFee;
        self.requests[id] = Request({
            walletId: admission.walletId,
            descriptorHash: admission.descriptorHash,
            reservationId: bytes32(0),
            redeemer: admission.redeemer,
            gross: admission.gross,
            treasuryFee: admission.treasuryFee,
            maximumBitcoinFee: admission.maximumBitcoinFee,
            deadline: uint64(deadline),
            finalityBlocks: admission.finalityBlocks,
            timeoutBlock: 0,
            state: State.Requested,
            script: admission.script
        });
        // Actual Bank allowance and balance checks roll back the entire frame.
        bank.transferBalanceFrom(
            admission.balanceOwner,
            address(this),
            admission.gross
        );
        emit FrostRedemptionRequested(
            id,
            admission.walletId,
            admission.redeemer,
            admission.gross,
            admission.treasuryFee,
            admission.maximumBitcoinFee,
            uint64(deadline)
        );
    }

    function observeTimeout(Storage storage self, bytes32 id) internal {
        Request storage pending = self.requests[id];
        require(
            pending.state == State.Requested || pending.state == State.Reserved,
            "FROST timeout state"
        );
        require(
            // Captured request/deadline timing is required by KC-SF-V3 C-04.
            // solhint-disable-next-line not-rely-on-time
            block.timestamp >= pending.deadline,
            "FROST deadline not reached"
        );
        require(
            block.number <= type(uint64).max,
            "FROST timeout block overflow"
        );
        pending.state = State.TimeoutPending;
        pending.timeoutBlock = uint64(block.number);
        if (pending.reservationId != bytes32(0)) {
            Intent storage intent = self.intents[pending.reservationId];
            require(unresolved(intent), "FROST timeout resolved intent");
            if (intent.state != IntentState.Quarantined)
                intent.state = IntentState.TimeoutPending;
        }
        emit FrostRedemptionTimeoutPending(
            id,
            pending.reservationId,
            pending.timeoutBlock
        );
    }

    function refundUnreserved(
        Storage storage self,
        Bank bank,
        bytes32 id
    ) internal {
        Request storage pending = self.requests[id];
        require(
            pending.state == State.TimeoutPending &&
                pending.reservationId == bytes32(0),
            "FROST reservation retains escrow"
        );
        require(
            block.number >=
                uint256(pending.timeoutBlock) + pending.finalityBlocks,
            "FROST timeout not final"
        );
        pending.state = State.Refunded;
        self.escrow[pending.walletId] -= pending.gross;
        self.netLiability[pending.walletId] -=
            pending.gross -
            pending.treasuryFee;
        bank.transferBalance(pending.redeemer, pending.gross);
        emit FrostRedemptionRefunded(id, pending.redeemer, pending.gross);
    }
}
