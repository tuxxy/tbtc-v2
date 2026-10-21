// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

interface ILegacyWalletOwnerForDrain {
    function __ecdsaWalletCreatedCallback(
        bytes32 id,
        bytes32 x,
        bytes32 y
    ) external;
}

/// @dev Controlled legacy ECDSA registry root for the C-06 drain route only:
/// no DKG, sortition or threshold ECDSA evidence. Membership is a fixed member
/// address; seize and close are recorded, not enforced. All Bridge state
/// changes go through the actual public callback.
contract FrostDrainRegistryFixture {
    address private immutable owner = msg.sender;
    address public walletOwner;
    address public member;
    bool private creating;
    uint256 public closed;
    uint256 public seized;

    function bindWalletOwner(address bridge) external {
        require(
            msg.sender == owner && walletOwner == address(0),
            "Fixture binding"
        );
        walletOwner = bridge;
    }

    function setMember(address account) external {
        require(msg.sender == owner, "Fixture owner");
        member = account;
    }

    function getWalletCreationState() external view returns (uint8) {
        return creating ? 1 : creationState;
    }

    /// @dev C-10: a settable legacy DKG state (0 IDLE, 1 AWAITING_SEED,
    /// 2 AWAITING_RESULT, 3 CHALLENGE) and sortition pool lock. The fixture
    /// is its own pool, as WalletRegistry.sortitionPool() names one.
    uint8 public creationState;
    bool public isLocked;

    function setCreationState(uint8 state) external {
        require(msg.sender == owner && state <= 3, "Fixture owner");
        creationState = state;
    }

    function setPoolLocked(bool locked) external {
        require(msg.sender == owner, "Fixture owner");
        isLocked = locked;
    }

    function sortitionPool() external view returns (address) {
        return address(this);
    }

    function requestNewWallet() external {
        require(msg.sender == walletOwner && !creating, "Fixture request");
        creating = true;
    }

    function publish(
        bytes32 id,
        bytes32 x,
        bytes32 y
    ) external {
        require(msg.sender == owner, "Fixture publication");
        creating = false;
        ILegacyWalletOwnerForDrain(walletOwner).__ecdsaWalletCreatedCallback(
            id,
            x,
            y
        );
    }

    function isWalletMember(
        bytes32,
        uint32[] calldata,
        address operator,
        uint256
    ) external view returns (bool) {
        return operator == member;
    }

    function seize(
        uint96,
        uint256,
        address,
        bytes32,
        uint32[] calldata
    ) external {
        seized++;
    }

    function closeWallet(bytes32) external {
        closed++;
    }
}
