// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "./IFrostBridge.sol";
import "./FrostWallets.sol";

interface IFrostGovernance {
    function governance() external view returns (address);
}

/// @notice Fixed-selector extension linked into the Bridge bytecode. There is
/// no user-supplied delegate target. All state stays in BridgeState's new slots.
library FrostBridge {
    function dispatch(BridgeState.Storage storage self, bytes calldata input)
        external
        returns (bytes memory)
    {
        require(input.length >= 4, "FROST selector");
        bytes4 selector = bytes4(input[:4]);
        bytes calldata args = input[4:];
        if (selector == IFrostBridge.configureFrostRegistry.selector) {
            require(
                msg.sender == IFrostGovernance(address(this)).governance(),
                "Caller is not governance"
            );
            FrostWallets.configure(self.frost, abi.decode(args, (address)));
        } else if (selector == IFrostBridge.setFrostRequestsEnabled.selector) {
            require(
                msg.sender == IFrostGovernance(address(this)).governance(),
                "Caller is not governance"
            );
            FrostWallets.setRequestsEnabled(
                self.frost,
                abi.decode(args, (bool))
            );
        } else if (selector == IFrostBridge.requestNewFrostWallet.selector) {
            FrostWallets.request(self.frost);
        } else if (selector == IFrostBridge.__snowfallWalletCreated.selector) {
            (bytes memory descriptor, uint64 deadline) = abi.decode(
                args,
                (bytes, uint64)
            );
            bytes20 label = FrostWallets.descriptorLabel(descriptor);
            FrostWallets.register(
                self.frost,
                descriptor,
                deadline,
                self.registeredWallets[label].state !=
                    Wallets.WalletState.Unknown
            );
        } else if (selector == IFrostBridge.__snowfallWalletReady.selector) {
            (
                bytes32 id,
                bytes32 descriptorHash,
                uint32 generation,
                uint32 capabilityVersion
            ) = abi.decode(args, (bytes32, bytes32, uint32, uint32));
            FrostWallets.ready(
                self.frost,
                id,
                descriptorHash,
                generation,
                capabilityVersion
            );
        } else if (selector == IFrostBridge.__snowfallWalletExpired.selector) {
            FrostWallets.expire(self.frost, abi.decode(args, (bytes32)));
        } else if (selector == IFrostBridge.frostRegistry.selector) {
            return abi.encode(self.frost.registry);
        } else if (selector == IFrostBridge.walletScheme.selector) {
            bytes20 label = abi.decode(args, (bytes20));
            return
                abi.encode(
                    self.registeredWallets[label].state !=
                        Wallets.WalletState.Unknown
                        ? uint8(1)
                        : self.frost.wallets[label].descriptor.scheme
                );
        } else if (selector == IFrostBridge.walletDescriptor.selector) {
            return
                abi.encode(
                    FrostWallets.descriptorBytes(
                        self.frost,
                        abi.decode(args, (bytes20))
                    )
                );
        } else if (selector == IFrostBridge.resolveWallet.selector) {
            (address registry, bytes32 id) = abi.decode(
                args,
                (address, bytes32)
            );
            return abi.encode(self.frost.identities[registry][id]);
        } else if (selector == IFrostBridge.resolveWalletOutput.selector) {
            return
                abi.encode(self.frost.outputKeys[abi.decode(args, (bytes32))]);
        } else if (selector == IFrostBridge.resolveFrostOutputScript.selector) {
            return
                abi.encode(
                    FrostWallets.resolveOutput(
                        self.frost,
                        abi.decode(args, (bytes))
                    )
                );
        } else if (selector == IFrostBridge.isFrostFundingTarget.selector) {
            FrostWallets.Wallet storage w = self.frost.wallets[
                abi.decode(args, (bytes20))
            ];
            return
                abi.encode(
                    w.state == FrostWallets.State.Live && !w.quarantined
                );
        } else {
            revert("FROST unknown selector");
        }
        return bytes("");
    }
}
