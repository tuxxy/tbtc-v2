// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "./FrostSecp256k1.sol";
import "./IFrostVerifier.sol";

/// @notice Strict BIP340 and BIP341 output relations for C-07 qualification.
/// @dev Inactive standalone component. Tests do not establish the named proof
/// predicates; the release record must include proof, source and gas evidence.
contract FrostVerifier is IFrostVerifier {
    function isValidKey(bytes32 key) external view override returns (bool) {
        (bool valid, ) = FrostSecp256k1.lift(key);
        return valid;
    }

    function taggedHash(bytes memory tag, bytes memory message)
        private
        pure
        returns (bytes32)
    {
        bytes32 prefix = sha256(tag);
        return sha256(abi.encodePacked(prefix, prefix, message));
    }

    function verify(
        bytes32 key,
        bytes32 message,
        bytes calldata signature
    ) external view override returns (bool) {
        if (signature.length != 64) return false;
        uint256 r;
        uint256 s;
        // Exact-length calldata parsing; neither scalar nor x is reduced.
        // solhint-disable-next-line no-inline-assembly
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
        }
        if (r >= FrostSecp256k1.P || s >= FrostSecp256k1.N) return false;
        (bool ok, FrostSecp256k1.Point memory point) = FrostSecp256k1.lift(key);
        if (!ok) return false;
        uint256 challenge = uint256(
            taggedHash(
                "BIP0340/challenge",
                abi.encodePacked(bytes32(r), key, message)
            )
        ) % FrostSecp256k1.N;
        FrostSecp256k1.Point memory nonce = FrostSecp256k1.add(
            FrostSecp256k1.multiply(FrostSecp256k1.generator(), s),
            FrostSecp256k1.multiply(
                point,
                challenge == 0 ? 0 : FrostSecp256k1.N - challenge
            )
        );
        uint256 x;
        uint256 y;
        (ok, x, y) = FrostSecp256k1.affine(nonce);
        return ok && y & 1 == 0 && x == r;
    }

    function tapTweak(bytes32 internalKey, bytes32 merkleRoot)
        external
        view
        override
        returns (
            bool valid,
            bytes32 outputKey,
            uint8 parity
        )
    {
        (bool ok, FrostSecp256k1.Point memory point) = FrostSecp256k1.lift(
            internalKey
        );
        if (!ok) return (false, bytes32(0), 0);
        uint256 tweak = uint256(
            taggedHash("TapTweak", abi.encodePacked(internalKey, merkleRoot))
        );
        // BIP341 rejects t>=n; reducing t would admit a different output.
        if (tweak >= FrostSecp256k1.N) return (false, bytes32(0), 0);
        point = FrostSecp256k1.add(
            point,
            FrostSecp256k1.multiply(FrostSecp256k1.generator(), tweak)
        );
        uint256 x;
        uint256 y;
        (ok, x, y) = FrostSecp256k1.affine(point);
        if (!ok) return (false, bytes32(0), 0);
        return (true, bytes32(x), uint8(y & 1));
    }
}
