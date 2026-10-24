// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/MovingFunds.sol";

// Component-only guard witness. This deliberately bypasses SPV and seeds its
// own isolated storage; it is not a public-upgrade or valid-Bitcoin witness.
contract FrostConsumedSweepFixture {
    BridgeState.Storage internal self;
    bytes20 constant WALLET = bytes20(uint160(1));
    bytes32 constant HASH = bytes32(uint256(2));

    constructor() {
        self.movedFundsSweepRequests[uint256(keccak256(abi.encodePacked(HASH, uint32(0))))] =
            MovingFunds.MovedFundsSweepRequest(WALLET, 1000, 1, MovingFunds.MovedFundsSweepRequestState.Pending);
        self.registeredWallets[WALLET].pendingMovedFundsSweepRequestsCount = 1;
    }

    function consume() external returns (uint256) {
        // One validly encoded input, with the seeded request's outpoint.
        bytes memory vin = abi.encodePacked(hex"01", HASH, hex"0000000000ffffffff");
        return MovingFunds.processMovedFundsSweepTxInputs(self, vin, BitcoinTx.UTXO(bytes32(0), 0, 0), WALLET);
    }

    function frame() external view returns (MovingFunds.MovedFundsSweepRequestState, uint32) {
        return (self.movedFundsSweepRequests[uint256(keccak256(abi.encodePacked(HASH, uint32(0))))].state,
            self.registeredWallets[WALLET].pendingMovedFundsSweepRequestsCount);
    }
}
