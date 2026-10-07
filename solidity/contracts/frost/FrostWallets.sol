// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "./FrostTypes.sol";
import "./FrostCurve.sol";

interface IFrostRegistry {
    function walletOwner() external view returns (address);

    function requestNewWallet() external;
}

/// @notice FROST metadata is separate from every legacy wallet slot and counter.
library FrostWallets {
    enum State {
        Unknown,
        Candidate,
        RegisteredPendingReady,
        ReadyUnfunded,
        Live,
        MovingFunds,
        Closing,
        Closed,
        Terminated
    }
    struct Wallet {
        FrostTypes.Descriptor descriptor;
        bytes32 id;
        bytes32 descriptorHash;
        uint64 deadline;
        State state;
        bool quarantined;
        uint32 generation;
        uint32 capabilityVersion;
    }
    // Four slots, taken from the tail of BridgeState's reserved storage gap.
    struct Storage {
        address registry;
        bool requestsEnabled;
        mapping(bytes20 => Wallet) wallets;
        mapping(bytes32 => bytes20) outputKeys;
        mapping(address => mapping(bytes32 => bytes20)) identities;
    }
    event FrostWalletRegistered(
        bytes32 indexed walletId,
        bytes20 indexed label,
        bytes32 descriptorHash,
        uint64 deadline
    );
    event FrostWalletReady(bytes32 indexed walletId, bytes32 descriptorHash);
    event FrostWalletExpired(bytes32 indexed walletId);
    event FrostRegistryConfigured(address indexed registry);
    event FrostRequestsEnabled(bool enabled);

    function configure(Storage storage self, address registry) external {
        require(
            self.registry == address(0) &&
                registry.code.length > 0 &&
                IFrostRegistry(registry).walletOwner() == address(this),
            "FROST registry binding"
        );
        self.registry = registry;
        emit FrostRegistryConfigured(registry);
    }

    function setRequestsEnabled(Storage storage self, bool enabled) external {
        require(self.registry != address(0), "FROST registry missing");
        self.requestsEnabled = enabled;
        emit FrostRequestsEnabled(enabled);
    }

    function request(Storage storage self) external {
        require(self.requestsEnabled, "FROST requests disabled");
        IFrostRegistry(self.registry).requestNewWallet();
    }

    function register(
        Storage storage self,
        bytes calldata encodedDescriptor,
        uint64 deadline,
        bool legacyOccupied
    ) external {
        FrostTypes.Descriptor memory descriptor = abi.decode(
            encodedDescriptor,
            (FrostTypes.Descriptor)
        );
        require(
            keccak256(encodedDescriptor) == keccak256(abi.encode(descriptor)),
            "FROST descriptor encoding"
        );
        require(
            msg.sender == self.registry &&
                descriptor.registry == msg.sender &&
                descriptor.chainId == block.chainid,
            "FROST callback binding"
        );
        require(
            descriptor.scheme == FrostTypes.SCHEME &&
                descriptor.profile == FrostTypes.PROFILE &&
                descriptor.epoch > 0 &&
                descriptor.epoch <= block.number &&
                descriptor.snowfallDescriptor != bytes32(0) &&
                FrostCurve.validX(descriptor.outputKey),
            "FROST descriptor"
        );
        uint256 n = descriptor.members.length;
        require(
            n > 0 &&
                n <= 100 &&
                descriptor.operators.length == n &&
                descriptor.threshold > n / 2 &&
                descriptor.threshold <= n,
            "FROST roster"
        );
        for (uint256 i = 0; i < n; i++)
            require(
                descriptor.members[i] > 0 &&
                    descriptor.operators[i] != address(0),
                "FROST seat"
            );
        bytes32 id = FrostTypes.walletId(descriptor.outputKey);
        bytes20 label = bytes20(id);
        require(
            label != bytes20(0) &&
                !legacyOccupied &&
                self.wallets[label].state == State.Unknown &&
                self.outputKeys[descriptor.outputKey] == bytes20(0),
            "FROST identity occupied"
        );
        require(deadline > block.number, "FROST deadline");
        Wallet storage w = self.wallets[label];
        w.descriptor = descriptor;
        w.id = id;
        w.descriptorHash = FrostTypes.descriptorHash(descriptor);
        w.deadline = deadline;
        w.state = State.RegisteredPendingReady;
        self.outputKeys[descriptor.outputKey] = label;
        self.identities[msg.sender][id] = label;
        emit FrostWalletRegistered(id, label, w.descriptorHash, deadline);
    }

    function descriptorLabel(bytes calldata encodedDescriptor)
        external
        pure
        returns (bytes20)
    {
        FrostTypes.Descriptor memory descriptor = abi.decode(
            encodedDescriptor,
            (FrostTypes.Descriptor)
        );
        return bytes20(FrostTypes.walletId(descriptor.outputKey));
    }

    function descriptorBytes(Storage storage self, bytes20 label)
        external
        view
        returns (bytes memory)
    {
        return abi.encode(self.wallets[label]);
    }

    function ready(
        Storage storage self,
        bytes32 id,
        bytes32 descriptorHash,
        uint32 generation,
        uint32 capabilityVersion
    ) external {
        require(msg.sender == self.registry, "FROST callback sender");
        Wallet storage w = self.wallets[self.identities[msg.sender][id]];
        require(
            w.id == id &&
                w.state == State.RegisteredPendingReady &&
                block.number < w.deadline &&
                !w.quarantined,
            "FROST readiness state"
        );
        require(
            w.descriptorHash == descriptorHash &&
                generation == 1 &&
                capabilityVersion == 1,
            "FROST readiness binding"
        );
        w.state = State.ReadyUnfunded;
        w.generation = generation;
        w.capabilityVersion = capabilityVersion;
        emit FrostWalletReady(id, descriptorHash);
    }

    function expire(Storage storage self, bytes32 id) external {
        require(msg.sender == self.registry, "FROST callback sender");
        Wallet storage w = self.wallets[self.identities[msg.sender][id]];
        require(
            w.id == id &&
                w.state == State.RegisteredPendingReady &&
                block.number >= w.deadline,
            "FROST expiry state"
        );
        w.state = State.Closed;
        emit FrostWalletExpired(id);
    }

    function resolveOutput(Storage storage self, bytes calldata output)
        external
        view
        returns (bytes20)
    {
        bytes32 q;
        if (output.length == 34 && output[0] == 0x51 && output[1] == 0x20)
            q = bytes32(output[2:34]);
        else if (
            output.length == 35 &&
            output[0] == 0x22 &&
            output[1] == 0x51 &&
            output[2] == 0x20
        ) q = bytes32(output[3:35]);
        else revert("FROST output encoding");
        bytes20 label = self.outputKeys[q];
        require(label != bytes20(0), "FROST output unknown");
        return label;
    }
}
