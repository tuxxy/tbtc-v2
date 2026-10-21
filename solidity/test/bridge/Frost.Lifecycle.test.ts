/* eslint-disable no-await-in-loop, no-restricted-syntax, no-bitwise */
// C-09 FROST lifecycle routing and closure through the public Bridge. Wallets
// enter MovingFunds through the public C-09 entrypoints here (the C-06 tests
// still use the controlled marker). Inclusion proofs are synthetic regtest
// blocks.
import { ethers, network } from "hardhat"
import { expect } from "chai"
import * as secp from "@noble/secp256k1"
import {
  ZERO,
  State,
  movementWorld,
  transaction,
  inclusion,
  p2tr,
  raw,
  outpoint,
  ascending,
  split,
  World,
  Wallet,
  Tx,
  TYPE,
} from "../helpers/frost-movement-world"

const BOND = ethers.utils.parseEther("5")
const Open = {
  custody: 1,
  pendingIncoming: 2,
  committedIncoming: 4,
  unprovenCommitment: 8,
  escrow: 32,
  reservation: 64,
  challenge: 128,
}
const reason = (text: string) => ethers.utils.id(text)

describe("C-09 FROST lifecycle routing and closure", () => {
  let w: World
  let maxAge: number
  let closingPeriod: number
  let snapshot: string

  const advance = async (seconds: number) => {
    await network.provider.send("evm_increaseTime", [seconds])
    await network.provider.send("evm_mine")
  }
  const open = async (x: Wallet) =>
    (await w.frost.frostClosureObligations(x.id)).toNumber()
  const eligible = async () =>
    (await w.frost.frostMovementCounters(ZERO)).eligibleTargets.toNumber()
  const sign = async (x: Wallet, digest: string) =>
    `0x${Buffer.from(
      await secp.schnorr.sign(
        raw(digest),
        ethers.utils
          .hexZeroPad(ethers.utils.hexlify(1000 + w.wallets.indexOf(x)), 32)
          .slice(2),
        new Uint8Array(32)
      )
    ).toString("hex")}`
  const challenge = async (x: Wallet, digest: string) =>
    w.frost.submitFrostFraudChallenge(x.id, digest, await sign(x, digest), {
      value: BOND,
    })
  const commitAndProve = async (source: Wallet, targets: Wallet[]) => {
    await w.frost.connect(w.operator).submitFrostMovingFundsCommitment(
      source.id,
      0,
      targets.map((t) => t.label)
    )
    const values = split(source.value - 3000, targets.length)
    const tx = transaction(
      [[(source.main as Tx).hash, 0]],
      targets.map((t, i) => ({ value: values[i], script: p2tr(t.q) }))
    )
    await w.frost.submitFrostMovingFundsProof(
      source.id,
      tx.tx,
      inclusion(tx.hash)
    )
    return { tx, values }
  }

  // Seat i of every world wallet is operated by seats()[i - 1]; threshold 2.
  const seats = () => [w.operator, w.owner, w.depositor]
  const claimDigest = (
    x: Wallet,
    nonce: number,
    inactive: number[],
    heartbeatFailed: boolean
  ) =>
    w.frost.frostInactivityClaimDigest(x.id, nonce, inactive, heartbeatFailed)
  /// Each signing seat signs with its own operator unless `signers` says
  /// otherwise; signatures are 65-byte r ‖ s ‖ v, concatenated.
  const claim = async (
    x: Wallet,
    nonce: number,
    inactive: number[],
    heartbeatFailed: boolean,
    signing: number[],
    signers?: { signMessage(m: Uint8Array): Promise<string> }[]
  ) => {
    const digest = ethers.utils.arrayify(
      await claimDigest(x, nonce, inactive, heartbeatFailed)
    )
    const signatures: string[] = []
    for (let i = 0; i < signing.length; i++)
      signatures.push(
        await (signers?.[i] ?? seats()[signing[i] - 1]).signMessage(digest)
      )
    return w.frost.notifyFrostOperatorInactivity(
      x.id,
      nonce,
      inactive,
      heartbeatFailed,
      signing,
      ethers.utils.hexConcat(signatures)
    )
  }
  /// Register a wallet with its own roster through the registry fixture;
  /// it is made ready unless `ready` is false.
  const register = async (
    secret: number,
    operators: string[],
    threshold: number,
    ready = true
  ): Promise<Wallet> => {
    const pub = ethers.utils.computePublicKey(
      ethers.utils.hexZeroPad(ethers.utils.hexlify(secret), 32),
      true
    )
    const q = `0x${pub.slice(4)}`
    const { chainId } = await ethers.provider.getNetwork()
    const descriptor = {
      scheme: 2,
      profile: 1,
      chainId,
      registry: w.registry.address,
      epoch: await ethers.provider.getBlockNumber(),
      members: operators.map((_, i) => i + 1),
      operators,
      threshold,
      snowfallDescriptor: ethers.utils.id(`K08 wallet ${secret}`),
      outputKey: q,
    }
    const descriptorHash = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", TYPE],
        [ethers.utils.id("tbtc-v2/frost-descriptor/v1"), descriptor]
      )
    )
    const id = ethers.utils.keccak256(
      ethers.utils.concat([ethers.utils.id("tbtc-v2/frost-wallet-id/v1"), q])
    )
    await w.registry.created(
      ethers.utils.defaultAbiCoder.encode([TYPE], [descriptor]),
      (await ethers.provider.getBlockNumber()) + 100000
    )
    if (ready) await w.registry.ready(id, descriptorHash)
    return {
      q,
      id,
      label: id.slice(0, 42),
      descriptor,
      descriptorHash,
      value: 0,
    }
  }
  const inactivityEvent = async (tx: any) => {
    const receipt = await tx.wait()
    const logs = receipt.logs
      .filter((l: any) => l.address === w.frost.address)
      .map((l: any) => w.frost.interface.parseLog(l))
      .filter((e: any) => e.name === "FrostOperatorInactivityNotified")
    expect(logs.length).to.equal(1)
    return logs[0].args
  }

  before(async () => {
    w = await movementWorld(4)
    const params = await w.bridge.walletParameters()
    maxAge = params.walletMaxAge
    closingPeriod = params.walletClosingPeriod
    snapshot = await network.provider.send("evm_snapshot")
  })
  beforeEach(async () => {
    expect(await network.provider.send("evm_revert", [snapshot])).to.equal(true)
    snapshot = await network.provider.send("evm_snapshot")
  })

  it("moves an old empty wallet straight to Closing and decrements eligibility once", async () => {
    const [x] = w.wallets
    expect(await eligible()).to.equal(4)
    await expect(w.frost.notifyFrostWalletCloseable(x.id)).to.be.revertedWith(
      "FROST wallet not closeable"
    )
    await advance(maxAge)
    await expect(w.frost.notifyFrostWalletCloseable(x.id))
      .to.emit(w.frost, "FrostWalletClosing")
      .withArgs(x.id)
    expect(await w.state(x)).to.equal(State.Closing)
    expect(await eligible()).to.equal(3)
    await expect(w.frost.notifyFrostWalletCloseable(x.id)).to.be.revertedWith(
      "FROST wallet not closeable"
    )
    expect(await eligible()).to.equal(3)
  })

  it("moves a funded low-balance wallet to MovingFunds and never decrements a quarantined one twice", async () => {
    const [x, y] = w.wallets
    await w.fund(x, 600000)
    await expect(w.frost.notifyFrostWalletCloseable(x.id))
      .to.emit(w.frost, "FrostWalletMovingFunds")
      .withArgs(x.id, reason("balance"))
    expect(await w.state(x)).to.equal(State.MovingFunds)
    expect(await eligible()).to.equal(3)
    expect(
      (await w.frost.frostWalletLifecycle(x.id)).movingFundsRequestedAt
    ).to.be.gt(0)

    await w.fund(y, 600000)
    const custody = await w.frost.frostWalletCustody(y.id)
    await w.frost.quarantineFrostWallet(
      y.id,
      custody.stateVersion,
      reason("C09 quarantine reason"),
      reason("C09 quarantine evidence")
    )
    expect(await eligible()).to.equal(2)
    await w.frost.notifyFrostWalletCloseable(y.id)
    expect(await w.state(y)).to.equal(State.MovingFunds)
    expect(await eligible()).to.equal(2)
  })

  it("sends a wallet owed an incoming transfer to MovingFunds, not Closing", async () => {
    const [source, ...rest] = w.wallets
    await w.fund(source, 600000)
    await w.frost.notifyFrostWalletCloseable(source.id)
    const targets = ascending(rest)
    await w.frost.connect(w.operator).submitFrostMovingFundsCommitment(
      source.id,
      0,
      targets.map((t) => t.label)
    )
    const owed = targets[0]
    expect(await open(owed)).to.equal(Open.committedIncoming)
    await advance(maxAge)
    await w.frost.notifyFrostWalletCloseable(owed.id)
    expect(await w.state(owed)).to.equal(State.MovingFunds)
  })

  it("moves funds on a timed-out redemption and notifies the sanction with attribution", async () => {
    const [x] = w.wallets
    await w.fund(x, 600000)
    // Controlled C-04 marker: a request of this wallet observed timed out.
    // The observation path is covered by the C-04 suites.
    const requestId = reason("C09 timed out request")
    const request = w.entry(
      w.child(
        w.child(w.child(w.self, "frostRedemptions"), "ledger"),
        "requests"
      ),
      requestId
    )
    await w.writeField(w.child(request, "walletId"), x.id)
    await expect(
      w.frost.notifyFrostWalletRedemptionTimeout(requestId)
    ).to.be.revertedWith("FROST redemption timeout state")
    await w.writeField(w.child(request, "timeoutBlock"), 1)
    await expect(w.frost.notifyFrostWalletRedemptionTimeout(requestId))
      .to.emit(w.frost, "FrostSanctionNotified")
      .withArgs(x.id, x.descriptorHash, reason("redemption-timeout"))
    expect(await w.state(x)).to.equal(State.MovingFunds)
  })

  it("closes only when every closure obligation is clear, after the closing period", async () => {
    const [source, ...rest] = w.wallets
    await w.fund(source, 600000)
    // A revealed, never-swept deposit is not a closure obligation: a late
    // sweep of a real deposit reopens the wallet instead.
    const pending = await w.reveal(source, 50000)
    const pendingKey = outpoint(pending.hash, 0)
    await w.frost.notifyFrostWalletCloseable(source.id)
    expect(await open(source)).to.equal(Open.custody)

    const targets = ascending(rest)
    await w.frost.connect(w.operator).submitFrostMovingFundsCommitment(
      source.id,
      0,
      targets.map((t) => t.label)
    )
    expect(await open(source)).to.equal(Open.custody | Open.unprovenCommitment)
    const values = split(source.value - 3000, 3)
    const tx = transaction(
      [[(source.main as Tx).hash, 0]],
      targets.map((t, i) => ({ value: values[i], script: p2tr(t.q) }))
    )
    await w.frost.submitFrostMovingFundsProof(
      source.id,
      tx.tx,
      inclusion(tx.hash)
    )
    expect(await w.state(source)).to.equal(State.Closing)
    expect(await open(source)).to.equal(0)
    for (const t of targets)
      expect(await open(t)).to.equal(Open.pendingIncoming)

    await expect(
      w.frost.finalizeFrostWalletClosing(source.id)
    ).to.be.revertedWith("FROST closing period")
    // A late challenge during the closing period blocks closure until it is
    // resolved.
    const nonce = 7n
    const digest = await w.frost.frostHeartbeatDigest(source.id, nonce)
    await challenge(source, digest)
    await advance(closingPeriod + 1)
    expect(await open(source)).to.equal(Open.challenge)
    await expect(
      w.frost.finalizeFrostWalletClosing(source.id)
    ).to.be.revertedWith("FROST closure obligations")
    await w.frost.defeatFrostFraudChallengeWithHeartbeat(source.id, nonce)
    await expect(w.frost.finalizeFrostWalletClosing(source.id))
      .to.emit(w.frost, "FrostWalletClosed")
      .withArgs(source.id)
    expect(await w.state(source)).to.equal(State.Closed)
    // The revealed deposit stayed revealed and unswept throughout.
    const deposit = await w.deposit(pendingKey)
    expect(deposit.revealedAt).to.be.gt(0)
    expect(deposit.sweptAt).to.equal(0)
    // Closing deletes nothing.
    const descriptor = await w.frost.walletDescriptor(source.label)
    expect(descriptor.length).to.be.gt(2)
    expect((await w.commitment(source, 0)).provenAt).to.be.gt(0)
    expect(
      (await w.frost.frostFraudChallenge(source.id, digest)).resolved
    ).to.equal(true)
    // A target with incoming pending cannot be closed.
    await expect(
      w.frost.finalizeFrostWalletClosing(targets[0].id)
    ).to.be.revertedWith("FROST closure state")
  })

  it("reopens a Closed wallet on a late sweep of a deposit revealed while eligible, and the credit is movable", async () => {
    const [x, ...rest] = w.wallets
    expect(await w.state(x)).to.equal(State.ReadyUnfunded)
    // Refund locktime well past the closure walk, so the sweep stays a
    // realistic Bitcoin spend.
    const funding = await w.reveal(x, 50000, maxAge + closingPeriod + 86400)
    const key = outpoint(funding.hash, 0)
    expect((await w.deposit(key)).revealedAt).to.be.gt(0)

    // The wallet holds nothing and owes nothing: the revealed deposit does
    // not block, so it goes straight to Closing and then Closed.
    await advance(maxAge)
    expect(await open(x)).to.equal(0)
    await expect(w.frost.notifyFrostWalletCloseable(x.id))
      .to.emit(w.frost, "FrostWalletClosing")
      .withArgs(x.id)
    expect(await w.state(x)).to.equal(State.Closing)
    expect(await eligible()).to.equal(3)
    await advance(closingPeriod + 1)
    await expect(w.frost.finalizeFrostWalletClosing(x.id))
      .to.emit(w.frost, "FrostWalletClosed")
      .withArgs(x.id)
    expect(await w.state(x)).to.equal(State.Closed)
    const closed = await w.frost.frostWalletLifecycle(x.id)
    expect(closed.closingStartedAt).to.be.gt(0)
    // A Closed wallet takes no new reveals.
    await expect(w.reveal(x, 50000)).to.be.revertedWith("FROST deposit wallet")

    // The late sweep of the earlier reveal (no main: the wallet never had
    // custody) is credited and reopens the wallet into MovingFunds.
    const sweep = transaction(
      [[funding.hash, 0]],
      [{ value: 49000, script: p2tr(x.q) }]
    )
    const deposit = await w.deposit(key)
    const credit = deposit.terms.amount.sub(deposit.treasuryFee).sub(1000)
    const balance = await w.bank.balanceOf(w.depositor.address)
    await expect(
      w.frost.submitFrostDepositSweepProof({
        walletId: x.id,
        transaction: sweep.tx,
        proof: inclusion(sweep.hash),
        includeMain: false,
        vault: ethers.constants.AddressZero,
      })
    )
      .to.emit(w.frost, "FrostWalletReopened")
      .withArgs(x.id)
    expect(await w.bank.balanceOf(w.depositor.address)).to.equal(
      balance.add(credit)
    )
    expect((await w.deposit(key)).sweptAt).to.be.gt(0)
    const custody = await w.frost.frostWalletCustody(x.id)
    expect(custody.value).to.equal(49000)
    expect(custody.mainOutpoint).to.equal(sweep.key(0))
    expect(await w.state(x)).to.equal(State.MovingFunds)
    const reopened = await w.frost.frostWalletLifecycle(x.id)
    expect(reopened.period).to.equal(closed.period + 1)
    expect(reopened.closingStartedAt).to.equal(0)
    expect(reopened.movingFundsRequestedAt).to.be.gt(closed.closingStartedAt)
    expect(await open(x)).to.equal(Open.custody)
    // A reopened wallet is not a movement target again.
    expect(await eligible()).to.equal(3)
    await expect(w.frost.notifyFrostWalletCloseable(x.id)).to.be.revertedWith(
      "FROST wallet not closeable"
    )

    // The credited custody moves in the new period to an eligible wallet.
    const [target] = ascending(rest)
    await expect(
      w.frost
        .connect(w.operator)
        .submitFrostMovingFundsCommitment(x.id, 0, [target.label])
    ).to.emit(w.frost, "FrostMovingFundsCommitted")
    const commitment = await w.commitment(x, reopened.period)
    expect(commitment.mainOutpoint).to.equal(sweep.key(0))
    expect(commitment.targets).to.deep.equal([target.label])
    expect(await open(target)).to.equal(Open.committedIncoming)
    const move = transaction(
      [[sweep.hash, 0]],
      [{ value: 46000, script: p2tr(target.q) }]
    )
    await w.frost.submitFrostMovingFundsProof(
      x.id,
      move.tx,
      inclusion(move.hash)
    )
    expect(await w.state(x)).to.equal(State.Closing)
    expect((await w.frost.frostWalletCustody(x.id)).value).to.equal(0)
    expect(await open(x)).to.equal(0)
  })

  it("lets a terminated wallet move its funds and close once clear", async () => {
    const [x, ...rest] = w.wallets
    await w.fund(x, 600000)
    // Revealed while Live; swept only after the wallet closed.
    const late = await w.reveal(x, 50000, 365 * 86400)
    const digest = reason("C09 undefendable digest")
    await challenge(x, digest)
    await advance(7 * 86400)
    await expect(w.frost.notifyFrostFraudChallengeDefeatTimeout(x.id, digest))
      .to.emit(w.frost, "FrostSanctionNotified")
      .withArgs(x.id, x.descriptorHash, reason("fraud-defeat-timeout"))
    expect(await w.state(x)).to.equal(State.Terminated)
    expect((await w.frost.frostWalletLifecycle(x.id)).terminatedAt).to.be.gt(0)
    expect(await open(x)).to.equal(Open.custody)
    await commitAndProve(x, ascending(rest))
    expect(await w.state(x)).to.equal(State.Terminated)
    expect(await open(x)).to.equal(0)
    await advance(closingPeriod + 1)
    await w.frost.finalizeFrostWalletClosing(x.id)
    expect(await w.state(x)).to.equal(State.Closed)
    // A late deposit sweep reopens it as Terminated, not as a fresh
    // MovingFunds wallet: the sanction state survives closure.
    const { period } = await w.frost.frostWalletLifecycle(x.id)
    const sweep = transaction(
      [[late.hash, 0]],
      [{ value: 49000, script: p2tr(x.q) }]
    )
    await expect(
      w.frost.submitFrostDepositSweepProof({
        walletId: x.id,
        transaction: sweep.tx,
        proof: inclusion(sweep.hash),
        includeMain: false,
        vault: ethers.constants.AddressZero,
      })
    )
      .to.emit(w.frost, "FrostWalletReopened")
      .withArgs(x.id)
    expect(await w.state(x)).to.equal(State.Terminated)
    expect((await w.frost.frostWalletLifecycle(x.id)).period).to.equal(
      period + 1
    )
    expect(await open(x)).to.equal(Open.custody)
  })

  it("notifies sanctions on movement and incoming sweep escalations", async () => {
    const [source, ...rest] = w.wallets
    await w.fund(source, 600000)
    await w.frost.notifyFrostWalletCloseable(source.id)
    const targets = ascending(rest)
    await w.frost.connect(w.operator).submitFrostMovingFundsCommitment(
      source.id,
      0,
      targets.map((t) => t.label)
    )
    await advance(7 * 86400 + 1)
    await expect(w.frost.notifyFrostMovingFundsTimeout(source.id))
      .to.emit(w.frost, "FrostSanctionNotified")
      .withArgs(
        source.id,
        source.descriptorHash,
        reason("moving-funds-timeout")
      )
    const values = split(source.value - 3000, 3)
    const tx = transaction(
      [[(source.main as Tx).hash, 0]],
      targets.map((t, i) => ({ value: values[i], script: p2tr(t.q) }))
    )
    await w.frost.submitFrostMovingFundsProof(
      source.id,
      tx.tx,
      inclusion(tx.hash)
    )
    await advance(10 * 86400 + 1)
    await expect(w.frost.notifyFrostMovedFundsSweepTimeout(tx.key(0)))
      .to.emit(w.frost, "FrostSanctionNotified")
      .withArgs(
        targets[0].id,
        targets[0].descriptorHash,
        reason("moved-funds-sweep-timeout")
      )
  })
  it("moves a Live wallet on a heartbeat-failure inactivity claim and names the seat and operator", async () => {
    const [x] = w.wallets
    await w.fund(x, 600000)
    expect(await w.state(x)).to.equal(State.Live)
    expect(await w.frost.frostInactivityNonce(x.id)).to.equal(0)
    const { chainId } = await ethers.provider.getNetwork()
    expect(await claimDigest(x, 0, [3], true)).to.equal(
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          [
            "bytes32",
            "uint256",
            "address",
            "bytes32",
            "bytes32",
            "uint64",
            "uint16[]",
            "bool",
          ],
          [
            ethers.utils.id("tbtc-v2/frost-inactivity/v1"),
            chainId,
            w.proxy.address,
            x.id,
            x.descriptorHash,
            0,
            [3],
            true,
          ]
        )
      )
    )
    const eligibleBefore = await eligible()
    const tx = await claim(x, 0, [3], true, [1, 2])
    await expect(tx)
      .to.emit(w.frost, "FrostSanctionNotified")
      .withArgs(x.id, x.descriptorHash, reason("inactivity"))
    await expect(tx)
      .to.emit(w.frost, "FrostWalletMovingFunds")
      .withArgs(x.id, reason("heartbeat-failure"))
    const event = await inactivityEvent(tx)
    expect(event.walletId).to.equal(x.id)
    expect(event.nonce).to.equal(0)
    expect(event.inactiveSeats).to.deep.equal([3])
    expect(event.inactiveOperators).to.deep.equal([w.depositor.address])
    expect(event.heartbeatFailed).to.equal(true)
    expect(await w.state(x)).to.equal(State.MovingFunds)
    expect(await eligible()).to.equal(eligibleBefore - 1)
    expect(await w.frost.frostInactivityNonce(x.id)).to.equal(1)
    expect((await w.frost.frostWalletLifecycle(x.id)).inactivityNonce).to.equal(
      1
    )
  })

  it("increments the inactivity nonce and refuses a replayed, stale or future claim", async () => {
    const [x] = w.wallets
    await claim(x, 0, [3], false, [1, 2])
    expect(await w.frost.frostInactivityNonce(x.id)).to.equal(1)
    // The same claim again (duplicate): its nonce is spent.
    await expect(claim(x, 0, [3], false, [1, 2])).to.be.revertedWith(
      "FROST inactivity nonce"
    )
    await expect(claim(x, 2, [3], false, [1, 2])).to.be.revertedWith(
      "FROST inactivity nonce"
    )
    await claim(x, 1, [3], false, [1, 2])
    expect(await w.frost.frostInactivityNonce(x.id)).to.equal(2)
    // Nonces are per wallet.
    expect(await w.frost.frostInactivityNonce(w.wallets[1].id)).to.equal(0)
  })

  it("refuses a claimed signer, too few signers, a wrong operator and malformed seat lists", async () => {
    const [x] = w.wallets
    // A signer in the claimed set.
    await expect(claim(x, 0, [2], false, [1, 2])).to.be.revertedWith(
      "FROST inactivity signers"
    )
    // Fewer than threshold (2) signers.
    await expect(claim(x, 0, [3], false, [1])).to.be.revertedWith(
      "FROST inactivity signers"
    )
    // Seat 2 signed by seat 3's operator (member mismatch).
    await expect(
      claim(x, 0, [3], false, [1, 2], [w.operator, w.depositor])
    ).to.be.revertedWith("FROST inactivity signature")
    // A signature over another claim.
    const other = ethers.utils.arrayify(await claimDigest(x, 0, [2], false))
    await expect(
      w.frost.notifyFrostOperatorInactivity(
        x.id,
        0,
        [3],
        false,
        [1, 2],
        ethers.utils.hexConcat([
          await w.operator.signMessage(other),
          await w.owner.signMessage(other),
        ])
      )
    ).to.be.revertedWith("FROST inactivity signature")
    // Signature bytes not 65 per signer.
    const digest = ethers.utils.arrayify(await claimDigest(x, 0, [3], false))
    await expect(
      w.frost.notifyFrostOperatorInactivity(
        x.id,
        0,
        [3],
        false,
        [1, 2],
        await w.operator.signMessage(digest)
      )
    ).to.be.revertedWith("FROST inactivity signers")
    // Non-ascending signing seats.
    await expect(claim(x, 0, [3], false, [2, 1])).to.be.revertedWith(
      "FROST inactivity signers"
    )
    // Non-ascending, repeated, empty and out-of-range claimed seats.
    await expect(claim(x, 0, [2, 1], false, [3])).to.be.revertedWith(
      "FROST inactivity seats"
    )
    await expect(claim(x, 0, [3, 3], false, [1, 2])).to.be.revertedWith(
      "FROST inactivity seats"
    )
    await expect(claim(x, 0, [], false, [1, 2])).to.be.revertedWith(
      "FROST inactivity seats"
    )
    await expect(claim(x, 0, [4], false, [1, 2])).to.be.revertedWith(
      "FROST inactivity seats"
    )
    await expect(claim(x, 0, [0], false, [1, 2])).to.be.revertedWith(
      "FROST inactivity seats"
    )
    // A signing seat out of range.
    await expect(
      claim(x, 0, [1], false, [2, 4], [w.owner, w.depositor])
    ).to.be.revertedWith("FROST inactivity signers")
    expect(await w.frost.frostInactivityNonce(x.id)).to.equal(0)
  })

  it("refuses claims against a Closed, unknown or not yet ready wallet", async () => {
    const [x] = w.wallets
    await advance(maxAge)
    await w.frost.notifyFrostWalletCloseable(x.id)
    await advance(closingPeriod + 1)
    await w.frost.finalizeFrostWalletClosing(x.id)
    expect(await w.state(x)).to.equal(State.Closed)
    await expect(claim(x, 0, [3], true, [1, 2])).to.be.revertedWith(
      "FROST inactivity wallet"
    )
    const unknown = { ...x, id: ethers.utils.id("C09 unknown wallet") }
    await expect(claim(unknown, 0, [3], true, [1, 2])).to.be.revertedWith(
      "FROST inactivity wallet"
    )
    const pending = await register(
      3000,
      seats().map((s) => s.address),
      2,
      false
    )
    expect(await w.state(pending)).to.equal(State.RegisteredPendingReady)
    await expect(claim(pending, 0, [3], true, [1, 2])).to.be.revertedWith(
      "FROST inactivity wallet"
    )
  })

  it("only records a claim without heartbeat failure, or on a wallet that is not Live", async () => {
    const [x, y, z] = w.wallets
    await w.fund(x, 600000)
    const tx = await claim(x, 0, [3], false, [1, 2])
    await expect(tx)
      .to.emit(w.frost, "FrostSanctionNotified")
      .withArgs(x.id, x.descriptorHash, reason("inactivity"))
    await expect(tx).not.to.emit(w.frost, "FrostWalletMovingFunds")
    expect((await inactivityEvent(tx)).heartbeatFailed).to.equal(false)
    expect(await w.state(x)).to.equal(State.Live)

    // ReadyUnfunded: recorded only.
    expect(await w.state(z)).to.equal(State.ReadyUnfunded)
    await expect(claim(z, 0, [1], true, [2, 3])).not.to.emit(
      w.frost,
      "FrostWalletMovingFunds"
    )
    expect(await w.state(z)).to.equal(State.ReadyUnfunded)

    // MovingFunds: recorded only; the movement request time is unchanged.
    await w.fund(y, 600000)
    await w.frost.notifyFrostWalletCloseable(y.id)
    expect(await w.state(y)).to.equal(State.MovingFunds)
    const requested = (await w.frost.frostWalletLifecycle(y.id))
      .movingFundsRequestedAt
    await advance(60)
    const moving = await claim(y, 0, [3], true, [1, 2])
    await expect(moving).not.to.emit(w.frost, "FrostWalletMovingFunds")
    await expect(moving)
      .to.emit(w.frost, "FrostSanctionNotified")
      .withArgs(y.id, y.descriptorHash, reason("inactivity"))
    expect(await w.state(y)).to.equal(State.MovingFunds)
    expect(
      (await w.frost.frostWalletLifecycle(y.id)).movingFundsRequestedAt
    ).to.equal(requested)
    expect(await w.frost.frostInactivityNonce(y.id)).to.equal(1)
  })

  it("measures a 100-seat claim with 51 signatures under the 2^24 gas cap", async function measure() {
    this.timeout(180000)
    const n = 100
    const threshold = 51
    const operators = Array.from(
      { length: n },
      (_, i) => new ethers.Wallet(ethers.utils.id(`K08 operator ${i + 1}`))
    )
    const big = await register(
      2000,
      operators.map((o) => o.address),
      threshold
    )
    await w.fund(big, 600000)
    expect(await w.state(big)).to.equal(State.Live)
    // Seats 1..51 sign; seats 52..100 are claimed.
    const signing = Array.from({ length: threshold }, (_, i) => i + 1)
    const inactive = Array.from({ length: n - threshold }, (_, i) => i + 52)
    const tx = await claim(
      big,
      0,
      inactive,
      true,
      signing,
      signing.map((s) => operators[s - 1])
    )
    const receipt = await tx.wait()
    // eslint-disable-next-line no-console
    console.log(
      `      100-seat inactivity claim (51 signatures, 49 claimed) gas: ${receipt.gasUsed.toString()}`
    )
    expect(receipt.gasUsed.toNumber()).to.be.lessThan(16777216)
    expect((await inactivityEvent(tx)).inactiveOperators).to.deep.equal(
      inactive.map((s) => operators[s - 1].address)
    )
    expect(await w.state(big)).to.equal(State.MovingFunds)
  })
})
