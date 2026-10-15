// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "./FrostRedemptionLedger.sol";
import "./FrostCancellationHistory.sol";

library FrostRedemptionState {
    struct ReservationProposal {
        FrostReservationCertificate.Reservation certificate;
        BitcoinTx.Info transaction;
        BitcoinTx.UTXO[] inputs;
        FrostSigningIntent.Request[] requests;
        uint16[] seats;
        bytes signatures;
    }
    struct Configuration {
        bytes32 bitcoinGenesis;
        uint64 finalityBlocks;
        uint64 maximumCertificateBlocks;
        bool enabled;
        address watchtower;
        bytes32 legacyTransitionEvidence;
    }
    struct RequestPolicy {
        address watchtower;
        bytes32 policyId;
        uint64 notBefore;
    }
    struct QuarantineRecord {
        bytes32 reservationId;
        bytes32 reasonHash;
        bytes32 evidenceHash;
        address authority;
        uint64 recordedBlock;
        uint64 previousStateVersion;
        uint64 stateVersion;
    }
    struct Storage {
        FrostRedemptionLedger.Storage ledger;
        Configuration configuration;
        mapping(bytes32 => RequestPolicy) requestPolicies;
        mapping(bytes32 => mapping(uint64 => QuarantineRecord)) quarantines;
        FrostCancellationHistory.Storage cancellationHistory;
    }
}
