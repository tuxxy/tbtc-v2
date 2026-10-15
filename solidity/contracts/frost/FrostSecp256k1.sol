// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

/// @notice secp256k1 Jacobian arithmetic for the strict C-07 verifier boundary.
/// @dev Z=0 is the infinity sentinel. Public inputs must be validated by lift;
/// internal points originate only from lift, G and the operations below.
library FrostSecp256k1 {
    uint256 internal constant P =
        0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f;
    uint256 internal constant N =
        0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
    uint256 internal constant GX =
        0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798;
    uint256 internal constant GY =
        0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8;

    struct Point {
        uint256 x;
        uint256 y;
        uint256 z;
    }

    function generator() internal pure returns (Point memory) {
        return Point(GX, GY, 1);
    }

    function sub(uint256 a, uint256 b) private pure returns (uint256) {
        // Both arguments are canonical field elements from mulmod/addmod.
        return addmod(a, P - b, P);
    }

    function power(uint256 base, uint256 exponent)
        private
        view
        returns (bool ok, uint256 value)
    {
        uint256[6] memory input = [uint256(32), 32, 32, base, exponent, P];
        uint256[1] memory output;
        // EIP-198 modexp with fixed 32-byte operands and output.
        // solhint-disable-next-line no-inline-assembly
        assembly {
            ok := staticcall(gas(), 5, input, 192, output, 32)
        }
        value = output[0];
    }

    function lift(bytes32 encoded)
        internal
        view
        returns (bool ok, Point memory point)
    {
        uint256 x = uint256(encoded);
        if (x >= P) return (false, Point(0, 0, 0));
        uint256 rhs = addmod(mulmod(mulmod(x, x, P), x, P), 7, P);
        uint256 y;
        (ok, y) = power(rhs, (P + 1) / 4);
        if (!ok || y >= P || mulmod(y, y, P) != rhs)
            return (false, Point(0, 0, 0));
        if (y & 1 != 0) y = P - y;
        return (true, Point(x, y, 1));
    }

    function doublePoint(Point memory point)
        internal
        pure
        returns (Point memory)
    {
        if (point.z == 0 || point.y == 0) return Point(0, 0, 0);
        uint256 a = mulmod(point.x, point.x, P);
        uint256 b = mulmod(point.y, point.y, P);
        uint256 c = mulmod(b, b, P);
        uint256 d = mulmod(
            2,
            sub(
                sub(mulmod(addmod(point.x, b, P), addmod(point.x, b, P), P), a),
                c
            ),
            P
        );
        uint256 e = mulmod(3, a, P);
        uint256 x = sub(mulmod(e, e, P), mulmod(2, d, P));
        uint256 y = sub(mulmod(e, sub(d, x), P), mulmod(8, c, P));
        uint256 z = mulmod(2, mulmod(point.y, point.z, P), P);
        return Point(x, y, z);
    }

    struct Addition {
        uint256 z1;
        uint256 z2;
        uint256 u1;
        uint256 u2;
        uint256 s1;
        uint256 s2;
        uint256 h;
        uint256 i;
        uint256 j;
        uint256 r;
        uint256 v;
    }

    function add(Point memory left, Point memory right)
        internal
        pure
        returns (Point memory)
    {
        if (left.z == 0) return Point(right.x, right.y, right.z);
        if (right.z == 0) return Point(left.x, left.y, left.z);
        Addition memory t;
        t.z1 = mulmod(left.z, left.z, P);
        t.z2 = mulmod(right.z, right.z, P);
        t.u1 = mulmod(left.x, t.z2, P);
        t.u2 = mulmod(right.x, t.z1, P);
        t.s1 = mulmod(left.y, mulmod(right.z, t.z2, P), P);
        t.s2 = mulmod(right.y, mulmod(left.z, t.z1, P), P);
        if (t.u1 == t.u2) {
            if (t.s1 == t.s2) return doublePoint(left);
            return Point(0, 0, 0);
        }
        t.h = sub(t.u2, t.u1);
        t.i = mulmod(mulmod(2, t.h, P), mulmod(2, t.h, P), P);
        t.j = mulmod(t.h, t.i, P);
        t.r = mulmod(2, sub(t.s2, t.s1), P);
        t.v = mulmod(t.u1, t.i, P);
        uint256 x = sub(sub(mulmod(t.r, t.r, P), t.j), mulmod(2, t.v, P));
        uint256 y = sub(
            mulmod(t.r, sub(t.v, x), P),
            mulmod(2, mulmod(t.s1, t.j, P), P)
        );
        uint256 z = mulmod(
            sub(
                sub(
                    mulmod(
                        addmod(left.z, right.z, P),
                        addmod(left.z, right.z, P),
                        P
                    ),
                    t.z1
                ),
                t.z2
            ),
            t.h,
            P
        );
        return Point(x, y, z);
    }

    /// @dev Full uint256 loop: no secret scalar, field reduction or shortening.
    function multiply(Point memory point, uint256 scalar)
        internal
        pure
        returns (Point memory result)
    {
        result = Point(0, 0, 0);
        for (uint256 bit = 256; bit > 0; bit--) {
            result = doublePoint(result);
            if ((scalar >> (bit - 1)) & 1 != 0) result = add(result, point);
        }
    }

    function affine(Point memory point)
        internal
        view
        returns (
            bool ok,
            uint256 x,
            uint256 y
        )
    {
        if (point.z == 0) return (false, 0, 0);
        uint256 inverse;
        (ok, inverse) = power(point.z, P - 2);
        if (!ok || inverse >= P || mulmod(point.z, inverse, P) != 1)
            return (false, 0, 0);
        uint256 square = mulmod(inverse, inverse, P);
        x = mulmod(point.x, square, P);
        y = mulmod(point.y, mulmod(square, inverse, P), P);
    }
}
