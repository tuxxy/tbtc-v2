// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BitcoinTx.sol";

/// @notice C-05 shared funding-proof transport types only; no admission API.
/// @dev Proof is untrusted input. The parent funding handler validates SPV,
/// canonical transaction/output bytes and exact receipt-bound value/script.
/// Wallet/deposit terms and custody state belong to their respective owners.
interface IFrostFundingProof {
    struct FundingProof {
        BitcoinTx.Info transaction;
        BitcoinTx.Proof proof;
        uint32 outputIndex;
    }
}
