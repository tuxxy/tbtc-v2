// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

/// @notice Canonical secp256k1 coordinate checks, without modular reduction of input.
library FrostCurve {
    uint256 internal constant P =
        0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f;

    function validPoint(bytes32 xBytes, bytes32 yBytes)
        internal
        pure
        returns (bool)
    {
        uint256 x = uint256(xBytes);
        uint256 y = uint256(yBytes);
        return
            x < P &&
            y < P &&
            mulmod(y, y, P) == addmod(mulmod(mulmod(x, x, P), x, P), 7, P);
    }

    function validX(bytes32 xBytes) internal view returns (bool) {
        uint256 x = uint256(xBytes);
        if (x >= P) return false;
        uint256 rhs = addmod(mulmod(mulmod(x, x, P), x, P), 7, P);
        uint256[6] memory input = [uint256(32), 32, 32, rhs, (P + 1) / 4, P];
        uint256[1] memory output;
        bool success;
        // The modexp precompile requires a bounded memory input/output call.
        // solhint-disable-next-line no-inline-assembly
        assembly {
            success := staticcall(gas(), 5, input, 192, output, 32)
        }
        return success && mulmod(output[0], output[0], P) == rhs;
    }
}
