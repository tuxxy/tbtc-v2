// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;
import "../frost/FrostTypes.sol";

// Callback-boundary fixture only. K-03 Go integration deploys the actual
// FrostWalletRegistry and validates real operator certificates.
contract FrostRegistryFixture {
    IFrostWalletOwner public immutable walletOwner;

    constructor(IFrostWalletOwner owner) {
        walletOwner = owner;
    }

    function created(bytes calldata descriptor, uint64 deadline) external {
        walletOwner.__snowfallWalletCreated(descriptor, deadline);
    }

    function ready(bytes32 id, bytes32 descriptor) external {
        walletOwner.__snowfallWalletReady(id, descriptor, 1, 1);
    }

    function expire(bytes32 id) external {
        walletOwner.__snowfallWalletExpired(id);
    }

    function requestNewWallet() external {}
}
