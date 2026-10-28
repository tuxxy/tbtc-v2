// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

/// @notice The C-10 exposure controller as the Bridge calls it.
interface IFrostExposureController {
    function bridge() external view returns (address);

    function contained() external view returns (bool);

    function reserve(
        bytes32 id,
        uint64 custody,
        uint64 issuance
    ) external;

    function reserveDeposit(uint64 amount) external;

    function completeDeposits(
        uint256 count,
        uint64 reserved,
        uint64 custody,
        uint64 issuance
    ) external;

    function completeOne(
        bytes32 id,
        uint64 custody,
        uint64 issuance
    ) external;

    function release(bytes32 id) external;
}
