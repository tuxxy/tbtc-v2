// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../frost/FrostSecp256k1.sol";

/// @dev Raw arithmetic probes only. Caller-supplied points/scalars are not a
/// verifier API, valid-key evidence, challenge preimages or proof predicates.
contract FrostSecp256k1Fixture {
    function constants()
        external
        pure
        returns (
            uint256 p,
            uint256 n,
            uint256 gx,
            uint256 gy
        )
    {
        return (
            FrostSecp256k1.P,
            FrostSecp256k1.N,
            FrostSecp256k1.GX,
            FrostSecp256k1.GY
        );
    }

    function add(
        FrostSecp256k1.Point calldata left,
        FrostSecp256k1.Point calldata right
    ) external pure returns (FrostSecp256k1.Point memory) {
        return FrostSecp256k1.add(left, right);
    }

    function doublePoint(FrostSecp256k1.Point calldata point)
        external
        pure
        returns (FrostSecp256k1.Point memory)
    {
        return FrostSecp256k1.doublePoint(point);
    }

    function multiply(FrostSecp256k1.Point calldata point, uint256 scalar)
        external
        pure
        returns (FrostSecp256k1.Point memory)
    {
        return FrostSecp256k1.multiply(point, scalar);
    }

    function lift(bytes32 key)
        external
        view
        returns (bool, FrostSecp256k1.Point memory)
    {
        return FrostSecp256k1.lift(key);
    }

    function affine(FrostSecp256k1.Point calldata point)
        external
        view
        returns (
            bool,
            uint256,
            uint256
        )
    {
        return FrostSecp256k1.affine(point);
    }
}
