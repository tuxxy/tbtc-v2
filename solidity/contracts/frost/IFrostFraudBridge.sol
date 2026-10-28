// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "./FrostFraud.sol";

/// @notice C-08 fraud entrypoints of the Bridge's FROST extension.
interface IFrostFraudBridge {
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

    /// @dev The only payable FROST entrypoint; the bond is the legacy
    ///      fraudChallengeDepositAmount.
    function submitFrostFraudChallenge(
        bytes32 walletId,
        bytes32 digest,
        bytes calldata signature
    ) external payable;

    function defeatFrostFraudChallenge(FrostFraud.Defense calldata defense)
        external;

    function defeatFrostFraudChallengeWithHeartbeat(
        bytes32 walletId,
        uint64 nonce
    ) external;

    function notifyFrostFraudChallengeDefeatTimeout(
        bytes32 walletId,
        bytes32 digest
    ) external;

    function frostFraudChallenge(bytes32 walletId, bytes32 digest)
        external
        view
        returns (FrostFraudState.Challenge memory);

    function frostProvenTransaction(bytes32 transactionHash)
        external
        view
        returns (bytes32 walletId);

    function frostOpenChallenges(bytes32 walletId)
        external
        view
        returns (uint64);

    function frostHeartbeatDigest(bytes32 walletId, uint64 nonce)
        external
        view
        returns (bytes32);
}
