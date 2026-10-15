// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BitcoinTx.sol";
import "./FrostSigningIntent.sol";

/// @notice Canonical unsigned exact-Q key-path transactions for C-04.
/// @dev UTXO has no script field: the caller must load recognized outpoints and
/// values from custody whose script is exactly OP_1 PUSH32 outputKey. Requests
/// must come from funded state; their distinctness is an atomic admission duty.
/// This library proves byte relations, not custody, funding, inclusion or signatures.
library FrostRedemptionTransaction {
    uint256 internal constant MAX_SATOSHI = 2100000000000000;
    uint256 private constant FIELD =
        0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f;

    struct Result {
        bytes32 snapshot;
        bytes32 txHash;
        uint64 fee;
        uint64 changeValue;
        uint32 changeIndex;
        uint256 virtualSize;
    }

    function validateRedemption(
        BitcoinTx.Info memory txInfo,
        bytes32 outputKey,
        BitcoinTx.UTXO[] memory inputs,
        FrostSigningIntent.Request[] memory requests
    ) internal pure returns (Result memory) {
        require(
            requests.length > 0 &&
                requests.length <= FrostSigningIntent.MAX_REQUESTS,
            "FROST payee count"
        );
        return validate(txInfo, outputKey, inputs, requests);
    }

    /// @dev Caller must include the stored reserved conflict input among the
    /// recognized inputs. There is no opaque snapshot or caller-declared fee.
    function validateCancellation(
        BitcoinTx.Info memory txInfo,
        bytes32 outputKey,
        BitcoinTx.UTXO[] memory inputs
    ) internal pure returns (Result memory) {
        return
            validate(
                txInfo,
                outputKey,
                inputs,
                new FrostSigningIntent.Request[](0)
            );
    }

    /// @notice Optional full-width policy check on the derived result.
    /// @dev Division rejects fractional fee-rate excess without multiplication.
    function validateFees(
        Result memory result,
        uint256 minimum,
        uint256 maximum,
        uint256 maximumSatPerVByte
    ) internal pure {
        require(
            minimum > 0 &&
                maximum >= minimum &&
                maximum <= MAX_SATOSHI &&
                maximumSatPerVByte > 0 &&
                maximumSatPerVByte <= MAX_SATOSHI &&
                result.virtualSize > 0 &&
                result.fee > 0 &&
                result.fee >= minimum &&
                result.fee <= maximum,
            "FROST transaction fee"
        );
        uint256 rate = uint256(result.fee) / result.virtualSize;
        require(
            rate < maximumSatPerVByte ||
                (rate == maximumSatPerVByte &&
                    uint256(result.fee) % result.virtualSize == 0),
            "FROST transaction fee rate"
        );
    }

    function validate(
        BitcoinTx.Info memory txInfo,
        bytes32 outputKey,
        BitcoinTx.UTXO[] memory inputs,
        FrostSigningIntent.Request[] memory requests
    ) private pure returns (Result memory result) {
        require(txInfo.version == hex"02000000", "FROST transaction version");
        require(validKey(outputKey), "FROST output key");
        bytes memory script = abi.encodePacked(hex"5120", outputKey);
        uint256 inputValue = validateInputs(txInfo.inputVector, inputs);
        uint256 outputValue;
        (outputValue, result.changeValue) = validateOutputs(
            txInfo.outputVector,
            script,
            requests
        );
        require(outputValue < inputValue, "FROST positive fee");
        result.fee = uint64(inputValue - outputValue);
        result.changeIndex = uint32(requests.length);
        bytes memory raw = abi.encodePacked(
            txInfo.version,
            txInfo.inputVector,
            txInfo.outputVector,
            txInfo.locktime
        );
        // Hash bytes are Bitcoin internal/wire order; reverse only for RPC display.
        result.txHash = sha256(abi.encodePacked(sha256(raw)));
        // One 64-byte SIGHASH_DEFAULT signature: stack count + length + 64 bytes.
        // Marker/flag add two witness bytes; no annex or explicit sighash byte.
        result.virtualSize = (4 * raw.length + 2 + 66 * inputs.length + 3) / 4;
        result.snapshot = snapshot(raw, outputKey, script, inputs);
    }

    function validateInputs(bytes memory vector, BitcoinTx.UTXO[] memory inputs)
        private
        pure
        returns (uint256 total)
    {
        (uint256 count, uint256 cursor) = compactSize(vector, 0);
        require(
            count > 0 &&
                count <= FrostSigningIntent.MAX_INPUTS &&
                count == inputs.length,
            "FROST input count"
        );
        // Open addressing stores exact outpoint indices, not hash identities.
        // Capacity is twice the normative maximum; collisions cannot merge inputs.
        uint256[64] memory seen;
        for (uint256 i = 0; i < count; i++) {
            BitcoinTx.UTXO memory input = inputs[i];
            require(
                input.txHash != bytes32(0) &&
                    input.txOutputValue > 0 &&
                    input.txOutputValue <= MAX_SATOSHI,
                "FROST recognized input"
            );
            require(
                hashAt(vector, cursor) == input.txHash &&
                    littleEndian(vector, cursor + 32, 4) == input.txOutputIndex,
                "FROST input outpoint"
            );
            cursor += 36;
            (uint256 scriptLength, uint256 next) = compactSize(vector, cursor);
            require(scriptLength == 0, "FROST unsigned input");
            cursor = next;
            // Sequence is unrestricted but must be fully present and is hashed.
            littleEndian(vector, cursor, 4);
            cursor += 4;
            uint256 bucket = uint256(
                keccak256(abi.encodePacked(input.txHash, input.txOutputIndex))
            ) & 63;
            while (seen[bucket] != 0) {
                BitcoinTx.UTXO memory prior = inputs[seen[bucket] - 1];
                require(
                    prior.txHash != input.txHash ||
                        prior.txOutputIndex != input.txOutputIndex,
                    "FROST duplicate input"
                );
                bucket = (bucket + 1) & 63;
            }
            seen[bucket] = i + 1;
            total += input.txOutputValue;
            require(total <= MAX_SATOSHI, "FROST input value sum");
        }
        require(cursor == vector.length, "FROST input trailing data");
    }

    function validateOutputs(
        bytes memory vector,
        bytes memory changeScript,
        FrostSigningIntent.Request[] memory requests
    ) private pure returns (uint256 total, uint64 changeValue) {
        (uint256 count, uint256 cursor) = compactSize(vector, 0);
        require(
            count > 0 && count <= 256 && count == requests.length + 1,
            "FROST output count"
        );
        for (uint256 i = 0; i < count; i++) {
            uint256 value = littleEndian(vector, cursor, 8);
            require(value > 0 && value <= MAX_SATOSHI, "FROST output value");
            cursor += 8;
            (uint256 length, uint256 next) = compactSize(vector, cursor);
            cursor = next;
            bytes memory expected = changeScript;
            if (i < requests.length) {
                FrostSigningIntent.Request memory request = requests[i];
                require(
                    request.id != bytes32(0) &&
                        request.value == value &&
                        FrostSigningIntent.supportedScript(request.script),
                    "FROST payee"
                );
                expected = request.script;
            } else {
                changeValue = uint64(value);
            }
            require(length == expected.length, "FROST output script");
            bounds(vector, cursor, length);
            require(
                matchesScript(vector, cursor, expected),
                "FROST output script"
            );
            cursor += length;
            total += value;
            require(total <= MAX_SATOSHI, "FROST output value sum");
        }
        require(cursor == vector.length, "FROST output trailing data");
    }

    /// @dev Caller checks the vector bounds and equal lengths first. Compare
    /// full words and only the significant bytes of the final partial word;
    /// following output bytes and memory padding are not part of the script.
    function matchesScript(
        bytes memory vector,
        uint256 cursor,
        bytes memory expected
    ) private pure returns (bool equal) {
        equal = true;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            let length := mload(expected)
            let source := add(add(vector, 32), cursor)
            let target := add(expected, 32)
            let words := and(length, not(31))
            for {
                let offset := 0
            } lt(offset, words) {
                offset := add(offset, 32)
            } {
                if iszero(
                    eq(mload(add(source, offset)), mload(add(target, offset)))
                ) {
                    equal := 0
                }
            }
            let tail := and(length, 31)
            if tail {
                let shift := mul(sub(32, tail), 8)
                if iszero(
                    eq(
                        shr(shift, mload(add(source, words))),
                        shr(shift, mload(add(target, words)))
                    )
                ) {
                    equal := 0
                }
            }
        }
    }

    function snapshot(
        bytes memory raw,
        bytes32 outputKey,
        bytes memory script,
        BitcoinTx.UTXO[] memory inputs
    ) private pure returns (bytes32) {
        bytes memory prefix = abi.encodePacked(
            "keep-core/taproot-snapshot/v1",
            outputKey
        );
        // Each previous output is value uint64LE + CompactSize(34) + exact-Q script.
        bytes memory encoded = new bytes(
            prefix.length + raw.length + 43 * inputs.length
        );
        uint256 cursor = copy(encoded, 0, prefix);
        cursor = copy(encoded, cursor, raw);
        for (uint256 i = 0; i < inputs.length; i++) {
            uint64 value = inputs[i].txOutputValue;
            for (uint256 j = 0; j < 8; j++)
                encoded[cursor + j] = bytes1(uint8(value >> (8 * j)));
            cursor += 8;
            encoded[cursor++] = 0x22;
            cursor = copy(encoded, cursor, script);
        }
        assert(cursor == encoded.length);
        return sha256(encoded);
    }

    function compactSize(bytes memory data, uint256 cursor)
        private
        pure
        returns (uint256 value, uint256 next)
    {
        bounds(data, cursor, 1);
        uint256 prefix = uint8(data[cursor++]);
        if (prefix < 253) return (prefix, cursor);
        uint256 width = prefix == 253 ? 2 : prefix == 254 ? 4 : 8;
        value = littleEndian(data, cursor, width);
        require(
            value >= (width == 2 ? 253 : width == 4 ? 65536 : 4294967296),
            "FROST noncanonical CompactSize"
        );
        return (value, cursor + width);
    }

    function bounds(
        bytes memory data,
        uint256 cursor,
        uint256 length
    ) private pure {
        require(
            cursor <= data.length && length <= data.length - cursor,
            "FROST truncated transaction"
        );
    }

    function littleEndian(
        bytes memory data,
        uint256 cursor,
        uint256 width
    ) private pure returns (uint256 value) {
        bounds(data, cursor, width);
        for (uint256 i = 0; i < width; i++)
            value |= uint256(uint8(data[cursor + i])) << (8 * i);
    }

    function hashAt(bytes memory data, uint256 cursor)
        private
        pure
        returns (bytes32 value)
    {
        bounds(data, cursor, 32);
        // solhint-disable-next-line no-inline-assembly
        assembly {
            value := mload(add(add(data, 32), cursor))
        }
    }

    function copy(
        bytes memory output,
        uint256 cursor,
        bytes memory input
    ) private pure returns (uint256) {
        bounds(output, cursor, input.length);
        uint256 words = (input.length / 32) * 32;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            let destination := add(add(output, 32), cursor)
            let source := add(input, 32)
            for {
                let i := 0
            } lt(i, words) {
                i := add(i, 32)
            } {
                mstore(add(destination, i), mload(add(source, i)))
            }
        }
        for (uint256 i = words; i < input.length; i++)
            output[cursor + i] = input[i];
        return cursor + input.length;
    }

    // Public-field square-root check, equivalent to the registered key's lift.
    // Pure modular exponentiation avoids a view-only precompile in the pure API.
    function validKey(bytes32 outputKey) private pure returns (bool) {
        uint256 x = uint256(outputKey);
        if (x >= FIELD) return false;
        uint256 rhs = addmod(mulmod(mulmod(x, x, FIELD), x, FIELD), 7, FIELD);
        uint256 exponent = (FIELD + 1) / 4;
        uint256 base = rhs;
        uint256 y = 1;
        while (exponent != 0) {
            if (exponent & 1 != 0) y = mulmod(y, base, FIELD);
            base = mulmod(base, base, FIELD);
            exponent >>= 1;
        }
        return mulmod(y, y, FIELD) == rhs;
    }
}
