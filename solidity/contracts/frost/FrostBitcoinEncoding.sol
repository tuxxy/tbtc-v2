// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

/// @notice Bitcoin transaction vectors must use minimal CompactSize and contain
/// exactly the declared inputs/outputs, including scripts and sequence fields.
library FrostBitcoinEncoding {
    function validateVector(bytes memory data, bool inputs) internal pure {
        (uint256 count, uint256 cursor) = compactSize(data, 0);
        require(count > 0, "FROST empty vector");
        // Every input contains at least 41 bytes and every output at least nine.
        require(
            count <= (data.length - cursor) / (inputs ? 41 : 9),
            "FROST vector count"
        );
        for (uint256 i = 0; i < count; i++) {
            uint256 prefix = inputs ? 36 : 8;
            require(cursor + prefix < data.length, "FROST vector prefix");
            cursor += prefix;
            (uint256 scriptSize, uint256 afterSize) = compactSize(data, cursor);
            cursor = afterSize + scriptSize + (inputs ? 4 : 0);
            require(cursor <= data.length, "FROST vector script");
        }
        require(cursor == data.length, "FROST vector trailing bytes");
    }

    function compactSize(bytes memory data, uint256 offset)
        private
        pure
        returns (uint256 value, uint256 next)
    {
        require(offset < data.length, "FROST compact size missing");
        uint8 marker = uint8(data[offset]);
        if (marker < 253) return (marker, offset + 1);
        uint256 width = marker == 253 ? 2 : (marker == 254 ? 4 : 8);
        next = offset + 1 + width;
        require(next <= data.length, "FROST compact size truncated");
        for (uint256 i = 0; i < width; i++)
            value |= uint256(uint8(data[offset + 1 + i])) << (8 * i);
        require(
            value >= (width == 2 ? 253 : (width == 4 ? 65536 : 4294967296)),
            "FROST compact size noncanonical"
        );
    }
}
