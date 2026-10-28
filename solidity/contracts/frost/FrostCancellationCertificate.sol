// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./FrostTypes.sol";

/// @notice Authenticates one exact custody-preserving cancellation of an intent.
library FrostCancellationCertificate {
    struct Authorization {
        bytes32 reservationId;
        bytes32 snapshot;
        bytes32 transactionHash;
        uint64 fee;
        uint64 validUntilBlock;
    }

    function digest(address bridge, Authorization memory authorization)
        internal
        view
        returns (bytes32)
    {
        return
            keccak256(
                abi.encode(
                    keccak256("tbtc-v2/frost-reservation-cancellation/v1"),
                    block.chainid,
                    bridge,
                    authorization
                )
            );
    }

    function validate(
        address bridge,
        FrostTypes.Descriptor memory descriptor,
        Authorization memory authorization,
        uint16[] calldata seats,
        bytes calldata signatures
    ) internal view returns (bool) {
        uint256 n = descriptor.members.length;
        if (
            bridge == address(0) ||
            descriptor.chainId != block.chainid ||
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
            authorization.reservationId == bytes32(0) ||
            authorization.snapshot == bytes32(0) ||
            authorization.transactionHash == bytes32(0) ||
            authorization.fee == 0 ||
            authorization.fee > 2100000000000000 ||
            authorization.validUntilBlock < block.number
        ) return false;
        bytes32 message = ECDSA.toEthSignedMessageHash(
            digest(bridge, authorization)
        );
        uint16 previous;
        for (uint256 i = 0; i < seats.length; i++) {
            uint16 seat = seats[i];
            if (
                seat <= previous ||
                seat > n ||
                descriptor.members[seat - 1] == 0
            ) return false;
            previous = seat;
            (address signer, ECDSA.RecoverError error) = ECDSA.tryRecover(
                message,
                signatures[i * 65:(i + 1) * 65]
            );
            if (
                descriptor.operators[seat - 1] == address(0) ||
                error != ECDSA.RecoverError.NoError ||
                signer != descriptor.operators[seat - 1]
            ) return false;
        }
        return true;
    }
}
