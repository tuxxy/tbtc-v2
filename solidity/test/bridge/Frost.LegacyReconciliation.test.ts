/* eslint-disable no-restricted-syntax */
import { expect } from "chai"
import { utils } from "ethers"
import fs from "fs"
import path from "path"
import {
  legacyDepositScript,
  runLegacyCoreWitness,
  publicLegacyOriginFixture,
  legacyPaymentPhase,
} from "../helpers/frost-legacy-bitcoin"

// Piece 1: Bitcoin origin only. No seeded Ethereum wallet/Bank storage, but also
// no claim of registry admission, signed-request upgrade or completed D08/K05.
describe("D08 legacy reconciliation piece 1: actual Core deposit and sweep", () => {
  const depositor = `0x${"11".repeat(20)}`
  const evidence =
    process.env.FROST_C04_LEGACY_EVIDENCE ||
    "/private/tmp/c04-legacy-piece1-20261014/evidence"
  let witness: Awaited<ReturnType<typeof runLegacyCoreWitness>>
  before(async () => {
    witness = await runLegacyCoreWitness(evidence, { depositor })
  })

  function branchRoot(leaf: Buffer, proof: string, index: number) {
    const siblings = Buffer.from(proof.slice(2), "hex")
    expect(siblings.length % 32).eq(0)
    let root = leaf
    let position = index
    for (let offset = 0; offset < siblings.length; offset += 32) {
      const sibling = siblings.subarray(offset, offset + 32)
      const pair =
        position % 2
          ? Buffer.concat([sibling, root])
          : Buffer.concat([root, sibling])
      root = Buffer.from(utils.sha256(utils.sha256(pair)).slice(2), "hex")
      position = Math.floor(position / 2)
    }
    expect(position).eq(0)
    return root
  }

  it("spends the exact regular legacy P2WSH wallet branch into an unspent P2WPKH main output", () => {
    const profile = legacyDepositScript({
      depositor,
      refundLocktime: witness.refundTimestamp,
    })
    expect(witness.witnessScript).eq(utils.hexlify(profile.witnessScript))
    expect(witness.depositScript).eq(
      `0x0020${utils.sha256(profile.witnessScript).slice(2)}`
    )
    expect(witness.mainScript).eq(`0x0014${witness.wallet.pubKeyHash.slice(2)}`)
    expect(witness.wallet.pubKeyHash).eq(
      utils.ripemd160(utils.sha256(witness.wallet.compressedPublicKey))
    )
    expect(witness.wallet.ecdsaWalletId).eq(
      utils.keccak256(
        utils.hexConcat([witness.wallet.publicKeyX, witness.wallet.publicKeyY])
      )
    )
    expect(witness.reveal.walletPubKeyHash).eq(witness.wallet.pubKeyHash)
    expect(witness.reveal.blindingFactor).eq("0x0102030405060708")
    expect(witness.reveal.fundingOutputIndex).eq(witness.sweep.input.index)
    expect(witness.sweep.input.txid).eq(witness.funding.txid)
    expect(witness.sweep.input.value).eq(100000)
    expect(witness.sweep.value).eq(99000)
    expect(witness.sweep.fee).eq(1000)
    expect(witness.mainUTXO.txOutputValue).eq(99000)
    expect(witness.mainUTXO.txHash).eq(
      `0x${Buffer.from(witness.sweep.txid, "hex").reverse().toString("hex")}`
    )
    expect(witness.sweep.transaction.outputVector).eq(
      `0x01b88201000000000016${witness.mainScript.slice(2)}`
    )
    expect(witness.sweep.transaction.strippedHex).eq(witness.sweep.unsignedRaw)
    expect(witness.sweep.raw).not.eq(witness.sweep.unsignedRaw)
    expect(witness.sweep.mempool.allowed).eq(true)
    expect(witness.sweep.missingSignature.allowed).eq(false)
  })

  it("binds funding/sweep and coinbase inclusion to real Core headers and retained proofs", () => {
    for (const transaction of [witness.funding, witness.sweep]) {
      const txid = Buffer.from(
        utils
          .sha256(utils.sha256(`0x${transaction.transaction.strippedHex}`))
          .slice(2),
        "hex"
      )
      expect(Buffer.from(txid).reverse().toString("hex")).eq(transaction.txid)
      const { proof } = transaction
      const header = Buffer.from(proof.bitcoinHeaders.slice(2), "hex")
      expect(header.length).eq(80)
      expect(
        branchRoot(txid, proof.merkleProof, proof.txIndexInBlock).equals(
          header.subarray(36, 68)
        )
      ).eq(true)
      const coinbaseLeaf = Buffer.from(
        utils.sha256(proof.coinbasePreimage).slice(2),
        "hex"
      )
      expect(
        branchRoot(coinbaseLeaf, proof.coinbaseProof, 0).equals(
          header.subarray(36, 68)
        )
      ).eq(true)
      expect(proof.coreVerifiedTxids).includes(transaction.txid)
      expect(proof.coreVerifiedTxids.length).eq(2)
      expect(proof.coreMerkleBlock.length).greaterThan(2)
    }
    const processResult = JSON.parse(
      fs.readFileSync(path.join(evidence, "process-result.json"), "utf8")
    )
    expect(processResult.stopped).eq(true)
    expect(
      fs.existsSync(path.join(witness.dataDirectory, "regtest/bitcoind.pid"))
    ).eq(false)
    expect(witness.productionQualification).eq(false)
    expect(witness.wallet.knownScalar).eq(3)
    expect(witness.limits.outerSeconds).eq(180)
  })

  it("rejects unsupported depositor/amount/ScriptNum profiles before starting Core", () => {
    expect(() => legacyDepositScript({ depositor: "0x1234" })).throws(
      "20-byte depositor"
    )
    for (const amount of [0, 2999, 100000.5, 2100000000000001])
      expect(() =>
        legacyDepositScript({ depositor, depositAmount: amount })
      ).throws("safe deposit satoshi amount")
    for (const timestamp of [499999999, 2147483648, 500000000.5])
      expect(() =>
        legacyDepositScript({ depositor, refundLocktime: timestamp })
      ).throws("positive four-byte Unix ScriptNum")
  })
})

// Piece 2a is a populated PRE-upgrade precursor, never a fulfilled D08 manifest.
// Real Bank, legacy Watchtower and public callbacks/proofs; controlled registry
// and known Core key remain explicit limits. The next piece retains a released
// signed redemption across a real transparent-proxy implementation upgrade.
describe("D08 legacy reconciliation piece 2a: public pre-upgrade origin", () => {
  let f: Awaited<ReturnType<typeof publicLegacyOriginFixture>>
  const evidence =
    process.env.FROST_C04_LEGACY_PUBLIC_EVIDENCE ||
    "/private/tmp/c04-legacy-piece2-20261014/evidence"
  before(async () => {
    f = await publicLegacyOriginFixture(evidence)
  })

  it("publicly registers, reveals, proves Bank credit and escrows a pending request on pinned 76f7905", async () => {
    expect(f.baselineSourceHashes.length).greaterThan(0)
    expect(await f.admin.getProxyImplementation(f.bridge.address)).eq(
      f.implementation.address
    )
    expect(await f.bank.bridge()).eq(f.bridge.address)
    expect(await f.registry.walletOwner()).eq(f.bridge.address)
    expect(await f.registry.requests()).eq(1)
    expect(await f.registry.getWalletCreationState()).eq(0)
    const wallet = await f.bridge.wallets(f.witness.wallet.pubKeyHash)
    expect(wallet.ecdsaWalletID).eq(f.witness.wallet.ecdsaWalletId)
    expect(wallet.state).eq(1)
    expect(wallet.mainUtxoHash).eq(
      utils.solidityKeccak256(
        ["bytes32", "uint32", "uint64"],
        [f.witness.mainUTXO.txHash, 0, 99000]
      )
    )
    expect(wallet.pendingRedemptionsValue).eq(19800)
    const deposit = await f.bridge.deposits(f.depositKey)
    expect(deposit.depositor).eq(f.depositor.address)
    expect(deposit.amount).eq(100000)
    expect(deposit.treasuryFee).eq(1000)
    expect(deposit.revealedAt).greaterThan(0)
    expect(deposit.sweptAt).greaterThan(0)
    const pending = await f.bridge.pendingRedemptions(f.requestKey)
    expect(pending.redeemer).eq(f.depositor.address)
    expect(pending.requestedAmount).eq(20000)
    expect(pending.treasuryFee).eq(200)
    expect(pending.txMaxFee).eq(2000)
    expect(pending.requestedAt).greaterThan(0)
    expect((await f.bridge.timedOutRedemptions(f.requestKey)).requestedAt).eq(0)
    expect(await f.bank.balanceOf(f.depositor.address)).eq(78000)
    expect(await f.bank.balanceOf(f.bridge.address)).eq(20000)
    expect(await f.bank.balanceOf(f.treasury.address)).eq(1000)
    expect(await f.bank.allowance(f.depositor.address, f.bridge.address)).eq(0)
    // All Bank liabilities equal the actual 99000-sat unspent main custody.
    expect(
      (await f.bank.balanceOf(f.depositor.address))
        .add(await f.bank.balanceOf(f.bridge.address))
        .add(await f.bank.balanceOf(f.treasury.address))
    ).eq(99000)
    const parameters = await f.bridge.redemptionParameters()
    expect(parameters[4]).eq(f.baselineTimeout)
    expect(f.baselineTimeout).eq(5 * 86400)
    expect(f.deadline).eq(f.baselineTimeout.add(pending.requestedAt))
    expect(await f.bridge.getRedemptionWatchtower()).eq(f.watchtower.address)
    const veto = await f.watchtower.vetoProposals(f.requestKey)
    expect(veto.redeemer).eq(f.depositor.address)
    expect(veto.objectionsCount).eq(1)
    expect(veto.finalizedAt).eq(0)
    expect(veto.withdrawableAmount).eq(0)
    expect(await f.watchtower.isGuardian(f.guardian.address)).eq(true)
    expect(
      await f.watchtower.objections(
        utils.solidityKeccak256(
          ["uint256", "address"],
          [f.requestKey, f.guardian.address]
        )
      )
    ).eq(true)
    expect(f.watchtowerDelay).eq(8 * 3600)
    expect(f.watchtowerDelay.lt(f.baselineTimeout)).eq(true)
    const manifest = JSON.parse(
      fs.readFileSync(path.join(evidence, "public-legacy-origin.json"), "utf8")
    )
    expect(manifest.baselineRevision).eq("76f7905")
    expect(manifest.productionQualification).eq(false)
    expect(manifest.inventoryStatus).eq(
      "pending original payment; no signed redemption or fulfilled disposition yet"
    )
    expect(
      manifest.runtimeSizes.every(
        (item: { bytes: number }) => item.bytes <= 24576
      )
    ).eq(true)
  })

  it("rejects duplicate sweep credit without changing the populated legacy financial/policy frame", async () => {
    async function frame() {
      return JSON.stringify(
        await Promise.all([
          f.bridge.wallets(f.witness.wallet.pubKeyHash),
          f.bridge.deposits(f.depositKey),
          f.bridge.pendingRedemptions(f.requestKey),
          f.bridge.timedOutRedemptions(f.requestKey),
          f.bank.balanceOf(f.depositor.address),
          f.bank.balanceOf(f.bridge.address),
          f.bank.balanceOf(f.treasury.address),
          f.bank.allowance(f.depositor.address, f.bridge.address),
          f.bank.nonces(f.depositor.address),
          f.bridge.redemptionParameters(),
          f.bridge.getRedemptionWatchtower(),
          f.watchtower.vetoProposals(f.requestKey),
          f.watchtower.getRedemptionDelay(f.requestKey),
        ])
      )
    }
    const before = await frame()
    await expect(
      f.bridge
        .connect(f.maintainer)
        .submitDepositSweepProof(
          f.witness.sweep.transaction,
          f.witness.sweep.proof,
          f.witness.mainUTXO,
          "0x0000000000000000000000000000000000000000"
        )
    ).revertedWith("Deposit already swept")
    expect(await frame()).eq(before)
  })
})

// One controlled public-origin inventory entry, not a production census or K05.
describe("D08 legacy reconciliation piece 2b: signed payment across actual upgrade", () => {
  it("preserves original liabilities/policy, mines identical pre-upgrade bytes and fulfills exactly once", async () => {
    const { ethers } = await import("hardhat")
    const evidence = path.join(
      process.env.FROST_C04_LEGACY_PUBLIC_EVIDENCE ||
        "/private/tmp/c04-legacy-piece2-20261014/evidence",
      "piece2b"
    )
    const f = await publicLegacyOriginFixture(evidence)
    const oldRequest = await f.bridge.pendingRedemptions(f.requestKey)
    const spentKey = utils.solidityKeccak256(
      ["bytes32", "uint32"],
      [f.witness.mainUTXO.txHash, 0]
    )
    const objectionKey = utils.solidityKeccak256(
      ["uint256", "address"],
      [f.requestKey, f.guardian.address]
    )
    const watchtowerFields = [
      "bridge",
      "bank",
      "manager",
      "watchtowerEnabledAt",
      "watchtowerLifetime",
      "watchtowerDisabledAt",
      "vetoPenaltyFeeDivisor",
      "vetoFreezePeriod",
      "defaultDelay",
      "levelOneDelay",
      "levelTwoDelay",
      "waivedAmountLimit",
    ]
    async function frame() {
      return JSON.stringify(
        await Promise.all([
          f.bridge.wallets(f.witness.wallet.pubKeyHash),
          f.bridge.deposits(f.depositKey),
          f.bridge.pendingRedemptions(f.requestKey),
          f.bridge.timedOutRedemptions(f.requestKey),
          f.bridge.spentMainUTXOs(spentKey),
          f.bridge.redemptionParameters(),
          f.bridge.depositParameters(),
          f.bridge.movingFundsParameters(),
          f.bridge.getRedemptionWatchtower(),
          f.bank.bridge(),
          f.bank.balanceOf(f.depositor.address),
          f.bank.balanceOf(f.bridge.address),
          f.bank.balanceOf(f.treasury.address),
          f.bank.allowance(f.depositor.address, f.bridge.address),
          f.bank.nonces(f.depositor.address),
          f.watchtower.vetoProposals(f.requestKey),
          f.watchtower.objections(objectionKey),
          f.watchtower.isGuardian(f.guardian.address),
          ...watchtowerFields.map((name) => f.watchtower[name]()),
        ])
      )
    }
    // Baseline layout: governance/gap/initializer slots 0..50; self is 2496
    // bytes at slot 51, hence slots 51..128 inclusive. Mapped values above.
    async function oldSlots() {
      return Promise.all(
        Array.from({ length: 129 }, (_, index) =>
          ethers.provider.getStorageAt(f.bridge.address, index)
        )
      )
    }
    const before = await frame()
    const slots = await oldSlots()
    expect(await f.bridge.spentMainUTXOs(spentKey)).eq(false)
    const prepared = await legacyPaymentPhase(
      path.join(evidence, "payment"),
      f.witness,
      "prepare"
    )
    expect(prepared.archive.accepted.allowed).eq(true)
    expect(await frame()).eq(before)
    expect(await f.admin.getProxyImplementation(f.bridge.address)).eq(
      f.implementation.address
    )
    // A concrete local release-owner disposition reference, not a new gate.
    const disposition = utils.solidityKeccak256(
      ["string", "uint256", "address", "uint256", "bytes32", "uint256"],
      [
        "D08 local original-payment disposition",
        31337,
        f.bridge.address,
        f.requestKey,
        utils.keccak256(`0x${prepared.archive.raw}`),
        f.deadline,
      ]
    )
    const ownerSignature = await f.governance.signMessage(
      utils.arrayify(disposition)
    )
    expect(utils.verifyMessage(utils.arrayify(disposition), ownerSignature)).eq(
      f.governance.address
    )
    const upgraded = await f.deployCurrent()
    const upgradeReceipt = await (
      await f.admin.upgrade(f.bridge.address, upgraded.address)
    ).wait()
    expect(await f.admin.getProxyImplementation(f.bridge.address)).eq(
      upgraded.address
    )
    expect(await frame()).eq(before)
    expect(await oldSlots()).deep.eq(slots)
    // Honor the accrued real watchtower delay; do not change policy/timeouts.
    const matureAt =
      Number(oldRequest.requestedAt) + f.watchtowerDelay.toNumber()
    expect(matureAt).lessThan(f.deadline.toNumber())
    await ethers.provider.send("evm_setNextBlockTimestamp", [matureAt])
    await ethers.provider.send("evm_mine", [])
    const mined = await legacyPaymentPhase(
      path.join(evidence, "payment"),
      f.witness,
      "mine",
      prepared.archive
    )
    expect(mined.archive.raw).eq(prepared.archive.raw)
    expect(mined.proof).not.eq(undefined)
    const settlement = await (
      await f.bridge
        .connect(f.maintainer)
        .submitRedemptionProof(
          prepared.archive.transaction,
          mined.proof,
          f.witness.mainUTXO,
          f.witness.wallet.pubKeyHash
        )
    ).wait()
    expect((await f.bridge.pendingRedemptions(f.requestKey)).requestedAt).eq(0)
    expect((await f.bridge.timedOutRedemptions(f.requestKey)).requestedAt).eq(0)
    const wallet = await f.bridge.wallets(f.witness.wallet.pubKeyHash)
    expect(wallet.pendingRedemptionsValue).eq(0)
    const paymentHash = `0x${Buffer.from(
      prepared.archive.transaction.txidRPC,
      "hex"
    )
      .reverse()
      .toString("hex")}`
    expect(wallet.mainUtxoHash).eq(
      utils.solidityKeccak256(
        ["bytes32", "uint32", "uint64"],
        [paymentHash, 1, 79200]
      )
    )
    expect(wallet.ecdsaWalletID).eq(f.witness.wallet.ecdsaWalletId)
    expect(wallet.state).eq(1)
    expect(await f.bridge.spentMainUTXOs(spentKey)).eq(true)
    expect(await f.bank.balanceOf(f.depositor.address)).eq(78000)
    expect(await f.bank.balanceOf(f.bridge.address)).eq(0)
    expect(await f.bank.balanceOf(f.treasury.address)).eq(1200)
    expect(
      (await f.bank.balanceOf(f.depositor.address))
        .add(await f.bank.balanceOf(f.bridge.address))
        .add(await f.bank.balanceOf(f.treasury.address))
    ).eq(79200)
    expect(99000 - 18800 - 1000).eq(79200)
    expect((await f.bridge.redemptionParameters())[4]).eq(f.baselineTimeout)
    expect(await f.bridge.getRedemptionWatchtower()).eq(f.watchtower.address)
    expect(await f.watchtower.objections(objectionKey)).eq(true)
    expect((await f.watchtower.vetoProposals(f.requestKey)).objectionsCount).eq(
      1
    )
    const fulfilledFrame = await frame()
    const fulfilledSlots = await oldSlots()
    await expect(
      f.bridge
        .connect(f.maintainer)
        .submitRedemptionProof(
          prepared.archive.transaction,
          mined.proof,
          f.witness.mainUTXO,
          f.witness.wallet.pubKeyHash
        )
    ).reverted
    expect(await frame()).eq(fulfilledFrame)
    expect(await oldSlots()).deep.eq(fulfilledSlots)
    const manifest = {
      scope:
        "One controlled public legacy inventory entry; known key/controlled registry/zero integer regtest relay difficulty. No production census, threshold signing or K05 qualification.",
      productionQualification: false,
      inventoryStatus: "fulfilled original payment",
      baselineRevision: "76f7905",
      upgradedRuntimeRevision: f.currentRevision,
      requestKey: f.requestKey,
      originalRequest: oldRequest,
      originalTimeout: f.baselineTimeout.toString(),
      accruedDeadline: f.deadline.toString(),
      realWatchtower: f.watchtower.address,
      capturedWatchtowerDelay: f.watchtowerDelay.toString(),
      disposition: {
        digest: disposition,
        owner: f.governance.address,
        signature: ownerSignature,
      },
      bridge: f.bridge.address,
      bank: f.bank.address,
      oldImplementation: f.implementation.address,
      newImplementation: upgraded.address,
      upgradeEthereumBlock: upgradeReceipt.blockNumber,
      settlementEthereumBlock: settlement.blockNumber,
      signedBeforeUpgrade: prepared.archive,
      minedAfterUpgrade: { blockHash: mined.blockHash, proof: mined.proof },
      equations: {
        initialCustody: 99000,
        requestGross: 20000,
        requestTreasuryFee: 200,
        bankBurn: 19800,
        recipient: 18800,
        bitcoinFee: 1000,
        finalCustodyAndBankLiabilities: 79200,
      },
      oldSlotsCompared: 129,
      replayRejectedWithFullFrameRollback: true,
      activationGate:
        "none added; this manifest is a local release-owner disposition reference",
    }
    fs.writeFileSync(
      path.join(evidence, "fulfilled-legacy-inventory.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    )
  })
})
