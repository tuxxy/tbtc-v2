// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./FrostTypes.sol";
import "./FrostSigningIntent.sol";

/// @notice Operator certificate for one exact FROST redemption reservation.
/// @dev This validates authority only. Request funding, escrow, finality and
///      settlement remain obligations of the Bridge reservation consumer.
library FrostReservationCertificate {
    bytes32 internal constant DOMAIN =
        keccak256("tbtc-v2/frost-redemption-reservation/v2");

    struct Reservation {
        bytes32 walletId;
        bytes32 descriptorHash;
        uint64 generation;
        uint64 stateVersion;
        bytes32 intentCommitment;
        bytes32 requestIdsHash;
        bytes32 conflictTxHash;
        uint32 conflictOutputIndex;
        uint64 minimumFee;
        uint64 maximumFee;
        uint64 maximumSatPerVByte;
        uint64 validUntilBlock;
    }

    function validFeeDomain(Reservation memory reservation)
        internal
        pure
        returns (bool)
    {
        return
            reservation.conflictTxHash != bytes32(0) &&
            reservation.minimumFee > 0 &&
            reservation.maximumFee >= reservation.minimumFee &&
            reservation.maximumFee <= 2100000000000000 &&
            reservation.maximumSatPerVByte > 0 &&
            reservation.maximumSatPerVByte <= 2100000000000000;
    }

    function reservationId(address bridge, Reservation memory reservation)
        internal
        view
        returns (bytes32)
    {
        return
            keccak256(
                abi.encode(
                    keccak256("tbtc-v2/frost-reservation-id/v1"),
                    block.chainid,
                    bridge,
                    reservation.walletId,
                    reservation.descriptorHash,
                    reservation.generation,
                    reservation.stateVersion,
                    reservation.intentCommitment
                )
            );
    }

    function derive(
        Reservation memory reservation,
        FrostSigningIntent.Plan memory plan
    ) internal pure returns (Reservation memory) {
        require(
            plan.requests.length > 0 &&
                plan.requests.length <= FrostSigningIntent.MAX_REQUESTS,
            "FROST intent domain"
        );
        bytes32[] memory ids = new bytes32[](plan.requests.length);
        for (uint256 i = 0; i < ids.length; i++) ids[i] = plan.requests[i].id;
        // Internal memory parameters are references. Allocate a new struct so
        // deriving or validating bindings cannot rewrite the caller's tuple.
        Reservation memory derived = Reservation({
            walletId: reservation.walletId,
            descriptorHash: reservation.descriptorHash,
            generation: reservation.generation,
            stateVersion: reservation.stateVersion,
            intentCommitment: bytes32(0),
            requestIdsHash: keccak256(abi.encode(ids)),
            conflictTxHash: reservation.conflictTxHash,
            conflictOutputIndex: reservation.conflictOutputIndex,
            minimumFee: reservation.minimumFee,
            maximumFee: reservation.maximumFee,
            maximumSatPerVByte: reservation.maximumSatPerVByte,
            validUntilBlock: reservation.validUntilBlock
        });
        derived.intentCommitment = FrostSigningIntent.commitment(
            plan.snapshot,
            plan.genesis,
            derived,
            plan.requests
        );
        return derived;
    }

    function digest(address bridge, Reservation memory reservation)
        internal
        view
        returns (bytes32)
    {
        return
            keccak256(abi.encode(DOMAIN, block.chainid, bridge, reservation));
    }

    /// @dev Seats are one-based, strictly increasing, and counted once. An
    ///      operator holding several selected seats signs for each such seat.
    ///      Malformed Plan/request domains revert during derivation. Early
    ///      certificate/descriptor failures and well-formed binding mismatches
    ///      return false. This function does not enforce readiness/lost-seat sets.
    function validate(
        address bridge,
        FrostTypes.Descriptor memory descriptor,
        Reservation memory reservation,
        FrostSigningIntent.Plan memory plan,
        uint16[] calldata seats,
        bytes calldata signatures
    ) internal view returns (bool) {
        uint256 n = descriptor.members.length;
        if (
            bridge == address(0) ||
            descriptor.chainId != block.chainid ||
            descriptor.registry == address(0) ||
            descriptor.scheme != FrostTypes.SCHEME ||
            descriptor.profile != FrostTypes.PROFILE ||
            n == 0 ||
            n > 100 ||
            descriptor.operators.length != n ||
            descriptor.threshold <= n / 2 ||
            descriptor.threshold > n ||
            seats.length < descriptor.threshold ||
            seats.length > n ||
            signatures.length != seats.length * 65 ||
            reservation.walletId != FrostTypes.walletId(descriptor.outputKey) ||
            reservation.descriptorHash !=
            FrostTypes.descriptorHash(descriptor) ||
            reservation.generation == 0 ||
            reservation.stateVersion == 0 ||
            reservation.intentCommitment == bytes32(0) ||
            reservation.requestIdsHash == bytes32(0) ||
            !validFeeDomain(reservation) ||
            reservation.validUntilBlock < block.number
        ) return false;

        // The admission-facing validator derives both bindings from the same
        // request list. No raw-commitment validation entrypoint is exposed.
        bytes32 suppliedIntent = reservation.intentCommitment;
        bytes32 suppliedIds = reservation.requestIdsHash;
        Reservation memory derived = derive(reservation, plan);
        if (
            derived.intentCommitment != suppliedIntent ||
            derived.requestIdsHash != suppliedIds
        ) return false;

        bytes32 message = ECDSA.toEthSignedMessageHash(
            digest(bridge, reservation)
        );
        return validateSignatures(descriptor, seats, signatures, message);
    }

    function validateSignatures(
        FrostTypes.Descriptor memory descriptor,
        uint16[] calldata seats,
        bytes calldata signatures,
        bytes32 message
    ) private pure returns (bool) {
        uint256 n = descriptor.members.length;
        uint16 previous;
        for (uint256 i = 0; i < seats.length; i++) {
            uint16 seat = seats[i];
            if (seat <= previous || seat > n) return false;
            previous = seat;
            if (descriptor.members[seat - 1] == 0) return false;
            address operator = descriptor.operators[seat - 1];
            (address signer, ECDSA.RecoverError error) = ECDSA.tryRecover(
                message,
                signatures[i * 65:(i + 1) * 65]
            );
            if (
                operator == address(0) ||
                error != ECDSA.RecoverError.NoError ||
                signer != operator
            ) return false;
        }
        return true;
    }
}
