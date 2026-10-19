// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "../bridge/BitcoinTx.sol";
import "./FrostFundingState.sol";
import "./FrostCustody.sol";
import "./FrostSweepResolutionCertificate.sol";
import "./FrostCancellationHistory.sol";
import "./FrostMovement.sol";
import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";
import {BytesLib} from "@keep-network/bitcoin-spv-sol/contracts/BytesLib.sol";

/// @notice Proof-backed C-05 accounting. New-reveal/address gates deliberately
/// do not gate completion of already funded deposit obligations.
library FrostDepositSweep {
    uint16 internal constant MAX_SWEEP_INPUTS = 128;
    using BTCUtils for bytes;
    using BytesLib for bytes;

    struct Accounting {
        address[] recipients;
        uint256[] amounts;
        bytes32[] deposits;
        uint256 inputsValue;
        uint256 treasuryFee;
        uint256 count;
        bool mainFound;
        uint256 processed;
    }

    struct Sweep {
        bytes32 walletId;
        BitcoinTx.Info transaction;
        BitcoinTx.Proof proof;
        bool includeMain;
        address vault;
    }

    struct Resolution {
        Sweep sweep;
        FrostSweepResolutionCertificate.Authorization authorization;
        uint16[] seats;
        bytes signatures;
    }

    /// @dev Full certificate retained in canonical transaction calldata/logs;
    /// queryable commitments bind archival retrieval to the exact authorization.
    event FrostSweepResolutionApproved(
        bytes32 indexed reservationId,
        bytes32 indexed transactionHash,
        address vault,
        uint64 validUntilBlock,
        uint16[] seats,
        bytes signatures
    );

    event FrostDepositsSwept(
        bytes32 indexed walletId,
        bytes32 indexed transactionHash,
        uint64 outputValue
    );

    function prove(
        BridgeState.Storage storage bridge,
        FrostFundingState.Storage storage funding,
        FrostCustody.Storage storage custody,
        Sweep calldata request
    ) external {
        proveSweep(bridge, funding, custody, request, bytes32(0));
    }

    /// @notice Explicit approved conflict resolution; ordinary sweep proofs
    /// continue to refuse reserved main consumption.
    function proveResolution(
        BridgeState.Storage storage bridge,
        Resolution calldata resolution
    ) external {
        require(!bridge.frostFunding.entered, "FROST funding reentry");
        bytes32 id = resolution.authorization.reservationId;
        FrostRedemptionLedger.Intent storage intent = bridge
            .frostRedemptions
            .ledger
            .intents[id];
        FrostCustody.Wallet storage balance = bridge.frostCustody.wallets[
            resolution.sweep.walletId
        ];
        require(
            resolution.sweep.includeMain &&
                FrostRedemptionLedger.unresolved(intent) &&
                intent.certificate.walletId == resolution.sweep.walletId &&
                balance.activeReservation == id &&
                balance.mainOutpoint ==
                FrostCustody.outpointKey(
                    intent.certificate.conflictTxHash,
                    intent.certificate.conflictOutputIndex
                ),
            "FROST sweep resolution conflict"
        );
        FrostWallets.Wallet storage wallet = bridge.frost.wallets[
            bytes20(resolution.sweep.walletId)
        ];
        require(
            wallet.id == resolution.sweep.walletId &&
                wallet.descriptorHash == intent.certificate.descriptorHash &&
                resolution.authorization.vault == resolution.sweep.vault,
            "FROST sweep resolution binding"
        );
        require(
            uint256(resolution.authorization.validUntilBlock) <=
                block.number +
                    bridge
                        .frostRedemptions
                        .configuration
                        .maximumCertificateBlocks &&
                FrostSweepResolutionCertificate.validate(
                    address(this),
                    wallet.descriptor,
                    resolution.authorization,
                    resolution.seats,
                    resolution.signatures
                ),
            "FROST sweep resolution certificate"
        );
        require(
            block.number <= type(uint64).max,
            "FROST resolution block overflow"
        );
        intent.sweepResolutionHash = resolution.authorization.transactionHash;
        intent.sweepResolutionBlock = uint64(block.number);
        intent.sweepResolutionValidUntilBlock = resolution
            .authorization
            .validUntilBlock;
        for (uint256 i = 0; i < resolution.seats.length; i++)
            intent.sweepResolutionSeats.push(resolution.seats[i]);
        intent.sweepResolutionSignaturesHash = keccak256(resolution.signatures);
        intent
            .sweepResolutionAuthorizationHash = FrostSweepResolutionCertificate
            .digest(address(this), resolution.authorization);
        emit FrostSweepResolutionApproved(
            id,
            resolution.authorization.transactionHash,
            resolution.authorization.vault,
            resolution.authorization.validUntilBlock,
            resolution.seats,
            resolution.signatures
        );
        proveSweep(
            bridge,
            bridge.frostFunding,
            bridge.frostCustody,
            resolution.sweep,
            id
        );
    }

    function proveSweep(
        BridgeState.Storage storage bridge,
        FrostFundingState.Storage storage funding,
        FrostCustody.Storage storage custody,
        Sweep calldata request,
        bytes32 resolutionId
    ) private {
        require(!funding.entered, "FROST funding reentry");
        funding.entered = true;
        FrostWallets.Wallet storage wallet = bridge.frost.wallets[
            bytes20(request.walletId)
        ];
        require(
            request.walletId != bytes32(0) && wallet.id == request.walletId,
            "FROST sweep wallet"
        );
        require(
            request.transaction.version == hex"02000000",
            "FROST sweep version"
        );
        bytes32 txHash = BitcoinTx.validateProof(
            bridge,
            request.transaction,
            request.proof
        );
        bytes memory outputs = request.transaction.outputVector;
        require(
            outputs.length == 44 && outputs[0] == 0x01,
            "FROST sweep output count"
        );
        bytes memory output = outputs.slice(1, 43);
        require(
            keccak256(output.slice(8, 3)) == keccak256(hex"225120") &&
                output.slice(11, 32).toBytes32() == wallet.descriptor.outputKey,
            "FROST sweep output key"
        );
        uint64 value = output.extractValue();
        require(
            value > 0 && value <= FrostCustody.MAX_SATOSHI,
            "FROST sweep value"
        );
        Accounting memory accounting = consumeInputs(
            bridge,
            funding,
            custody,
            request,
            resolutionId
        );
        require(accounting.inputsValue >= value, "FROST sweep inflation");
        uint256 fee = accounting.inputsValue - value;
        uint256 sharedFee = fee / accounting.count;
        uint256 remainder = fee % accounting.count;
        for (uint256 i = 0; i < accounting.count; i++) {
            FrostFundingState.Deposit storage deposit = funding.deposits[
                accounting.deposits[i]
            ];
            uint256 charged = sharedFee +
                (i == accounting.count - 1 ? remainder : 0);
            require(
                charged <= deposit.maximumSweepFee &&
                    uint256(deposit.terms.amount) >
                    uint256(deposit.treasuryFee) + charged,
                "FROST sweep fee capacity"
            );
            accounting.amounts[i] =
                uint256(deposit.terms.amount) -
                deposit.treasuryFee -
                charged;
            accounting.treasuryFee += deposit.treasuryFee;
        }
        creditSweep(bridge, request, txHash, value, resolutionId);
        if (wallet.state == FrostWallets.State.ReadyUnfunded)
            wallet.state = FrostWallets.State.Live;
            // A late deposit sweep into a Closing or Closed wallet reopens it.
        else FrostMovement.reopen(bridge, request.walletId);
        // Effects precede Bank/Vault callbacks; any late failure rolls back all
        // deposit tombstones, pending counters, custody and Bank credits.
        if (
            request.vault != address(0) && bridge.isVaultTrusted[request.vault]
        ) {
            bridge.bank.increaseBalanceAndCall(
                request.vault,
                accounting.recipients,
                accounting.amounts
            );
        } else {
            bridge.bank.increaseBalances(
                accounting.recipients,
                accounting.amounts
            );
        }
        if (accounting.treasuryFee != 0)
            bridge.bank.increaseBalance(
                bridge.treasury,
                accounting.treasuryFee
            );
        bridge.frostFraud.provenTransactions[txHash] = request.walletId;
        funding.entered = false;
        emit FrostDepositsSwept(request.walletId, txHash, value);
    }

    function creditSweep(
        BridgeState.Storage storage bridge,
        Sweep calldata request,
        bytes32 txHash,
        uint64 value,
        bytes32 resolutionId
    ) private {
        // Main replacement is allowed only with its canonical spend proof, and
        // cannot race a redemption reservation. Additional deposit-only sweeps
        // retain the existing main and all captured reservation inputs.
        if (request.includeMain) {
            FrostCustody.Wallet storage balance = bridge.frostCustody.wallets[
                request.walletId
            ];
            FrostCustody.Output storage main = bridge.frostCustody.outputs[
                balance.mainOutpoint
            ];
            main.spent = true;
            balance.value -= main.value;
            bridge.spentMainUTXOs[uint256(balance.mainOutpoint)] = true;
            // An unproven C-06 commitment of this main can never be proven.
            FrostMovement.onMainSpent(
                bridge,
                request.walletId,
                balance.mainOutpoint
            );
            // credit retains the captured version while resolution is active.
            // Keep the old nonzero main pointer until the new output is credited.
            if (resolutionId == bytes32(0)) balance.mainOutpoint = bytes32(0);
        }
        bytes32 newKey = FrostCustody.outpointKey(txHash, 0);
        require(
            !bridge.spentMainUTXOs[uint256(newKey)],
            "FROST sweep output consumed"
        );
        FrostCustody.credit(
            bridge.frostCustody,
            request.walletId,
            bridge.frostCustody.wallets[request.walletId].generation,
            txHash,
            0,
            value
        );
        if (resolutionId != bytes32(0)) {
            bridge.frostCustody.wallets[request.walletId].mainOutpoint = newKey;
            if (
                bridge
                    .frostRedemptions
                    .ledger
                    .intents[resolutionId]
                    .cancellationFee > 0
            ) {
                FrostCancellationHistory.recordFirstReturn(
                    bridge.frostRedemptions.cancellationHistory,
                    bridge.frostRedemptions.ledger.intents[resolutionId],
                    resolutionId
                );
            }
            FrostRedemptionLedger.resolveSweep(
                bridge.frostRedemptions.ledger,
                bridge.frostCustody,
                bridge.bank,
                resolutionId,
                txHash
            );
        }
    }

    function consumeInputs(
        BridgeState.Storage storage bridge,
        FrostFundingState.Storage storage funding,
        FrostCustody.Storage storage custody,
        Sweep calldata request,
        bytes32 resolutionId
    ) private returns (Accounting memory accounting) {
        bytes memory inputs = request.transaction.inputVector;
        (uint256 extra, uint256 count) = inputs.parseVarInt();
        require(
            count > (request.includeMain ? 1 : 0) && count <= MAX_SWEEP_INPUTS,
            "FROST sweep inputs bound"
        );
        require(
            (count < 253 && extra == 0) || (count >= 253 && extra == 2),
            "FROST sweep count encoding"
        );
        uint256 offset = extra + 1;
        require(
            inputs.length == offset + count * 41,
            "FROST sweep input length"
        );
        accounting.count = count - (request.includeMain ? 1 : 0);
        accounting.recipients = new address[](accounting.count);
        accounting.amounts = new uint256[](accounting.count);
        accounting.deposits = new bytes32[](accounting.count);
        FrostCustody.Wallet storage balance = custody.wallets[request.walletId];
        require(
            request.includeMain ||
                balance.mainOutpoint == bytes32(0) ||
                balance.activeReservation != bytes32(0),
            "FROST sweep main required"
        );
        if (request.includeMain)
            require(
                balance.activeReservation == resolutionId &&
                    balance.mainOutpoint != bytes32(0),
                "FROST sweep main reserved"
            );
        for (uint256 i = 0; i < count; i++) {
            require(inputs[offset + 36] == 0x00, "FROST sweep scriptSig");
            consumeInput(
                bridge,
                funding,
                custody,
                request,
                accounting,
                inputKey(inputs, offset)
            );
            require(
                accounting.inputsValue <= FrostCustody.MAX_SATOSHI,
                "FROST sweep total"
            );
            offset += 41;
        }
        require(
            accounting.processed == accounting.count &&
                accounting.mainFound == request.includeMain,
            "FROST sweep input set"
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

    function consumeInput(
        BridgeState.Storage storage bridge,
        FrostFundingState.Storage storage funding,
        FrostCustody.Storage storage custody,
        Sweep calldata request,
        Accounting memory accounting,
        bytes32 key
    ) private {
        require(
            !bridge.spentMainUTXOs[uint256(key)],
            "FROST sweep input consumed"
        );
        if (
            request.includeMain &&
            key == custody.wallets[request.walletId].mainOutpoint
        ) {
            require(!accounting.mainFound, "FROST sweep main duplicate");
            FrostCustody.Output storage main = custody.outputs[key];
            require(
                main.walletId == request.walletId && !main.spent,
                "FROST sweep main identity"
            );
            accounting.inputsValue += main.value;
            accounting.mainFound = true;
        } else {
            FrostFundingState.Deposit storage deposit = funding.deposits[key];
            require(
                accounting.processed < accounting.count &&
                    deposit.revealedAt != 0 &&
                    deposit.sweptAt == 0 &&
                    deposit.terms.fullWalletId == request.walletId &&
                    deposit.terms.vault == request.vault,
                "FROST sweep deposit"
            );
            require(
                bridge.deposits[uint256(key)].revealedAt == 0,
                "FROST sweep legacy identity"
            );
            /* solhint-disable-next-line not-rely-on-time */
            deposit.sweptAt = uint64(block.timestamp);
            bridge.spentMainUTXOs[uint256(key)] = true;
            funding.pendingReveals[request.walletId]--;
            accounting.inputsValue += deposit.terms.amount;
            accounting.recipients[accounting.processed] = deposit
                .terms
                .depositor;
            accounting.deposits[accounting.processed++] = key;
        }
    }
}
