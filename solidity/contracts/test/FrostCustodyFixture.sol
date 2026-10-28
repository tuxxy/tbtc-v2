// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;
import "../frost/FrostCustody.sol";

/// @dev Test-only state controls; not a production funding admission entrypoint.
contract FrostCustodyFixture {
    FrostCustody.Storage private custody;

    function credit(
        bytes32 id,
        uint64 generation,
        bytes32 hash,
        uint32 index,
        uint64 value
    ) external {
        FrostCustody.credit(custody, id, generation, hash, index, value);
    }

    function reserve(bytes32 id, bytes32 reservation) external {
        custody.wallets[id].activeReservation = reservation;
    }

    function markSpent(bytes32 key_) external {
        custody.outputs[key_].spent = true;
    }

    function version(bytes32 id, uint64 version_) external {
        custody.wallets[id].stateVersion = version_;
    }

    function intentGeneration(bytes32 id, uint64 generation_) external {
        custody.wallets[id].generation = generation_;
    }

    function wallet(bytes32 id)
        external
        view
        returns (FrostCustody.Wallet memory)
    {
        return custody.wallets[id];
    }

    function output(bytes32 key_)
        external
        view
        returns (FrostCustody.Output memory)
    {
        return custody.outputs[key_];
    }

    function key(bytes32 hash, uint32 index) external pure returns (bytes32) {
        return FrostCustody.outpointKey(hash, index);
    }
}
