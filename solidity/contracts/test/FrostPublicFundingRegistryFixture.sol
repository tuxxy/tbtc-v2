// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../frost/FrostTypes.sol";
import "../bridge/IRelay.sol";
import "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/// @dev Controlled registry root only: no DKG, readiness certificate or K-03 claim.
/// It can call public callbacks, but cannot write Bridge storage or mint Bank balances.
contract FrostPublicFundingRegistryFixture {
    address public immutable owner;
    IFrostWalletOwner public immutable walletOwner;
    uint256 public requests;

    constructor(IFrostWalletOwner bridge) {
        owner = msg.sender;
        walletOwner = bridge;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Controlled registry owner only");
        _;
    }

    function requestNewWallet() external {
        require(msg.sender == address(walletOwner), "Bridge only");
        requests++;
    }

    function created(bytes calldata descriptor, uint64 deadline)
        external
        onlyOwner
    {
        walletOwner.__snowfallWalletCreated(descriptor, deadline);
    }

    function ready(bytes32 id, bytes32 descriptorHash) external onlyOwner {
        walletOwner.__snowfallWalletReady(id, descriptorHash, 1, 1);
    }
}

/// @dev Regtest integer difficulty is zero. Actual BitcoinTx inclusion and PoW
/// validation remain active; this is not a production relay/work witness.
contract FrostPublicFundingRegtestRelay is IRelay {
    function getCurrentEpochDifficulty() external pure returns (uint256) {
        return 0;
    }

    function getPrevEpochDifficulty() external pure returns (uint256) {
        return 0;
    }
}
