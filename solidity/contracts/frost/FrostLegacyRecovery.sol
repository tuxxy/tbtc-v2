// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "../bridge/BitcoinTx.sol";
import "../bridge/Wallets.sol";
import "./FrostExposureState.sol";

/// @notice Legacy recovery is kept separate to preserve EIP-170 margins.
library FrostLegacyRecovery {
    event MovingFundsTimeoutReset(bytes20 indexed walletPubKeyHash);

    function drainAvailable(BridgeState.Storage storage self) internal view returns (bool) {
        return self.frostMovement.drainEnabled &&
            self.frostMovement.eligibleTargets > 0 &&
            !FrostExposureState.controllerOf(self.frostExposure).contained();
    }

    // The original selector has no main-UTXO preimage. It may establish that
    // no budget remains, but cannot infer a balance from an opaque UTXO hash.
    function reset(BridgeState.Storage storage self, bytes20 source) external {
        bool available = drainAvailable(self);
        if (available) available = FrostExposureState.controllerOf(self.frostExposure).remainingCustody() > 0;
        resetIfUnavailable(self, source, available);
    }

    // The additive selector checks the current main preimage to decide partial
    // budget insufficiency without trusting a caller-supplied balance.
    function resetWithMain(BridgeState.Storage storage self, bytes20 source, BitcoinTx.UTXO memory main) external {
        require(self.registeredWallets[source].mainUtxoHash != bytes32(0) &&
            self.registeredWallets[source].mainUtxoHash == keccak256(abi.encodePacked(main.txHash, main.txOutputIndex, main.txOutputValue)), "Invalid wallet main UTXO data");
        bool available = drainAvailable(self);
        if (available) available = main.txOutputValue >= self.movingFundsDustThreshold &&
            FrostExposureState.controllerOf(self.frostExposure).remainingCustody() >= main.txOutputValue;
        resetIfUnavailable(self, source, available);
    }

    function resetIfUnavailable(BridgeState.Storage storage self, bytes20 source, bool frostAvailable) internal {
        Wallets.Wallet storage wallet = self.registeredWallets[source];
        require(wallet.state == Wallets.WalletState.MovingFunds, "Wallet must be in MovingFunds state");
        require(wallet.movingFundsTargetWalletsCommitmentHash == bytes32(0), "Target wallets commitment already submitted");
        require(self.frostExposure.creationMode == FrostExposureState.FROST_ONLY || self.liveWalletsCount == 0, "Live wallets count must be zero");
        require(!frostAvailable, "FROST drain route available");
        require(block.timestamp > wallet.movingFundsRequestedAt + self.movingFundsTimeoutResetDelay, "Moving funds timeout cannot be reset yet");
        wallet.movingFundsRequestedAt = uint32(block.timestamp);
        emit MovingFundsTimeoutReset(source);
    }
}
