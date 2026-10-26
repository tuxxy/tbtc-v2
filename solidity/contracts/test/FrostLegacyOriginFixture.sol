// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/IRelay.sol";
import "../bridge/RedemptionWatchtower.sol";
import "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

interface ILegacyWalletOwnerForTest {
    function __ecdsaWalletCreatedCallback(
        bytes32 id,
        bytes32 x,
        bytes32 y
    ) external;
}

/// @dev Controlled registry root only, not DKG or threshold ECDSA evidence.
/// All Bridge state changes are through the actual public callback.
contract FrostLegacyOriginRegistryFixture {
    address private immutable owner = msg.sender;
    address public walletOwner;
    uint256 public requests;
    bool private creating;

    function bindWalletOwner(address bridge) external {
        require(
            msg.sender == owner && walletOwner == address(0),
            "Fixture binding"
        );
        walletOwner = bridge;
    }

    function getWalletCreationState() external view returns (uint8) {
        return creating ? 1 : 0;
    }

    // Controlled legacy DKG/pool observation for the public cutover witness.
    function sortitionPool() external view returns (address) {
        return address(this);
    }

    function isLocked() external pure returns (bool) {
        return false;
    }

    function requestNewWallet() external {
        require(msg.sender == walletOwner && !creating, "Fixture request");
        creating = true;
        requests++;
    }

    function publish(
        bytes32 id,
        bytes32 x,
        bytes32 y
    ) external {
        require(msg.sender == owner && creating, "Fixture publication");
        creating = false;
        ILegacyWalletOwnerForTest(walletOwner).__ecdsaWalletCreatedCallback(
            id,
            x,
            y
        );
    }

    // K-09 local legacy membership root. These adapters permit public timeout
    // and movement entry points; they do not qualify registry sanctions.
    function isWalletMember(bytes32, uint32[] calldata, address account, uint256)
        external view returns (bool)
    {
        return account == owner;
    }

    function seize(uint96, uint256, address, bytes32, uint32[] calldata) external {
        require(msg.sender == walletOwner, "Fixture caller");
    }

    function closeWallet(bytes32) external {
        require(msg.sender == walletOwner, "Fixture caller");
    }
}

/// @dev Real regtest headers/inclusion, integer difficulty zero. No production
/// confirmation-work or mainnet relay qualification is claimed.
contract FrostLegacyOriginRegtestRelay is IRelay {
    function getCurrentEpochDifficulty() external pure returns (uint256) {
        return 0;
    }

    function getPrevEpochDifficulty() external pure returns (uint256) {
        return 0;
    }
}
