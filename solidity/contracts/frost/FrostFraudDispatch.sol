// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "./IFrostFraudBridge.sol";
import "./FrostFraud.sol";

/// @notice Selector dispatch for the C-08 entrypoints, reached from the end of
/// FrostMovementDispatch.dispatch.
library FrostFraudDispatch {
    function dispatch(BridgeState.Storage storage self, bytes calldata input)
        external
        returns (bytes memory)
    {
        bytes4 selector = bytes4(input[:4]);
        bytes calldata args = input[4:];
        if (selector == IFrostFraudBridge.submitFrostFraudChallenge.selector) {
            (bytes32 id, bytes32 digest, bytes memory signature) = abi.decode(
                args,
                (bytes32, bytes32, bytes)
            );
            FrostFraud.submit(self, id, digest, signature);
        } else if (
            selector == IFrostFraudBridge.defeatFrostFraudChallenge.selector
        ) {
            FrostFraud.defeat(self, abi.decode(args, (FrostFraud.Defense)));
        } else if (
            selector ==
            IFrostFraudBridge.defeatFrostFraudChallengeWithHeartbeat.selector
        ) {
            (bytes32 id, uint64 nonce) = abi.decode(args, (bytes32, uint64));
            FrostFraud.defeatHeartbeat(self, id, nonce);
        } else if (
            selector ==
            IFrostFraudBridge.notifyFrostFraudChallengeDefeatTimeout.selector
        ) {
            (bytes32 id, bytes32 digest) = abi.decode(args, (bytes32, bytes32));
            FrostFraud.notifyTimeout(self, id, digest);
        } else if (selector == IFrostFraudBridge.frostFraudChallenge.selector) {
            (bytes32 id, bytes32 digest) = abi.decode(args, (bytes32, bytes32));
            return
                abi.encode(
                    self.frostFraud.challenges[
                        FrostFraudState.challengeKey(id, digest)
                    ]
                );
        } else if (
            selector == IFrostFraudBridge.frostProvenTransaction.selector
        ) {
            return
                abi.encode(
                    self.frostFraud.provenTransactions[
                        abi.decode(args, (bytes32))
                    ]
                );
        } else if (selector == IFrostFraudBridge.frostOpenChallenges.selector) {
            return
                abi.encode(
                    self.frostFraud.openChallenges[abi.decode(args, (bytes32))]
                );
        } else if (
            selector == IFrostFraudBridge.frostHeartbeatDigest.selector
        ) {
            (bytes32 id, uint64 nonce) = abi.decode(args, (bytes32, uint64));
            return abi.encode(FrostFraud.heartbeatDigest(id, nonce));
        } else {
            revert("FROST unknown selector");
        }
        return bytes("");
    }
}
