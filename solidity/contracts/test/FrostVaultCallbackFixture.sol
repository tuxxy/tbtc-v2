// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bank/Bank.sol";
import "../frost/FrostRedemptionRequests.sol";

/// @dev Adversarial trusted Vault consumer, never a storage seeder or issuer.
/// Receives actual Bank credits from public C-05 sweep proofs.
contract FrostVaultCallbackFixture {
    Bank public immutable bank;
    address public immutable bridge;
    address private immutable owner = msg.sender;
    bytes[] private payloads;
    bool public revertAfterCallbacks;
    uint256 public calls;
    uint256 public observedBankBalance;
    mapping(address => uint256) public received;
    mapping(uint256 => bool) public callbackSuccess;
    mapping(uint256 => bytes) public callbackResult;

    constructor(Bank bank_, address bridge_) {
        bank = bank_;
        bridge = bridge_;
    }

    function configure(bytes[] calldata calls_, bool revertAfter) external {
        require(msg.sender == owner, "Fixture owner only");
        delete payloads;
        for (uint256 i = 0; i < calls_.length; i++) payloads.push(calls_[i]);
        revertAfterCallbacks = revertAfter;
        bank.approveBalance(bridge, 0);
        bank.approveBalance(bridge, 20000);
    }

    function receiveBalanceIncrease(
        address[] calldata depositors,
        uint256[] calldata amounts
    ) external {
        require(msg.sender == address(bank), "Bank only");
        require(depositors.length == amounts.length, "Vault lengths");
        calls++;
        observedBankBalance = bank.balanceOf(address(this));
        for (uint256 i = 0; i < depositors.length; i++)
            received[depositors[i]] += amounts[i];
        for (uint256 i = 0; i < payloads.length; i++)
            (callbackSuccess[i], callbackResult[i]) = bridge.call(payloads[i]);
        require(!revertAfterCallbacks, "Vault late failure");
    }

    /// @dev Repeat the same payload outside the callback to show a usable public path.
    function execute(bytes calldata payload)
        external
        returns (bytes memory result)
    {
        require(msg.sender == owner, "Fixture owner only");
        bool success;
        (success, result) = bridge.call(payload);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }
}

/// @dev Controlled policy service: public requests capture this service's
/// identity/policy/delay; later configuration cannot substitute another service.
contract FrostCapturedWatchtowerFixture is IFrostRedemptionWatchtower {
    bytes32 public policy;
    bytes32 public acceptedPolicy;
    uint64 public delay;
    bool public admissionAllowed = true;

    constructor(bytes32 policy_, uint64 delay_) {
        policy = policy_;
        acceptedPolicy = policy_;
        delay = delay_;
    }

    function changeRequestPolicy(bytes32 policy_, uint64 delay_) external {
        policy = policy_;
        delay = delay_;
    }

    function setAdmissionAllowed(bool value) external {
        admissionAllowed = value;
    }

    function requestPolicy(
        bytes32,
        bytes calldata,
        address,
        address,
        uint64
    )
        external
        view
        override
        returns (
            bool,
            bytes32,
            uint64
        )
    {
        return (true, policy, delay);
    }

    function isAllowed(bytes32, bytes32 policyId)
        external
        view
        override
        returns (bool)
    {
        return admissionAllowed && policyId == acceptedPolicy;
    }
}
