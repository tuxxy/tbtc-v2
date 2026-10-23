// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "./IFrostExposureController.sol";

/// @notice C-10 cumulative custody-admission and issuance budgets for FROST.
///
/// A separate contract with its own storage and authority: Bridge code can
/// change the counters only through `reserve`, `complete` and `release`, so a
/// fault in FROST deposit validation cannot raise them or bypass a ceiling.
/// The bound does not survive compromise of the Bridge implementation, the
/// Bank owner or this contract's governance (KC-SF-V3 SC-09).
///
/// Every counter is monotone and never reset. Allowance is
/// `custodyCeiling - custodyReserved` and `issuanceCeiling -
/// issuanceReserved`. Losses, rotation, withdrawals, redemptions, refunds and
/// releases never add allowance; only a new budget period raises a ceiling.
/// A release is recorded (`custodyReleased`) but does not restore allowance:
/// its evidence is an SPV proof from the relay the fault model assumes
/// faulty, so reusing released custody needs a governance top-up (C-10
/// reading 8, Astra re-check of #14).
///
/// Drains are reserved and completed by ID. Deposits are reserved and
/// completed in aggregate: `depositsOutstanding` is the reserved deposit
/// value not yet swept, and a sweep consumes at most that much of it. A
/// faulty Bridge that misreports which deposits were reserved can only spend
/// allowance already counted against the ceilings, so the cumulative bound
/// holds; a per-ID record would cost a cold write per deposit, which the
/// 128-input joint maximum through a vault cannot carry under the
/// transaction gas cap (C-10 review of #14).
contract FrostExposureController is IFrostExposureController {
    uint8 internal constant RESERVED = 1;
    uint8 internal constant COMPLETED = 2;
    uint8 internal constant RELEASED = 3;

    struct Reservation {
        uint64 custody;
        uint64 issuance;
        uint8 state;
    }

    address public immutable override bridge;
    address public governance;
    address public pendingGovernance;
    address public guardian;
    bool public override contained;
    uint32 public period;

    uint64 public custodyCeiling;
    uint64 public issuanceCeiling;
    uint64 public custodyReserved;
    uint64 public custodyReleased;
    uint64 public custodyAdmitted;
    uint64 public issuanceReserved;
    uint64 public issued;
    uint64 public depositsOutstanding;

    mapping(bytes32 => Reservation) public reservations;

    event BudgetPeriodOpened(
        uint32 indexed period,
        uint64 custodyCeiling,
        uint64 issuanceCeiling,
        bytes32 record
    );
    event GovernanceTransferStarted(address pendingGovernance);
    event GovernanceTransferred(address governance);
    event GuardianChanged(address guardian);
    event Contained(address indexed by, bytes32 reason);
    event Lifted(bytes32 record);
    event ExposureReserved(bytes32 indexed id, uint64 custody, uint64 issuance);
    event ExposureCompleted(
        bytes32 indexed id,
        uint64 custody,
        uint64 issuance
    );
    event DepositExposureReserved(uint64 amount);
    event ExposureBatchCompleted(
        uint256 count,
        uint256 reserved,
        uint256 custody,
        uint256 issuance
    );
    event ExposureReleased(bytes32 indexed id, uint64 custody);

    modifier onlyGovernance() {
        require(msg.sender == governance, "Caller is not governance");
        _;
    }

    modifier onlyBridge() {
        require(msg.sender == bridge, "Caller is not the Bridge");
        _;
    }

    constructor(address _bridge, address _governance) {
        require(
            _bridge != address(0) && _governance != address(0),
            "Exposure controller roles"
        );
        bridge = _bridge;
        governance = _governance;
    }

    /// @notice Two steps: the controller can never be replaced, so a wrong
    /// address must not take the only top-up and lift authority.
    function transferGovernance(address next) external onlyGovernance {
        require(next != address(0), "Exposure controller roles");
        pendingGovernance = next;
        emit GovernanceTransferStarted(next);
    }

    function acceptGovernance() external {
        require(msg.sender == pendingGovernance, "Caller is not pending");
        governance = msg.sender;
        delete pendingGovernance;
        emit GovernanceTransferred(msg.sender);
    }

    function setGuardian(address next) external onlyGovernance {
        guardian = next;
        emit GuardianChanged(next);
    }

    /// @notice Open a new budget period: the reviewed top-up. Counters carry
    /// over; a ceiling may not fall below what is already reserved.
    function openBudgetPeriod(
        uint64 nextCustodyCeiling,
        uint64 nextIssuanceCeiling,
        bytes32 record
    ) external onlyGovernance {
        require(record != bytes32(0), "Budget period record");
        require(
            nextCustodyCeiling >= custodyReserved &&
                nextIssuanceCeiling >= issuanceReserved,
            "Budget below reserved"
        );
        period++;
        custodyCeiling = nextCustodyCeiling;
        issuanceCeiling = nextIssuanceCeiling;
        emit BudgetPeriodOpened(
            period,
            nextCustodyCeiling,
            nextIssuanceCeiling,
            record
        );
    }

    /// @notice Stop new exposure. The guardian may contain but never lift.
    function contain(bytes32 reason) external {
        require(
            msg.sender == guardian || msg.sender == governance,
            "Caller cannot contain"
        );
        contained = true;
        emit Contained(msg.sender, reason);
    }

    function lift(bytes32 record) external onlyGovernance {
        require(record != bytes32(0), "Lift record");
        contained = false;
        emit Lifted(record);
    }

    function reserve(
        bytes32 id,
        uint64 custody,
        uint64 issuance
    ) external override onlyBridge {
        require(!contained, "FROST exposure contained");
        Reservation storage r = reservations[id];
        require(id != bytes32(0) && r.state == 0, "Exposure reserved");
        add(custody, issuance);
        r.custody = custody;
        r.issuance = issuance;
        r.state = RESERVED;
        emit ExposureReserved(id, custody, issuance);
    }

    /// @notice Reserve one deposit: custody and issuance equal to its value.
    function reserveDeposit(uint64 amount) external override onlyBridge {
        require(!contained, "FROST exposure contained");
        add(amount, amount);
        depositsOutstanding = toUint64(uint256(depositsOutstanding) + amount);
        emit DepositExposureReserved(amount);
    }

    /// @notice Complete a deposit sweep: `custody` admitted and `issuance`
    /// credited, of which the Bridge reports `reserved` as reserved value.
    /// At most the outstanding reserved value covers it; the rest is charged
    /// now and must fit the ceilings, and never under containment.
    function completeDeposits(
        uint256 count,
        uint64 reserved,
        uint64 custody,
        uint64 issuance
    ) external override onlyBridge {
        uint64 covered = reserved < depositsOutstanding
            ? reserved
            : depositsOutstanding;
        depositsOutstanding -= covered;
        account(
            custody > covered ? custody - covered : 0,
            issuance > covered ? issuance - covered : 0,
            custody,
            issuance
        );
        emit ExposureBatchCompleted(count, covered, custody, issuance);
    }

    function completeOne(
        bytes32 id,
        uint64 custody,
        uint64 issuance
    ) external override onlyBridge {
        (uint64 c, uint64 n) = settle(id, custody, issuance);
        account(c, n, custody, issuance);
        emit ExposureCompleted(id, custody, issuance);
    }

    /// @notice Record that a custody-only drain reservation will never
    /// complete. The custody stays counted against the ceiling: the proof
    /// that the BTC went elsewhere comes from the relay, which may be faulty.
    function release(bytes32 id) external override onlyBridge {
        Reservation storage r = reservations[id];
        require(r.state == RESERVED, "Exposure not reserved");
        require(r.issuance == 0, "Issuance never releases");
        r.state = RELEASED;
        custodyReleased += r.custody;
        emit ExposureReleased(id, r.custody);
    }

    function remainingCustody() external view returns (uint64) {
        return custodyCeiling - custodyReserved;
    }

    function remainingIssuance() external view returns (uint64) {
        return issuanceCeiling - issuanceReserved;
    }

    /// @dev Completes one drain reservation and returns the amounts that
    /// exceed it, which must still fit the ceilings. An ID without a
    /// reservation is charged in full and leaves no record: the ceilings, not
    /// the ID, bound it, so a repeated or fabricated ID is only charged again.
    function settle(
        bytes32 id,
        uint64 custody,
        uint64 issuance
    ) private returns (uint64 extraCustody, uint64 extraIssuance) {
        require(id != bytes32(0), "Exposure settled");
        Reservation storage r = reservations[id];
        if (r.state == 0) return (custody, issuance);
        require(r.state == RESERVED, "Exposure settled");
        if (custody > r.custody) {
            extraCustody = custody - r.custody;
            r.custody = custody;
        }
        if (issuance > r.issuance) {
            extraIssuance = issuance - r.issuance;
            r.issuance = issuance;
        }
        r.state = COMPLETED;
    }

    function account(
        uint256 extraCustody,
        uint256 extraIssuance,
        uint256 admitted,
        uint256 credited
    ) private {
        if (extraCustody != 0 || extraIssuance != 0) {
            require(!contained, "FROST exposure contained");
            add(extraCustody, extraIssuance);
        }
        custodyAdmitted = toUint64(custodyAdmitted + admitted);
        issued = toUint64(issued + credited);
    }

    function add(uint256 custody, uint256 issuance) private {
        uint256 nextCustody = custodyReserved + custody;
        uint256 nextIssuance = issuanceReserved + issuance;
        require(nextCustody <= custodyCeiling, "FROST custody budget");
        require(nextIssuance <= issuanceCeiling, "FROST issuance budget");
        custodyReserved = toUint64(nextCustody);
        issuanceReserved = uint64(nextIssuance);
    }

    function toUint64(uint256 value) private pure returns (uint64) {
        require(value <= type(uint64).max, "Exposure counter overflow");
        return uint64(value);
    }
}
