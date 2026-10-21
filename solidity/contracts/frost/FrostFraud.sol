// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "../bridge/BitcoinTx.sol";
import "./FrostWallets.sol";
import "./FrostCustody.sol";
import "./FrostFundingState.sol";
import "./FrostDepositProfile.sol";
import "./FrostMovementState.sol";
import "./FrostFraudState.sol";
import "./IFrostVerifier.sol";
import {BytesLib} from "@keep-network/bitcoin-spv-sol/contracts/BytesLib.sol";

/// @notice C-08 FROST fraud admission and exact defenses.
///
/// Admission takes any 32-byte digest with a strict BIP340 signature under the
/// wallet key Q, so signatures outside the honest profile (other hash types,
/// annexes, foreign scripts, raw digests) are actionable.
///
/// A transaction defense rebuilds the BIP341 SIGHASH_DEFAULT signature message
/// for one input (key path under Q, or the wallet leaf of one of the wallet's
/// deposits) and requires it to equal the challenged digest. SIGHASH_DEFAULT
/// commits to every input, prevout and output, so the digest authorizes that
/// one transaction only. The transaction must then be authorized: accepted by
/// a FROST proof, named by an admitted redemption intent (payment,
/// cancellation alternative or sweep resolution), matching a recorded
/// movement commitment exactly, or a self-transfer under the sweep fee policy
/// (every input the wallet's own, the only output paying Q; this covers a
/// deposit or incoming sweep that never mined). A heartbeat defense uses its
/// own tagged domain.
library FrostFraud {
    using BytesLib for bytes;

    uint8 internal constant AUTH_PROVEN = 1;
    uint8 internal constant AUTH_INTENT = 2;
    uint8 internal constant AUTH_MOVEMENT = 3;
    uint8 internal constant AUTH_SELF = 4;
    uint256 internal constant MAX_INPUTS = 128;
    uint256 internal constant MAX_OUTPUTS = 128;
    bytes32 internal constant HEARTBEAT_TAG =
        sha256("tbtc-v2/frost-heartbeat/v1");

    struct Prevout {
        uint64 value;
        bytes script;
    }

    struct Defense {
        bytes32 walletId;
        BitcoinTx.Info transaction;
        Prevout[] prevouts;
        uint32 inputIndex;
        // Zero for a key-path spend; the deposit wallet leaf hash otherwise.
        bytes32 leafHash;
        uint8 authorization;
        // Reservation ID for an intent, or the commitment period.
        bytes32 authorizationRef;
    }

    struct Parsed {
        bytes32 txHash;
        uint256 inputs;
        bytes outpoints;
        bytes sequences;
        bytes32 challenged;
    }

    event FrostFraudChallengeSubmitted(
        bytes32 indexed walletId,
        bytes32 indexed digest,
        bytes signature
    );
    event FrostFraudChallengeDefeated(
        bytes32 indexed walletId,
        bytes32 indexed digest
    );
    event FrostFraudChallengeDefeatTimedOut(
        bytes32 indexed walletId,
        bytes32 indexed digest
    );
    event FrostSanctionNotified(
        bytes32 indexed walletId,
        bytes32 descriptorHash,
        bytes32 reason
    );

    function submit(
        BridgeState.Storage storage self,
        bytes32 walletId,
        bytes32 digest,
        bytes calldata signature
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
            "FROST fraud wallet"
        );
        require(
            msg.value >= self.fraudChallengeDepositAmount,
            "FROST fraud deposit"
        );
        address verifier = self.frostFunding.configuration.verifier;
        require(
            verifier != address(0) &&
                verifier.codehash ==
                self.frostFunding.configuration.verifierCodeHash &&
                IFrostVerifier(verifier).verify(
                    wallet.descriptor.outputKey,
                    digest,
                    signature
                ),
            "FROST fraud signature"
        );
        bytes32 key = FrostFraudState.challengeKey(walletId, digest);
        FrostFraudState.Challenge storage challenge = self
            .frostFraud
            .challenges[key];
        require(challenge.reportedAt == 0, "FROST fraud challenge exists");
        challenge.walletId = walletId;
        challenge.digest = digest;
        challenge.challenger = msg.sender;
        /* solhint-disable-next-line not-rely-on-time */
        challenge.reportedAt = uint64(block.timestamp);
        challenge.depositAmount = msg.value;
        self.frostFraud.openChallenges[walletId]++;
        emit FrostFraudChallengeSubmitted(walletId, digest, signature);
    }

    /// @notice Defeat a challenge on a digest of an authorized transaction.
    function defeat(BridgeState.Storage storage self, Defense calldata defense)
        external
    {
        Parsed memory parsed = parse(defense);
        bytes32 digest = sighash(self, defense, parsed);
        authorize(self, defense, parsed);
        resolve(self, defense.walletId, digest);
    }

    /// @notice Defeat a challenge on an authorized heartbeat digest.
    function defeatHeartbeat(
        BridgeState.Storage storage self,
        bytes32 walletId,
        uint64 nonce
    ) external {
        resolve(self, walletId, heartbeatDigest(walletId, nonce));
    }

    function notifyTimeout(
        BridgeState.Storage storage self,
        bytes32 walletId,
        bytes32 digest
    ) external {
        FrostFraudState.Challenge storage challenge = self
            .frostFraud
            .challenges[FrostFraudState.challengeKey(walletId, digest)];
        require(
            challenge.reportedAt != 0 && !challenge.resolved,
            "FROST fraud challenge state"
        );
        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp >=
                uint256(challenge.reportedAt) +
                    self.fraudChallengeDefeatTimeout,
            "FROST fraud defeat timeout"
        );
        challenge.resolved = true;
        self.frostFraud.openChallenges[walletId]--;
        FrostWallets.Wallet storage wallet = self.frost.wallets[
            bytes20(walletId)
        ];
        if (
            wallet.state != FrostWallets.State.Terminated &&
            wallet.state != FrostWallets.State.Closed
        ) {
            // The wallet keeps its key and custody duties; C-09 routes the
            // sanction (D-03, OPEN).
            if (FrostWallets.isMovementTarget(wallet))
                self.frostMovement.eligibleTargets--;
            wallet.state = FrostWallets.State.Terminated;
            // Terminated at the timeout check's own clock reading.
            self.frostMovement.lifecycles[walletId].terminatedAt = uint64(
                challenge.reportedAt + self.fraudChallengeDefeatTimeout
            );
        }
        emit FrostSanctionNotified(
            walletId,
            wallet.descriptorHash,
            keccak256("fraud-defeat-timeout")
        );
        emit FrostFraudChallengeDefeatTimedOut(walletId, digest);
        // Return the deposit last; the challenge is already resolved.
        // slither-disable-next-line arbitrary-send-eth,low-level-calls,unchecked-lowlevel
        /* solhint-disable-next-line avoid-low-level-calls */
        challenge.challenger.call{gas: 100000, value: challenge.depositAmount}(
            ""
        );
    }

    function heartbeatDigest(bytes32 walletId, uint64 nonce)
        internal
        pure
        returns (bytes32)
    {
        return
            sha256(
                abi.encodePacked(HEARTBEAT_TAG, HEARTBEAT_TAG, walletId, nonce)
            );
    }

    function resolve(
        BridgeState.Storage storage self,
        bytes32 walletId,
        bytes32 digest
    ) private {
        FrostFraudState.Challenge storage challenge = self
            .frostFraud
            .challenges[FrostFraudState.challengeKey(walletId, digest)];
        require(
            challenge.reportedAt != 0 && !challenge.resolved,
            "FROST fraud challenge state"
        );
        challenge.resolved = true;
        self.frostFraud.openChallenges[walletId]--;
        emit FrostFraudChallengeDefeated(walletId, digest);
        // slither-disable-next-line arbitrary-send-eth,low-level-calls,unchecked-lowlevel
        /* solhint-disable-next-line avoid-low-level-calls */
        self.treasury.call{gas: 100000, value: challenge.depositAmount}("");
    }

    /// @dev Parses the input vector: empty scriptSigs only, bounded count.
    function parse(Defense calldata defense)
        private
        pure
        returns (Parsed memory parsed)
    {
        BitcoinTx.Info calldata transaction = defense.transaction;
        require(transaction.version == hex"02000000", "FROST defense version");
        bytes memory inputs = transaction.inputVector;
        uint256 n = uint8(inputs[0]);
        require(
            n > 0 &&
                n <= MAX_INPUTS &&
                inputs.length == 1 + n * 41 &&
                defense.prevouts.length == n &&
                defense.inputIndex < n,
            "FROST defense inputs"
        );
        parsed.inputs = n;
        parsed.outpoints = new bytes(n * 36);
        parsed.sequences = new bytes(n * 4);
        for (uint256 i = 0; i < n; i++) {
            uint256 offset = 1 + i * 41;
            require(inputs[offset + 36] == 0x00, "FROST defense scriptSig");
            for (uint256 j = 0; j < 36; j++)
                parsed.outpoints[i * 36 + j] = inputs[offset + j];
            for (uint256 j = 0; j < 4; j++)
                parsed.sequences[i * 4 + j] = inputs[offset + 37 + j];
        }
        parsed.challenged = outpointKeyAt(parsed.outpoints, defense.inputIndex);
        parsed.txHash = sha256(
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
    }

    /// @dev BIP341 SIGHASH_DEFAULT message with no annex, then the tagged
    /// hash "TapSighash" of 0x00 ‖ sigmsg. Key path (spend type 0) or the
    /// deposit wallet leaf (spend type 2, key version 0, no code separator).
    function sighash(
        BridgeState.Storage storage self,
        Defense calldata defense,
        Parsed memory parsed
    ) private view returns (bytes32) {
        (uint8 spendType, bytes memory extension) = spend(
            self,
            defense,
            parsed
        );
        bytes32 tag = sha256("TapSighash");
        return
            sha256(
                abi.encodePacked(
                    tag,
                    tag,
                    hex"0000",
                    common(defense, parsed),
                    spendType,
                    littleEndian32(defense.inputIndex),
                    extension
                )
            );
    }

    /// @dev nVersion ‖ nLockTime ‖ sha_prevouts ‖ sha_amounts ‖
    /// sha_scriptpubkeys ‖ sha_sequences ‖ sha_outputs.
    function common(Defense calldata defense, Parsed memory parsed)
        private
        pure
        returns (bytes memory)
    {
        bytes memory amounts;
        bytes memory scripts;
        for (uint256 i = 0; i < parsed.inputs; i++) {
            Prevout calldata prevout = defense.prevouts[i];
            require(
                prevout.value <= FrostCustody.MAX_SATOSHI &&
                    prevout.script.length < 253,
                "FROST defense prevout"
            );
            amounts = abi.encodePacked(amounts, littleEndian64(prevout.value));
            scripts = abi.encodePacked(
                scripts,
                uint8(prevout.script.length),
                prevout.script
            );
        }
        bytes memory outputs = defense.transaction.outputVector;
        uint256 outputCount = uint8(outputs[0]);
        require(
            outputCount > 0 && outputCount <= MAX_OUTPUTS,
            "FROST defense outputs"
        );
        return
            abi.encodePacked(
                defense.transaction.version,
                defense.transaction.locktime,
                sha256(parsed.outpoints),
                sha256(amounts),
                sha256(scripts),
                sha256(parsed.sequences),
                sha256(outputs.slice(1, outputs.length - 1))
            );
    }

    /// @dev The challenged input is a key-path spend of Q, or the wallet leaf
    /// of one of this wallet's revealed deposits.
    function spend(
        BridgeState.Storage storage self,
        Defense calldata defense,
        Parsed memory parsed
    ) private view returns (uint8, bytes memory) {
        bytes calldata script = defense.prevouts[defense.inputIndex].script;
        bytes32 q = self
            .frost
            .wallets[bytes20(defense.walletId)]
            .descriptor
            .outputKey;
        if (defense.leafHash == bytes32(0)) {
            require(
                keccak256(script) == keccak256(abi.encodePacked(hex"5120", q)),
                "FROST defense key path"
            );
            return (0, "");
        }
        FrostFundingState.Deposit storage deposit = self.frostFunding.deposits[
            parsed.challenged
        ];
        require(
            deposit.revealedAt != 0 &&
                deposit.terms.fullWalletId == defense.walletId &&
                keccak256(script) ==
                keccak256(
                    abi.encodePacked(hex"5120", deposit.depositOutputKey)
                ) &&
                defense.leafHash ==
                FrostDepositProfile.leafHash(
                    FrostDepositProfile.walletLeaf(deposit.terms, q)
                ),
            "FROST defense deposit leaf"
        );
        return (2, abi.encodePacked(defense.leafHash, hex"00ffffffff"));
    }

    function authorize(
        BridgeState.Storage storage self,
        Defense calldata defense,
        Parsed memory parsed
    ) private view {
        if (defense.authorization == AUTH_PROVEN) {
            require(
                self.frostFraud.provenTransactions[parsed.txHash] ==
                    defense.walletId,
                "FROST defense proven transaction"
            );
        } else if (defense.authorization == AUTH_INTENT) {
            FrostRedemptionLedger.Intent storage intent = self
                .frostRedemptions
                .ledger
                .intents[defense.authorizationRef];
            bytes32 h = parsed.txHash;
            require(
                intent.certificate.walletId == defense.walletId &&
                    (h == intent.transactionHash ||
                        h == intent.cancellationHash ||
                        h == intent.sweepResolutionHash ||
                        self
                            .frostRedemptions
                            .cancellationHistory
                            .histories[defense.authorizationRef]
                            .extras[h]
                            .transactionHash ==
                        h),
                "FROST defense intent"
            );
        } else if (defense.authorization == AUTH_MOVEMENT) {
            movement(self, defense, parsed);
        } else if (defense.authorization == AUTH_SELF) {
            selfTransfer(self, defense, parsed);
        } else {
            revert("FROST defense authorization");
        }
    }

    /// @dev The exact C-06 commitment relation, whether or not it was mined.
    function movement(
        BridgeState.Storage storage self,
        Defense calldata defense,
        Parsed memory parsed
    ) private view {
        require(
            uint256(defense.authorizationRef) <= type(uint32).max,
            "FROST defense movement period"
        );
        FrostMovementState.Commitment storage commitment = self
            .frostMovement
            .commitments[
                FrostMovementState.commitmentKey(
                    defense.walletId,
                    uint32(uint256(defense.authorizationRef))
                )
            ];
        bytes32 main = commitment.mainOutpoint;
        uint256 n = commitment.targets.length;
        bytes memory outputs = defense.transaction.outputVector;
        require(
            main != bytes32(0) &&
                parsed.inputs == 1 &&
                parsed.challenged == main &&
                outputs.length == 1 + n * 43 &&
                uint8(outputs[0]) == n,
            "FROST defense movement shape"
        );
        uint256 total;
        uint256[] memory values = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            FrostWallets.Wallet storage target = self.frost.wallets[
                commitment.targets[i]
            ];
            uint256 offset = 1 + i * 43;
            require(
                target.descriptorHash == commitment.descriptorHashes[i] &&
                    outputs[offset + 8] == 0x22 &&
                    outputs[offset + 9] == 0x51 &&
                    outputs[offset + 10] == 0x20 &&
                    outputs.slice(offset + 11, 32).toBytes32() ==
                    target.descriptor.outputKey,
                "FROST defense movement output"
            );
            for (uint256 j = 0; j < 8; j++)
                values[i] |= uint256(uint8(outputs[offset + j])) << (8 * j);
            total += values[i];
        }
        uint256 remainder = total % n;
        uint256 minimum = (total - remainder) / n;
        for (uint256 i = 0; i < n; i++)
            require(
                values[i] > 0 &&
                    values[i] >= minimum &&
                    values[i] <= minimum + remainder,
                "FROST defense movement split"
            );
        // The fee policy in force at commitment authorized this signature;
        // a later governance change cannot revoke its defense.
        uint256 mainValue = self.frostCustody.outputs[main].value;
        require(
            total <= mainValue && mainValue - total <= commitment.maxFee,
            "FROST defense movement fee"
        );
    }

    /// @dev A transfer from the wallet to itself under the sweep fee policy,
    /// mined or not (D-05 test value, OPEN). Every input is a key-path output
    /// of Q or a revealed deposit of this wallet, and the only output pays Q.
    /// The fee cap is the sum of the deposit inputs' maximumSweepFee (fixed at
    /// reveal) plus the largest sweepFeeCap among the key-path inputs that are
    /// incoming outputs recorded for this wallet (fixed at their movement
    /// proof). Any other key-path input, such as the main, adds nothing: a
    /// deposit sweep's fee is covered by its deposits, the C-05 rule. Both
    /// parts are fixed when the input was recorded, so no later parameter
    /// change revokes a defense; the host keeps an incoming sweep within the
    /// live cap and the recorded caps to stay both provable and defensible.
    /// SIGHASH_DEFAULT commits to every prevout amount and script, so
    /// the supplied prevouts are the ones the wallet signed: a digest rebuilt
    /// over other prevouts would not equal the challenged one.
    function selfTransfer(
        BridgeState.Storage storage self,
        Defense calldata defense,
        Parsed memory parsed
    ) private view {
        bytes32 q = self
            .frost
            .wallets[bytes20(defense.walletId)]
            .descriptor
            .outputKey;
        bytes32 keyPathScript = keccak256(abi.encodePacked(hex"5120", q));
        uint256 total;
        uint256 cap;
        uint256 incomingCap;
        for (uint256 i = 0; i < parsed.inputs; i++) {
            Prevout calldata prevout = defense.prevouts[i];
            // Each value is at most MAX_SATOSHI (checked in common).
            total += prevout.value;
            bytes32 script = keccak256(prevout.script);
            bytes32 key = outpointKeyAt(parsed.outpoints, i);
            if (script == keyPathScript) {
                FrostMovementState.Incoming storage incoming = self
                    .frostMovement
                    .incoming[key];
                if (
                    incoming.target == defense.walletId &&
                    incoming.state !=
                    FrostMovementState.IncomingState.Unknown &&
                    incoming.sweepFeeCap > incomingCap
                ) incomingCap = incoming.sweepFeeCap;
                continue;
            }
            FrostFundingState.Deposit storage deposit = self
                .frostFunding
                .deposits[key];
            require(
                deposit.revealedAt != 0 &&
                    deposit.terms.fullWalletId == defense.walletId &&
                    script ==
                    keccak256(
                        abi.encodePacked(hex"5120", deposit.depositOutputKey)
                    ),
                "FROST defense self input"
            );
            cap += deposit.maximumSweepFee;
        }
        cap += incomingCap;
        // 0x01 ‖ value (8 bytes LE) ‖ 0x22 ‖ OP_1 PUSH32 Q.
        bytes memory outputs = defense.transaction.outputVector;
        require(
            outputs.length == 44 &&
                outputs[0] == 0x01 &&
                outputs[9] == 0x22 &&
                outputs[10] == 0x51 &&
                outputs[11] == 0x20 &&
                outputs.slice(12, 32).toBytes32() == q,
            "FROST defense self output"
        );
        uint256 value;
        for (uint256 j = 0; j < 8; j++)
            value |= uint256(uint8(outputs[1 + j])) << (8 * j);
        require(
            value <= total && total - value <= cap,
            "FROST defense self fee"
        );
    }

    /// @dev The shared outpoint key of input `i` from the 36-byte outpoints.
    function outpointKeyAt(bytes memory outpoints, uint256 i)
        private
        pure
        returns (bytes32)
    {
        uint256 offset = i * 36;
        uint32 index;
        for (uint256 j = 0; j < 4; j++)
            index |= uint32(uint8(outpoints[offset + 32 + j])) << uint32(8 * j);
        return
            FrostCustody.outpointKey(
                outpoints.slice(offset, 32).toBytes32(),
                index
            );
    }

    function littleEndian64(uint64 value) private pure returns (bytes8 out) {
        uint64 swapped;
        for (uint256 i = 0; i < 8; i++)
            swapped |= ((value >> (8 * i)) & 0xff) << (8 * (7 - i));
        return bytes8(swapped);
    }

    function littleEndian32(uint32 value) private pure returns (bytes4) {
        uint32 swapped;
        for (uint256 i = 0; i < 4; i++)
            swapped |= ((value >> (8 * i)) & 0xff) << (8 * (3 - i));
        return bytes4(swapped);
    }
}
