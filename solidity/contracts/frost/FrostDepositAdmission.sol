// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "../bridge/BitcoinTx.sol";
import "./FrostFundingState.sol";
import "./FrostBitcoinEncoding.sol";
import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";
import {BytesLib} from "@keep-network/bitcoin-spv-sol/contracts/BytesLib.sol";
import "./FrostExposureState.sol";

/// @notice Exact C-05 deposit reveal. Reveal alone creates no Bank credit or
/// recognized custody; those effects require the separate sweep SPV consumer.
library FrostDepositAdmission {
    using BTCUtils for bytes;
    using BytesLib for bytes;

    struct Output {
        bytes32 key;
        bytes32 root;
        uint8 parity;
    }

    struct Construction {
        Output output;
        bytes32 receipt;
        bytes walletLeaf;
        bytes refundLeaf;
        bytes walletControl;
        bytes refundControl;
    }

    event FrostDepositRevealed(
        bytes32 indexed outpoint,
        bytes32 indexed walletId,
        address indexed depositor,
        bytes32 receipt,
        uint64 amount
    );

    function output(
        BridgeState.Storage storage bridge,
        FrostFundingState.Storage storage funding,
        FrostDepositProfile.Terms memory terms
    ) external view returns (Output memory) {
        require(
            funding.configuration.addressesEnabled,
            "FROST addresses disabled"
        );
        return validateTerms(bridge, funding, terms);
    }

    function reveal(
        BridgeState.Storage storage bridge,
        FrostFundingState.Storage storage funding,
        FrostDepositProfile.Terms memory terms,
        BitcoinTx.Info memory transaction,
        uint32 outputIndex
    ) external returns (bytes32 outpoint) {
        require(funding.configuration.revealEnabled, "FROST reveal disabled");
        FrostExposureState.requireAdmission(bridge.frostExposure);
        require(!funding.entered, "FROST funding reentry");
        require(terms.depositor == msg.sender, "FROST depositor");
        funding.entered = true;
        Output memory expected = validateTerms(bridge, funding, terms);
        FrostBitcoinEncoding.validateVector(transaction.inputVector, true);
        FrostBitcoinEncoding.validateVector(transaction.outputVector, false);
        require(transaction.inputVector.validateVin(), "FROST funding inputs");
        require(
            transaction.outputVector.validateVout(),
            "FROST funding outputs"
        );
        bytes memory actual = transaction.outputVector.extractOutputAtIndex(
            outputIndex
        );
        require(actual.length == 43, "FROST funding output length");
        require(actual.extractValue() == terms.amount, "FROST funding value");
        require(
            keccak256(actual.slice(8, 3)) == keccak256(hex"225120") &&
                actual.slice(11, 32).toBytes32() == expected.key,
            "FROST funding script"
        );
        bytes32 txHash = sha256(
            abi.encodePacked(
                sha256(
                    abi.encodePacked(
                        transaction.version,
                        transaction.inputVector,
                        transaction.outputVector,
                        transaction.locktime
                    )
                )
            )
        );
        outpoint = keccak256(abi.encodePacked(txHash, outputIndex));
        require(
            funding.deposits[outpoint].revealedAt == 0 &&
                bridge.deposits[uint256(outpoint)].revealedAt == 0 &&
                bridge.frostCustody.outputs[outpoint].walletId == bytes32(0) &&
                !bridge.spentMainUTXOs[uint256(outpoint)],
            "FROST funding identity occupied"
        );
        // Rebate and optimistic adapter paths need their own reviewed C-05
        // accounting; never silently register this receipt as a legacy deposit.
        require(bridge.rebateStaking == address(0), "FROST rebate unsupported");
        uint64 treasuryFee = bridge.depositTreasuryFeeDivisor == 0
            ? 0
            : terms.amount / bridge.depositTreasuryFeeDivisor;
        require(
            terms.amount >= bridge.depositDustThreshold &&
                uint256(terms.amount) >
                uint256(treasuryFee) + bridge.depositTxMaxFee,
            "FROST deposit fee capacity"
        );
        FrostFundingState.Deposit storage deposit = funding.deposits[outpoint];
        deposit.terms = terms;
        deposit.receipt = FrostDepositProfile.receipt(terms);
        deposit.fundingTransactionHash = txHash;
        deposit.fundingOutputIndex = outputIndex;
        deposit.depositOutputKey = expected.key;
        deposit.walletKey = bridge
            .frost
            .wallets[bytes20(terms.fullWalletId)]
            .descriptor
            .outputKey;
        deposit.merkleRoot = expected.root;
        deposit.outputParity = expected.parity;
        deposit.treasuryFee = treasuryFee;
        deposit.maximumSweepFee = bridge.depositTxMaxFee;
        /* solhint-disable-next-line not-rely-on-time */
        deposit.revealedAt = uint64(block.timestamp);
        funding.pendingReveals[terms.fullWalletId]++;
        funding.entered = false;
        emit FrostDepositRevealed(
            outpoint,
            terms.fullWalletId,
            terms.depositor,
            deposit.receipt,
            terms.amount
        );
    }

    function construction(
        BridgeState.Storage storage bridge,
        FrostFundingState.Storage storage funding,
        FrostDepositProfile.Terms memory terms
    ) external view returns (Construction memory) {
        require(
            funding.configuration.addressesEnabled,
            "FROST addresses disabled"
        );
        return
            buildConstruction(
                terms,
                bridge
                    .frost
                    .wallets[bytes20(terms.fullWalletId)]
                    .descriptor
                    .outputKey,
                validateTerms(bridge, funding, terms)
            );
    }

    /// @notice Historical refund data remains available during admission or
    /// verifier pauses, independent of current wallet funding eligibility.
    function refundConstruction(
        FrostFundingState.Storage storage funding,
        bytes32 outpoint
    ) external view returns (Construction memory) {
        FrostFundingState.Deposit storage deposit = funding.deposits[outpoint];
        require(deposit.revealedAt != 0, "FROST deposit unknown");
        return
            buildConstruction(
                deposit.terms,
                deposit.walletKey,
                Output(
                    deposit.depositOutputKey,
                    deposit.merkleRoot,
                    deposit.outputParity
                )
            );
    }

    function buildConstruction(
        FrostDepositProfile.Terms memory terms,
        bytes32 key,
        Output memory outputInfo
    ) private pure returns (Construction memory result) {
        result.output = outputInfo;
        result.receipt = FrostDepositProfile.receipt(terms);
        result.walletLeaf = FrostDepositProfile.walletLeaf(terms, key);
        result.refundLeaf = FrostDepositProfile.refundLeaf(terms);
        result.walletControl = FrostDepositProfile.controlBlock(
            FrostDepositProfile.leafHash(result.refundLeaf),
            outputInfo.parity
        );
        result.refundControl = FrostDepositProfile.controlBlock(
            FrostDepositProfile.leafHash(result.walletLeaf),
            outputInfo.parity
        );
    }

    function validateTerms(
        BridgeState.Storage storage bridge,
        FrostFundingState.Storage storage funding,
        FrostDepositProfile.Terms memory terms
    ) private view returns (Output memory result) {
        FrostFundingState.Configuration storage config = funding.configuration;
        require(
            terms.chainId == block.chainid &&
                terms.bridge == address(this) &&
                terms.bitcoinGenesis == config.bitcoinGenesis &&
                config.bitcoinGenesis != bytes32(0),
            "FROST deposit binding"
        );
        FrostWallets.Wallet storage wallet = bridge.frost.wallets[
            bytes20(terms.fullWalletId)
        ];
        require(
            wallet.id == terms.fullWalletId &&
                wallet.descriptorHash == terms.descriptorHash &&
                !wallet.quarantined &&
                wallet.capabilityVersion > 0 &&
                (wallet.state == FrostWallets.State.ReadyUnfunded ||
                    wallet.state == FrostWallets.State.Live),
            "FROST deposit wallet"
        );
        require(
            terms.vault == address(0) || bridge.isVaultTrusted[terms.vault],
            "FROST vault untrusted"
        );
        // C-05 captures the existing refund policy in Unix seconds, matching CLTV.
        /* solhint-disable not-rely-on-time */
        require(
            uint256(terms.refundLocktime) >=
                block.timestamp + bridge.depositRevealAheadPeriod,
            "FROST refund too soon"
        );
        /* solhint-enable not-rely-on-time */
        require(
            config.verifier.code.length > 0 &&
                config.verifier.codehash == config.verifierCodeHash,
            "FROST verifier identity"
        );
        IFrostDepositVerifier verifier = IFrostDepositVerifier(config.verifier);
        require(
            verifier.isValidKey(terms.refundKey) &&
                verifier.isValidKey(wallet.descriptor.outputKey),
            "FROST deposit curve key"
        );
        result.root = FrostDepositProfile.root(
            terms,
            wallet.descriptor.outputKey
        );
        bool valid;
        (valid, result.key, result.parity) = verifier.tapTweak(
            FrostDepositProfile.internalKey(),
            result.root
        );
        require(valid && result.parity < 2, "FROST deposit tweak");
    }
}
