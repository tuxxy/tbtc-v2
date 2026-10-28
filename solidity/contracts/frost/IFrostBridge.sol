// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

/// @notice Explicit ABI for the Bridge's separately linked FROST entrypoints.
interface IFrostBridge {
    function configureFrostRegistry(address registry) external;

    function setFrostRequestsEnabled(bool enabled) external;

    function requestNewFrostWallet() external;

    function __snowfallWalletCreated(bytes calldata descriptor, uint64 deadline)
        external;

    function __snowfallWalletReady(
        bytes32 id,
        bytes32 descriptorHash,
        uint32 generation,
        uint32 capabilityVersion
    ) external;

    function __snowfallWalletExpired(bytes32 id) external;

    function frostRegistry() external view returns (address);

    function walletScheme(bytes20 label) external view returns (uint8);

    function walletDescriptor(bytes20 label)
        external
        view
        returns (bytes memory);

    function resolveWallet(address registry, bytes32 id)
        external
        view
        returns (bytes20);

    function resolveWalletOutput(bytes32 q) external view returns (bytes20);

    function resolveFrostOutputScript(bytes calldata output)
        external
        view
        returns (bytes20);

    function isFrostFundingTarget(bytes20 label) external view returns (bool);
}
