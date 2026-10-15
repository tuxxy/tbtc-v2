// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "./FrostReservationCertificate.sol";

/// @notice Byte-exact K-04 v2 redemption intent commitment.
/// @dev Admission rejects duplicate request IDs through per-request reservation
///      state, and resolves amounts/scripts from escrow. This encoder alone
///      establishes neither that state nor snapshot/custody validity.
library FrostSigningIntent {
    uint16 internal constant MAX_REQUESTS = 64;
    uint16 internal constant MAX_INPUTS = 32;
    struct Request {
        bytes32 id;
        uint64 value;
        bytes script;
    }
    struct Plan {
        bytes32 snapshot;
        bytes32 genesis;
        Request[] requests;
    }

    function commitment(
        bytes32 snapshot,
        bytes32 genesis,
        FrostReservationCertificate.Reservation memory reservation,
        Request[] memory requests
    ) internal pure returns (bytes32) {
        require(
            snapshot != bytes32(0) &&
                genesis != bytes32(0) &&
                reservation.walletId != bytes32(0) &&
                reservation.descriptorHash != bytes32(0) &&
                reservation.generation != 0 &&
                reservation.stateVersion != 0 &&
                requests.length > 0 &&
                requests.length <= MAX_REQUESTS &&
                FrostReservationCertificate.validFeeDomain(reservation),
            "FROST intent domain"
        );
        bytes memory header = abi.encodePacked(
            "keep-core/frost/signing-intent/v2/",
            uint8(2),
            snapshot,
            reservation.walletId,
            reservation.descriptorHash,
            genesis,
            uint8(1),
            reservation.generation,
            reservation.stateVersion,
            uint16(requests.length)
        );
        bytes memory tail = abi.encodePacked(
            reservation.conflictTxHash,
            reservation.conflictOutputIndex,
            reservation.minimumFee,
            reservation.maximumFee,
            reservation.maximumSatPerVByte
        );
        uint256 length = header.length + tail.length;
        for (uint256 i = 0; i < requests.length; i++) {
            Request memory request = requests[i];
            require(
                request.id != bytes32(0) &&
                    request.value > 0 &&
                    request.value <= 2100000000000000 &&
                    supportedScript(request.script),
                "FROST intent request"
            );
            length += 42 + request.script.length;
        }
        bytes memory encoded = new bytes(length);
        uint256 cursor = copy(encoded, 0, header);
        for (uint256 i = 0; i < requests.length; i++) {
            Request memory request = requests[i];
            cursor = copy(
                encoded,
                cursor,
                abi.encodePacked(
                    request.id,
                    request.value,
                    uint16(request.script.length),
                    request.script
                )
            );
        }
        cursor = copy(encoded, cursor, tail);
        assert(cursor == length);
        return sha256(encoded);
    }

    // Whole-word writes and the byte tail stay inside both allocations even
    // when the destination cursor is not word-aligned.
    function copy(
        bytes memory output,
        uint256 cursor,
        bytes memory input
    ) private pure returns (uint256) {
        require(cursor + input.length <= output.length, "FROST encoder bounds");
        uint256 words = (input.length / 32) * 32;
        // Bounded whole-word copying avoids reallocating the growing preimage.
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

    function supportedScript(bytes memory script) internal pure returns (bool) {
        if (script.length == 25)
            return
                script[0] == 0x76 &&
                script[1] == 0xa9 &&
                script[2] == 0x14 &&
                script[23] == 0x88 &&
                script[24] == 0xac;
        if (script.length == 22) return script[0] == 0x00 && script[1] == 0x14;
        if (script.length == 23)
            return script[0] == 0xa9 && script[1] == 0x14 && script[22] == 0x87;
        if (script.length == 34) return script[0] == 0x00 && script[1] == 0x20;
        return false;
    }
}
