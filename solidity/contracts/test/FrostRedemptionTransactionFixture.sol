// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../frost/FrostRedemptionTransaction.sol";

contract FrostRedemptionTransactionFixture {
    function validateRedemption(
        BitcoinTx.Info calldata txInfo,
        bytes32 outputKey,
        BitcoinTx.UTXO[] calldata inputs,
        FrostSigningIntent.Request[] calldata requests
    ) external pure returns (FrostRedemptionTransaction.Result memory) {
        return
            FrostRedemptionTransaction.validateRedemption(
                txInfo,
                outputKey,
                inputs,
                requests
            );
    }

    function validateCancellation(
        BitcoinTx.Info calldata txInfo,
        bytes32 outputKey,
        BitcoinTx.UTXO[] calldata inputs
    ) external pure returns (FrostRedemptionTransaction.Result memory) {
        return
            FrostRedemptionTransaction.validateCancellation(
                txInfo,
                outputKey,
                inputs
            );
    }

    function validateFees(
        FrostRedemptionTransaction.Result calldata result,
        uint256 minimum,
        uint256 maximum,
        uint256 maximumSatPerVByte
    ) external pure {
        FrostRedemptionTransaction.validateFees(
            result,
            minimum,
            maximum,
            maximumSatPerVByte
        );
    }
}
