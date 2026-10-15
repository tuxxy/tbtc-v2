// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../frost/FrostReservationCertificate.sol";
import "../frost/FrostSigningIntent.sol";

contract FrostReservationCertificateFixture {
    function derive(
        FrostReservationCertificate.Reservation calldata reservation,
        FrostSigningIntent.Plan calldata plan
    ) external pure returns (FrostReservationCertificate.Reservation memory) {
        return FrostReservationCertificate.derive(reservation, plan);
    }

    function derivePreservingInput(
        FrostReservationCertificate.Reservation calldata reservation,
        FrostSigningIntent.Plan calldata plan
    )
        external
        pure
        returns (
            FrostReservationCertificate.Reservation memory original,
            FrostReservationCertificate.Reservation memory derived
        )
    {
        original = reservation;
        derived = FrostReservationCertificate.derive(original, plan);
    }

    function validatePreservingInput(
        address bridge,
        FrostTypes.Descriptor calldata descriptor,
        FrostReservationCertificate.Reservation calldata reservation,
        FrostSigningIntent.Plan calldata plan,
        uint16[] calldata seats,
        bytes calldata signatures
    )
        external
        view
        returns (
            bool accepted,
            FrostReservationCertificate.Reservation memory original
        )
    {
        original = reservation;
        accepted = FrostReservationCertificate.validate(
            bridge,
            descriptor,
            original,
            plan,
            seats,
            signatures
        );
    }

    function reservationId(
        address bridge,
        FrostReservationCertificate.Reservation calldata reservation
    ) external view returns (bytes32) {
        return FrostReservationCertificate.reservationId(bridge, reservation);
    }

    function intentCommitment(
        bytes32 snapshot,
        bytes32 genesis,
        FrostReservationCertificate.Reservation calldata reservation,
        FrostSigningIntent.Request[] calldata requests
    ) external pure returns (bytes32) {
        return
            FrostSigningIntent.commitment(
                snapshot,
                genesis,
                reservation,
                requests
            );
    }

    function digest(
        address bridge,
        FrostReservationCertificate.Reservation calldata reservation
    ) external view returns (bytes32) {
        return FrostReservationCertificate.digest(bridge, reservation);
    }

    function validate(
        address bridge,
        FrostTypes.Descriptor calldata descriptor,
        FrostReservationCertificate.Reservation calldata reservation,
        FrostSigningIntent.Plan calldata plan,
        uint16[] calldata seats,
        bytes calldata signatures
    ) external view returns (bool) {
        return
            FrostReservationCertificate.validate(
                bridge,
                descriptor,
                reservation,
                plan,
                seats,
                signatures
            );
    }
}
