// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BitcoinTx.sol";
import "../bridge/BridgeState.sol";

// K-09 second run: the production validation code with the mainnet deployment
// factor. Only the relay epoch observation is controlled, using real headers.
contract FrostLifecycleSpvFixture {
    BridgeState.Storage internal self;

    constructor(address relay) {
        self.relay = IRelay(relay);
        self.txProofDifficultyFactor = 6;
    }

    function validate(
        BitcoinTx.Info calldata transaction,
        BitcoinTx.Proof calldata proof
    ) external view returns (bytes32) {
        return BitcoinTx.validateProof(self, transaction, proof);
    }
}
