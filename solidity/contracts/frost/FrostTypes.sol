// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

/// @notice Versioned ABI shared by the FROST registry, Bridge, and node.
/// @dev Copy changes require cross-repository byte-vector tests.
library FrostTypes {
    uint8 internal constant SCHEME = 2;
    uint8 internal constant PROFILE = 1;
    bytes32 internal constant ID_DOMAIN =
        keccak256("tbtc-v2/frost-wallet-id/v1");
    bytes32 internal constant DESCRIPTOR_DOMAIN =
        keccak256("tbtc-v2/frost-descriptor/v1");

    struct Descriptor {
        uint8 scheme;
        uint8 profile;
        uint256 chainId;
        address registry;
        uint64 epoch;
        uint32[] members;
        address[] operators;
        uint16 threshold;
        bytes32 snowfallDescriptor;
        bytes32 outputKey;
    }

    function walletId(bytes32 outputKey) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(ID_DOMAIN, outputKey));
    }

    function descriptorHash(Descriptor memory d)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(DESCRIPTOR_DOMAIN, d));
    }
}

interface IFrostWalletOwner {
    function __snowfallWalletCreated(bytes calldata descriptor, uint64 deadline)
        external;

    function __snowfallWalletReady(
        bytes32 walletId,
        bytes32 descriptorHash,
        uint32 generation,
        uint32 capabilityVersion
    ) external;

    function __snowfallWalletExpired(bytes32 walletId) external;
}
