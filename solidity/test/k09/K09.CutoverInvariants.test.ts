/* eslint-disable no-await-in-loop */
// K-09 cutover and containment invariants at the contract level, in the
// composed state of `k09-legacy-ledger` (40a11d1d Bridge upgraded in place,
// real ECDSA WalletRegistry, FrostOnly, a FROST wallet created after the
// cutover, exposure contained).
//
// - tuxxy/keep-core#25 (K09-4): "New DKG uses FROST after cutoff; legacy
//   pending work survives cutoff and containment". The second half is the
//   ledger suite (`K09.LegacyObligations`), whose every case runs in this
//   composed state.
// - tuxxy/keep-core#32 (K09-12): negative witnesses for the cutover and
//   containment steps, asserting each contract's own revert reason and the
//   full state frame.
// - tuxxy/keep-core#31 (K09-11): closure refuses an open challenge with the
//   contract's own revert, reached by a direct closure transaction.
import { ethers } from "hardhat"
import { expect } from "chai"
import * as secp from "@noble/secp256k1"
import {
  ledgerWorld,
  ledgerFrame,
  LedgerWorld,
  BOND,
} from "../helpers/k09-legacy-ledger"
import { transaction, p2tr, TYPE, raw } from "../helpers/frost-movement-world"
import {
  Mode,
  NO_MAIN,
  increaseTime,
  now,
  storageFrame,
} from "../helpers/k09-registry-world"

describe("K-09 cutover and containment invariants in the composed state (keep-core#25, #31, #32)", function () {
  this.timeout(180_000)
  let l: LedgerWorld

  before(async () => {
    await ledgerWorld()
  })
  beforeEach(async () => {
    l = await ledgerWorld()
    expect(await l.frost.frostCreationMode()).to.equal(Mode.FrostOnly)
    expect(await l.exposure.contained()).to.equal(true)
  })

  /// The ledger frame plus every fixed storage word of the Bridge, registry,
  /// sortition pool and exposure controller.
  const fullFrame = async () => ({
    ledger: await ledgerFrame(l),
    storage: await storageFrame(l),
    dkgState: await l.registry.getWalletCreationState(),
  })

  /// A FROST deposit reveal into the post-cutover wallet `Q` (new exposure).
  let revealed = 0
  const revealIntoQ = async () => {
    revealed += 1
    const { chainId } = await ethers.provider.getNetwork()
    const terms = {
      chainId,
      bridge: l.proxy.address,
      bitcoinGenesis: l.genesis,
      fullWalletId: l.frostWallet.id,
      descriptorHash: l.frostWallet.descriptorHash,
      depositor: l.alias.address,
      vault: ethers.constants.AddressZero,
      blinding: ethers.utils.hexZeroPad(ethers.utils.hexlify(revealed), 8),
      amount: 50000,
      refundKey: l.frostWallet.q,
      refundLocktime: (await now()) + 86400,
      extraData: ethers.constants.HashZero,
    }
    const output = await l.frost.frostDepositOutput(terms)
    const funding = transaction(
      [[ethers.utils.id(`K09-12 funding ${revealed}`), 0]],
      [{ value: 50000, script: p2tr(output.key) }]
    )
    return l.frost.connect(l.alias).revealFrostDeposit(terms, funding.tx, 0)
  }

  /// Registers one more FROST wallet through the FROST registry FIXTURE.
  const newFrostWallet = async (scalar: number) => {
    const { chainId } = await ethers.provider.getNetwork()
    const q = `0x${ethers.utils
      .computePublicKey(
        ethers.utils.hexZeroPad(ethers.utils.hexlify(scalar), 32),
        true
      )
      .slice(4)}`
    const descriptor = {
      ...l.frostWallet.descriptor,
      chainId,
      epoch: await ethers.provider.getBlockNumber(),
      snowfallDescriptor: ethers.utils.id(`K09-4 wallet ${scalar}`),
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
    await l.frostRegistry.created(
      ethers.utils.defaultAbiCoder.encode([TYPE], [descriptor]),
      (await ethers.provider.getBlockNumber()) + 100000
    )
    await l.frostRegistry.ready(id, descriptorHash)
    return { q, id, label: id.slice(0, 42) }
  }

  // keep-core#25 (K09-4): after the cutover the only new wallets are FROST.
  it("[K09-4] after the cutover a new wallet request is FROST-only: the ECDSA request refuses, a FROST wallet registers and becomes a drain target", async () => {
    // The wallet created in the fixture after the cutover is registered.
    expect(
      await l.frost.walletDescriptor(l.frostWallet.label),
      "post-cutover FROST wallet registered"
    ).to.not.equal("0x")
    const eligible = (await l.frost.frostMovementCounters(l.frostWallet.id))
      .eligibleTargets
    await expect(
      l.bridge.requestNewWallet(NO_MAIN),
      "ECDSA wallet request after the cutover"
    ).to.be.revertedWith("Legacy wallet creation closed")
    await expect(
      l.frost.requestNewFrostWallet(),
      "FROST wallet request after the cutover"
    ).to.not.be.reverted
    const second = await newFrostWallet(0x3001)
    expect(
      await l.frost.walletDescriptor(second.label),
      "second post-cutover FROST wallet registered"
    ).to.not.equal("0x")
    expect(
      (await l.frost.frostMovementCounters(second.id)).eligibleTargets,
      "the new FROST wallet is a drain target"
    ).to.equal(eligible.add(1))
    expect(await l.registry.getWalletCreationState()).to.equal(0)
  })

  // keep-core#32 (K09-12): the cutover step's negative witness.
  it("[K09-12] refuses a new ECDSA wallet after the cutover with the contract's reason and the full frame unchanged", async () => {
    const before = await fullFrame()
    await expect(
      l.bridge.requestNewWallet(NO_MAIN),
      "cutover refusal"
    ).to.be.revertedWith("Legacy wallet creation closed")
    // A second cutover and a drain abort are refused by their own guards.
    await expect(
      l.frost.completeFrostCutover(ethers.utils.id("again")),
      "second cutover"
    ).to.be.revertedWith("FROST cutover state")
    await expect(
      l.frost.abortLegacyDkgDrain(ethers.utils.id("abort")),
      "abort after the cutover"
    ).to.be.revertedWith("Legacy DKG drain abort")
    expect(await fullFrame(), "full frame after the refusals").to.deep.equal(
      before
    )
  })

  // keep-core#32 (K09-12): the containment step's negative witness.
  it("[K09-12] refuses a new FROST deposit under containment with the controller's reason and the full frame unchanged; the same reveal passes once lifted", async () => {
    const before = await fullFrame()
    await expect(revealIntoQ(), "containment refusal").to.be.revertedWith(
      "FROST exposure contained"
    )
    expect(await fullFrame(), "full frame after the refusal").to.deep.equal(
      before
    )
    // Positive twin: nothing else stood in the way of that reveal.
    await l.exposure.lift(ethers.utils.id("K09-12 lift"))
    await expect(revealIntoQ(), "the same reveal after lift").to.not.be.reverted
  })

  // keep-core#31 (K09-11): closure with an open challenge.
  it("[K09-11] refuses to close a FROST wallet with an open challenge with the contract's own revert, by a direct closure transaction", async () => {
    const q = l.frostWallet
    const maxAge = (await l.bridge.walletParameters()).walletMaxAge
    await increaseTime(Number(maxAge) + 1)
    await l.frost.connect(l.alias).notifyFrostWalletCloseable(q.id)
    const nonce = 7
    const digest = await l.frost.frostHeartbeatDigest(q.id, nonce)
    const signature = `0x${Buffer.from(
      await secp.schnorr.sign(
        raw(digest),
        ethers.utils.hexZeroPad(q.privateScalar, 32).slice(2),
        new Uint8Array(32)
      )
    ).toString("hex")}`
    await l.frost
      .connect(l.alias)
      .submitFrostFraudChallenge(q.id, digest, signature, { value: BOND })
    const closing = (await l.bridge.walletParameters()).walletClosingPeriod
    await increaseTime(Number(closing) + 1)
    const before = {
      ...(await fullFrame()),
      challenge: await l.frost.frostFraudChallenge(q.id, digest),
    }
    expect(
      (await l.frost.frostClosureObligations(q.id)).toNumber(),
      "the open challenge is the only obligation"
    ).to.equal(128)
    await expect(
      l.frost.connect(l.alias).finalizeFrostWalletClosing(q.id),
      "closure with an open challenge"
    ).to.be.revertedWith("FROST closure obligations")
    expect(
      {
        ...(await fullFrame()),
        challenge: await l.frost.frostFraudChallenge(q.id, digest),
      },
      "full frame after the refused closure"
    ).to.deep.equal(before)
    // Positive twin: once the challenge is defeated the same call closes.
    await l.frost
      .connect(l.alias)
      .defeatFrostFraudChallengeWithHeartbeat(q.id, nonce)
    await expect(l.frost.connect(l.alias).finalizeFrostWalletClosing(q.id))
      .to.emit(l.frost, "FrostWalletClosed")
      .withArgs(q.id)
  })
})
