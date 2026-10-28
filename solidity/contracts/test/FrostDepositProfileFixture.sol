// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;
import "../frost/FrostDepositProfile.sol";

contract FrostDepositProfileFixture {
    function receipt(FrostDepositProfile.Terms calldata terms)
        external
        pure
        returns (bytes32)
    {
        return FrostDepositProfile.receipt(terms);
    }

    function walletLeaf(
        FrostDepositProfile.Terms calldata terms,
        bytes32 outputKey
    ) external pure returns (bytes memory) {
        return FrostDepositProfile.walletLeaf(terms, outputKey);
    }

    function refundLeaf(FrostDepositProfile.Terms calldata terms)
        external
        pure
        returns (bytes memory)
    {
        return FrostDepositProfile.refundLeaf(terms);
    }

    function root(FrostDepositProfile.Terms calldata terms, bytes32 outputKey)
        external
        pure
        returns (bytes32)
    {
        return FrostDepositProfile.root(terms, outputKey);
    }

    function internalKey() external pure returns (bytes32) {
        return FrostDepositProfile.internalKey();
    }

    function controlBlock(bytes32 sibling, uint8 parity)
        external
        pure
        returns (bytes memory)
    {
        return FrostDepositProfile.controlBlock(sibling, parity);
    }

    function leafHash(bytes calldata script) external pure returns (bytes32) {
        return FrostDepositProfile.leafHash(script);
    }

    function branchHash(bytes32 first, bytes32 second)
        external
        pure
        returns (bytes32)
    {
        return FrostDepositProfile.branchHash(first, second);
    }
}
