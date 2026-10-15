// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

/// @notice Exact C-07 API; an address implementing it is not qualification evidence.
interface IFrostVerifier {
    function isValidKey(bytes32 key) external view returns (bool);

    function verify(
        bytes32 key,
        bytes32 message,
        bytes calldata signature
    ) external view returns (bool);

    function tapTweak(bytes32 internalKey, bytes32 merkleRoot)
        external
        view
        returns (
            bool valid,
            bytes32 outputKey,
            uint8 parity
        );
}
