/* eslint-disable no-await-in-loop */
import { ethers } from "hardhat"
import { expect } from "chai"
import fs from "fs"
import path from "path"
import { completeLegacyCutover } from "../helpers/frost-legacy-cutover"
import {
  publicLegacyOriginFixture,
  legacyPaymentPhase,
} from "../helpers/frost-legacy-bitcoin"

// Public legacy precursors on 76f7905, real Core transactions and actual proxy
// upgrades. Registry membership and zero integer regtest relay difficulty are
// explicit fixture assumptions. No Bridge or Bank storage writes are used.
describe("K-09 pending legacy obligations across actual upgrade", () => {
  const root = () =>
    path.join(
      process.env.FROST_C04_LEGACY_PUBLIC_EVIDENCE ||
        "/private/tmp/k09-upgrade-evidence",
      "k09"
    )
  const empty = {
    txHash: ethers.constants.HashZero,
    txOutputIndex: 0,
    txOutputValue: 0,
  }
  const littleHash = (hash: string) =>
    `0x${Buffer.from(hash, "hex").reverse().toString("hex")}`
  const outpoint = (hash: string) =>
    ethers.utils.solidityKeccak256(["bytes32", "uint32"], [hash, 0])
  const originalSlots = (address: string) =>
    Promise.all(
      Array.from({ length: 129 }, (_, i) =>
        ethers.provider.getStorageAt(address, i)
      )
    )

  it("retains a revealed deposit and open heartbeat fraud challenge, then sweeps and defends publicly", async () => {
    const evidence = path.join(root(), "deposit-challenge")
    let checked = false
    await publicLegacyOriginFixture(
      evidence,
      async ({ bridge, bank, admin, witness, deployCurrent }) => {
        const key = ethers.utils.solidityKeccak256(
          ["bytes32", "uint32"],
          [littleHash(witness.funding.txid), witness.reveal.fundingOutputIndex]
        )
        const publicKey = `0x${witness.wallet.publicKeyX.slice(
          2
        )}${witness.wallet.publicKeyY.slice(2)}`
        const heartbeat = "0xffffffffffffffff0000000000e0eed7"
        const preimage = ethers.utils.sha256(heartbeat)
        const digest = ethers.utils.sha256(preimage)
        const signing = new ethers.utils.SigningKey(
          ethers.utils.hexZeroPad("0x03", 32)
        )
        const sig = ethers.utils.splitSignature(signing.signDigest(digest))
        const parameters = await bridge.fraudParameters()
        await bridge.submitFraudChallenge(publicKey, preimage, sig, {
          value: parameters.fraudChallengeDepositAmount,
        })
        const challengeKey = ethers.utils.solidityKeccak256(
          ["bytes", "bytes32"],
          [publicKey, digest]
        )
        const [, depositor, treasury] = await ethers.getSigners()
        const frame = async () =>
          JSON.stringify(
            await Promise.all([
              bridge.wallets(witness.wallet.pubKeyHash),
              bridge.deposits(key),
              bridge.fraudChallenges(challengeKey),
              bridge.depositParameters(),
              bridge.fraudParameters(),
              bank.balanceOf(depositor.address),
              bank.balanceOf(treasury.address),
              bank.balanceOf(bridge.address),
              bank.allowance(depositor.address, bridge.address),
              bank.nonces(depositor.address),
              bank.bridge(),
              ethers.provider.getBalance(bridge.address),
              ethers.provider.getBalance(treasury.address),
            ])
          )
        expect((await bridge.deposits(key)).revealedAt).greaterThan(0)
        expect((await bridge.deposits(key)).sweptAt).eq(0)
        expect((await bridge.fraudChallenges(challengeKey)).resolved).eq(false)
        const before = await frame()
        const slots = await originalSlots(bridge.address)
        const current = await deployCurrent()
        await admin.upgrade(bridge.address, current.address)
        expect(await frame()).eq(before)
        expect(await originalSlots(bridge.address)).deep.eq(slots)
        await completeLegacyCutover(bridge)
        expect(await frame()).eq(before)
        await bridge.defeatFraudChallengeWithHeartbeat(publicKey, heartbeat)
        expect((await bridge.fraudChallenges(challengeKey)).resolved).eq(true)
        const resolved = await frame()
        await expect(
          bridge.defeatFraudChallengeWithHeartbeat(publicKey, heartbeat)
        ).to.be.revertedWith("Fraud challenge has already been resolved")
        expect(await frame()).eq(resolved)
        fs.writeFileSync(
          path.join(evidence, "upgrade-obligations.json"),
          JSON.stringify(
            {
              evidenceClass: "concrete testing",
              pending: ["revealed-deposit", "fraud-challenge"],
              framePreserved: true,
              originalSlotsPreserved: true,
              limits: [
                "controlled legacy registry",
                "zero integer regtest relay difficulty",
                "known test scalar 3",
              ],
            },
            null,
            2
          )
        )
        checked = true
      }
    )
    // The fixture continues AFTER the upgrade: the pending deposit is swept
    // with its real Core proof, credits the real Bank, and creates a request.
    expect(checked).eq(true)
  })

  it("preserves the original redemption deadline when redeemer and timeout notifier alias", async () => {
    const f = await publicLegacyOriginFixture(
      path.join(root(), "redemption-timeout-alias")
    )
    const beforeUser = await f.bank.balanceOf(f.depositor.address)
    const escrow = await f.bank.balanceOf(f.bridge.address)
    const treasury = await f.bank.balanceOf(f.treasury.address)
    expect(escrow).gt(0)
    const pending = await f.bridge.pendingRedemptions(f.requestKey)
    const slots = await originalSlots(f.bridge.address)
    await f.admin.upgrade(f.bridge.address, (await f.deployCurrent()).address)
    expect(await originalSlots(f.bridge.address)).deep.eq(slots)
    await completeLegacyCutover(f.bridge)
    expect(await f.bridge.pendingRedemptions(f.requestKey)).deep.eq(pending)
    await ethers.provider.send("evm_setNextBlockTimestamp", [
      f.deadline.toNumber() + 1,
    ])
    await ethers.provider.send("evm_mine", [])
    await f.bridge
      .connect(f.depositor)
      .notifyRedemptionTimeout(
        f.witness.wallet.pubKeyHash,
        [1],
        f.recipientScript
      )
    expect(await f.bank.balanceOf(f.depositor.address)).eq(
      beforeUser.add(escrow)
    )
    expect(await f.bank.balanceOf(f.bridge.address)).eq(0)
    expect(await f.bank.balanceOf(f.treasury.address)).eq(treasury)
    const frame = async () =>
      JSON.stringify(
        await Promise.all([
          f.bridge.wallets(f.witness.wallet.pubKeyHash),
          f.bridge.pendingRedemptions(f.requestKey),
          f.bridge.timedOutRedemptions(f.requestKey),
          f.bank.balanceOf(f.depositor.address),
          f.bank.balanceOf(f.bridge.address),
          f.bank.balanceOf(f.treasury.address),
        ])
      )
    const terminal = await frame()
    const [other] = await ethers.getSigners()
    await expect(
      f.bridge
        .connect(other)
        .notifyRedemptionTimeout(
          f.witness.wallet.pubKeyHash,
          [1],
          f.recipientScript
        )
    ).to.be.revertedWith("Redemption request does not exist")
    expect(await frame()).eq(terminal)
  })

  it("preserves a public fraud challenge through upgrade until its original timeout", async () => {
    const f = await publicLegacyOriginFixture(
      path.join(root(), "fraud-timeout")
    )
    await ethers.provider.send("evm_setNextBlockTimestamp", [
      f.deadline.toNumber() + 1,
    ])
    await ethers.provider.send("evm_mine", [])
    await f.bridge.notifyRedemptionTimeout(
      f.witness.wallet.pubKeyHash,
      [1],
      f.recipientScript
    )
    const publicKey = `0x${f.witness.wallet.publicKeyX.slice(
      2
    )}${f.witness.wallet.publicKeyY.slice(2)}`
    const heartbeat = "0xffffffffffffffff0000000000e0eed7"
    const preimage = ethers.utils.sha256(heartbeat)
    const digest = ethers.utils.sha256(preimage)
    const signing = new ethers.utils.SigningKey(
      ethers.utils.hexZeroPad("0x03", 32)
    )
    const signature = ethers.utils.splitSignature(signing.signDigest(digest))
    const parameters = await f.bridge.fraudParameters()
    await f.bridge.submitFraudChallenge(publicKey, preimage, signature, {
      value: parameters.fraudChallengeDepositAmount,
    })
    const key = ethers.utils.solidityKeccak256(
      ["bytes", "bytes32"],
      [publicKey, digest]
    )
    const challenge = await f.bridge.fraudChallenges(key)
    const frame = async () =>
      JSON.stringify(
        await Promise.all([
          f.bridge.wallets(f.witness.wallet.pubKeyHash),
          f.bridge.fraudChallenges(key),
          f.bridge.pendingRedemptions(f.requestKey),
          f.bridge.timedOutRedemptions(f.requestKey),
          f.bank.balanceOf(f.depositor.address),
          f.bank.balanceOf(f.bridge.address),
          f.bank.balanceOf(f.treasury.address),
          ethers.provider.getBalance(f.bridge.address),
          ethers.provider.getBalance(f.depositor.address),
          ethers.provider.getBalance(f.treasury.address),
        ])
      )
    const before = await frame()
    const slots = await originalSlots(f.bridge.address)
    await f.admin.upgrade(f.bridge.address, (await f.deployCurrent()).address)
    expect(await frame()).eq(before)
    expect(await originalSlots(f.bridge.address)).deep.eq(slots)
    await completeLegacyCutover(f.bridge)
    expect(await frame()).eq(before)
    expect(await f.bridge.fraudChallenges(key)).deep.eq(challenge)
    await ethers.provider.send("evm_setNextBlockTimestamp", [
      Number(challenge.reportedAt) +
        Number(parameters.fraudChallengeDefeatTimeout) +
        1,
    ])
    await ethers.provider.send("evm_mine", [])
    await f.bridge.notifyFraudChallengeDefeatTimeout(publicKey, [1], preimage)
    expect((await f.bridge.wallets(f.witness.wallet.pubKeyHash)).state).eq(5)
    expect((await f.bridge.fraudChallenges(key)).resolved).eq(true)
    const terminal = await frame()
    await expect(
      f.bridge.notifyFraudChallengeDefeatTimeout(publicKey, [1], preimage)
    ).to.be.revertedWith("Fraud challenge has already been resolved")
    expect(await frame()).eq(terminal)
  })

  for (const checkpoint of [
    "outgoing",
    "incoming",
    "outgoing-timeout",
    "incoming-timeout",
  ] as const) {
    it(`retains a pending ${checkpoint} transfer across upgrade, then discharges it`, async () => {
      const evidence = path.join(root(), checkpoint)
      const f = await publicLegacyOriginFixture(evidence)
      // The publicly escrowed request is refunded at its ORIGINAL deadline,
      // which moves the source wallet and frees creation of a healthy target.
      await ethers.provider.send("evm_setNextBlockTimestamp", [
        f.deadline.toNumber() + 1,
      ])
      await ethers.provider.send("evm_mine", [])
      await f.bridge.notifyRedemptionTimeout(
        f.witness.wallet.pubKeyHash,
        [1],
        f.recipientScript
      )
      expect((await f.bridge.wallets(f.witness.wallet.pubKeyHash)).state).eq(2)
      expect(await f.bank.balanceOf(f.bridge.address)).eq(0)
      expect(await f.bank.balanceOf(f.depositor.address)).eq(98000)
      const targetKey = new ethers.utils.SigningKey(
        ethers.utils.hexZeroPad("0x04", 32)
      )
      const targetPub = targetKey.publicKey
      const targetHash = ethers.utils.computeAddress(targetPub) // Only a label for fixture identity.
      const targetPkh = ethers.utils.ripemd160(
        ethers.utils.sha256(targetKey.compressedPublicKey)
      )
      await f.bridge.requestNewWallet(empty)
      await f.registry.publish(
        ethers.utils.id(targetHash),
        `0x${targetPub.slice(4, 68)}`,
        `0x${targetPub.slice(68)}`
      )
      await f.bridge.submitMovingFundsCommitment(
        f.witness.wallet.pubKeyHash,
        f.witness.mainUTXO,
        [1],
        1,
        [targetPkh]
      )
      const prepared = await legacyPaymentPhase(
        path.join(evidence, "move"),
        f.witness,
        "prepare",
        undefined,
        targetPkh
      )
      const movedHash = littleHash(prepared.archive.transaction.txidRPC)
      const incomingKey = outpoint(movedHash)
      const crossHeartbeat = "0xffffffffffffffff0000000000e0eed7"
      const crossPreimage = ethers.utils.sha256(crossHeartbeat)
      const crossDigest = ethers.utils.sha256(crossPreimage)
      const crossKey = ethers.utils.solidityKeccak256(
        ["bytes", "bytes32"],
        [`0x${targetPub.slice(4)}`, crossDigest]
      )
      if (checkpoint === "outgoing") {
        const parameters = await f.bridge.fraudParameters()
        await f.bridge.submitFraudChallenge(
          `0x${targetPub.slice(4)}`,
          crossPreimage,
          ethers.utils.splitSignature(targetKey.signDigest(crossDigest)),
          { value: parameters.fraudChallengeDepositAmount }
        )
      }
      const frame = async () =>
        JSON.stringify(
          await Promise.all([
            f.bridge.wallets(f.witness.wallet.pubKeyHash),
            f.bridge.wallets(targetPkh),
            f.bridge.movedFundsSweepRequests(incomingKey),
            f.bridge.fraudChallenges(crossKey),
            f.bridge.spentMainUTXOs(outpoint(f.witness.mainUTXO.txHash)),
            f.bridge.spentMainUTXOs(incomingKey),
            f.bridge.pendingRedemptions(f.requestKey),
            f.bridge.timedOutRedemptions(f.requestKey),
            f.bridge.movingFundsParameters(),
            f.bridge.redemptionParameters(),
            f.bank.balanceOf(f.depositor.address),
            f.bank.balanceOf(f.bridge.address),
            f.bank.balanceOf(f.treasury.address),
          ])
        )
      const proveMovement = async (proof: any) =>
        f.bridge
          .connect(f.maintainer)
          .submitMovingFundsProof(
            prepared.archive.transaction,
            proof,
            f.witness.mainUTXO,
            f.witness.wallet.pubKeyHash
          )
      let mined: Awaited<ReturnType<typeof legacyPaymentPhase>>
      if (checkpoint.startsWith("incoming")) {
        mined = await legacyPaymentPhase(
          path.join(evidence, "move"),
          f.witness,
          "mine",
          prepared.archive
        )
        await proveMovement(mined.proof)
        expect((await f.bridge.movedFundsSweepRequests(incomingKey)).state).eq(
          1
        )
      }
      const before = await frame()
      const slots = await originalSlots(f.bridge.address)
      const current = await f.deployCurrent()
      await f.admin.upgrade(f.bridge.address, current.address)
      expect(await frame()).eq(before)
      expect(await originalSlots(f.bridge.address)).deep.eq(slots)
      await completeLegacyCutover(f.bridge)
      expect(await frame()).eq(before)
      if (checkpoint.endsWith("timeout")) {
        const parameters = await f.bridge.movingFundsParameters()
        const request = await f.bridge.movedFundsSweepRequests(incomingKey)
        const wallet = await f.bridge.wallets(f.witness.wallet.pubKeyHash)
        const deadline =
          checkpoint === "outgoing-timeout"
            ? wallet.movingFundsRequestedAt + parameters.movingFundsTimeout
            : request.createdAt + parameters.movedFundsSweepTimeout
        await ethers.provider.send("evm_setNextBlockTimestamp", [
          Number(deadline) + 1,
        ])
        await ethers.provider.send("evm_mine", [])
        const notify = () =>
          checkpoint === "outgoing-timeout"
            ? f.bridge.notifyMovingFundsTimeout(f.witness.wallet.pubKeyHash, [
                1,
              ])
            : f.bridge.notifyMovedFundsSweepTimeout(movedHash, 0, [1])
        await notify()
        expect(
          (
            await f.bridge.wallets(
              checkpoint === "outgoing-timeout"
                ? f.witness.wallet.pubKeyHash
                : targetPkh
            )
          ).state
        ).eq(5)
        if (checkpoint === "incoming-timeout")
          expect(
            (await f.bridge.movedFundsSweepRequests(incomingKey)).state
          ).eq(3)
        const terminal = await frame()
        await expect(notify()).to.be.revertedWith(
          checkpoint === "outgoing-timeout"
            ? "Wallet must be in MovingFunds state"
            : "Sweep request must be in Pending state"
        )
        expect(await frame()).eq(terminal)
        return
      }
      if (checkpoint === "outgoing") {
        mined = await legacyPaymentPhase(
          path.join(evidence, "move"),
          f.witness,
          "mine",
          prepared.archive
        )
        await proveMovement(mined.proof)
        // Interleave source movement with the target's independently pending
        // challenge. Neither may consume or discard the other's obligation.
        expect((await f.bridge.fraudChallenges(crossKey)).resolved).eq(false)
        await f.bridge.defeatFraudChallengeWithHeartbeat(
          `0x${targetPub.slice(4)}`,
          crossHeartbeat
        )
        expect((await f.bridge.fraudChallenges(crossKey)).resolved).eq(true)
      }
      expect((await f.bridge.wallets(f.witness.wallet.pubKeyHash)).state).eq(3)
      expect((await f.bridge.movedFundsSweepRequests(incomingKey)).state).eq(1)
      // Continue from the STOPPED Core chain containing the mined movement.
      // The new main is the target's sweep of this exact incoming outpoint.
      const targetWitness = {
        ...f.witness,
        dataDirectory: mined!.dataDirectory!,
        wallet: {
          ...f.witness.wallet,
          compressedPublicKey: targetKey.compressedPublicKey,
          pubKeyHash: targetPkh,
          knownScalar: 4,
        },
        mainScript: `0x0014${targetPkh.slice(2)}`,
        sweep: {
          ...f.witness.sweep,
          txid: prepared.archive.transaction.txidRPC,
          value: 98000,
        },
      }
      const sweep = await legacyPaymentPhase(
        path.join(evidence, "sweep"),
        targetWitness,
        "prepare",
        undefined,
        targetPkh
      )
      const swept = await legacyPaymentPhase(
        path.join(evidence, "sweep"),
        targetWitness,
        "mine",
        sweep.archive
      )
      await f.bridge
        .connect(f.maintainer)
        .submitMovedFundsSweepProof(
          sweep.archive.transaction,
          swept.proof,
          empty
        )
      expect((await f.bridge.movedFundsSweepRequests(incomingKey)).state).eq(2)
      expect(
        (await f.bridge.wallets(targetPkh)).pendingMovedFundsSweepRequestsCount
      ).eq(0)
      expect((await f.bridge.wallets(targetPkh)).mainUtxoHash).eq(
        ethers.utils.solidityKeccak256(
          ["bytes32", "uint32", "uint64"],
          [littleHash(sweep.archive.transaction.txidRPC), 0, 97000]
        )
      )
      const settled = await frame()
      await expect(
        f.bridge
          .connect(f.maintainer)
          .submitMovedFundsSweepProof(sweep.archive.transaction, swept.proof, {
            txHash: littleHash(sweep.archive.transaction.txidRPC),
            txOutputIndex: 0,
            txOutputValue: 97000,
          })
      ).to.be.revertedWith(
        "Moved funds sweep transaction must have a proper inputs count"
      )
      expect(await frame()).eq(settled)
      const closing = await f.bridge.wallets(f.witness.wallet.pubKeyHash)
      const closingParameters = await f.bridge.walletParameters()
      await ethers.provider.send("evm_setNextBlockTimestamp", [
        Number(closing.closingStartedAt) +
          Number(closingParameters.walletClosingPeriod) +
          1,
      ])
      await ethers.provider.send("evm_mine", [])
      await f.bridge.notifyWalletClosingPeriodElapsed(
        f.witness.wallet.pubKeyHash
      )
      expect((await f.bridge.wallets(f.witness.wallet.pubKeyHash)).state).eq(4)
      fs.writeFileSync(
        path.join(evidence, "upgrade-obligations.json"),
        JSON.stringify(
          {
            evidenceClass: "concrete testing",
            pending: [checkpoint],
            framePreserved: true,
            originalSlotsPreserved: true,
            movement: prepared.archive.transaction.txidRPC,
            sweep: sweep.archive.transaction.txidRPC,
            value: { source: 99000, incoming: 98000, swept: 97000 },
            limits: [
              "controlled legacy membership",
              "zero integer regtest relay difficulty",
              "known test scalars 3 and 4",
            ],
          },
          null,
          2
        )
      )
    })
  }
})

// Isolated production-library guard control. Its storage is deliberately seeded;
// it does not stand in for the public upgrade/Core replay cases above.
describe("K-09 consumed incoming request component guard", () => {
  it("consumes a pending request once and rejects it at the request-state guard", async () => {
    const fixture = await (
      await ethers.getContractFactory("FrostConsumedSweepFixture")
    ).deploy()
    expect(await fixture.callStatic.consume()).eq(1000)
    await fixture.consume()
    const terminal = await fixture.frame()
    expect(terminal[0]).eq(2)
    expect(terminal[1]).eq(0)
    await expect(fixture.consume()).to.be.revertedWith(
      "Sweep request must be in Pending state"
    )
    expect(await fixture.frame()).deep.eq(terminal)
  })
})
