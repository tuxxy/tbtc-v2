/* eslint-disable no-await-in-loop, no-restricted-syntax */
// ADV probe (adversarial review 2026-11-04): a legacy drain that is
// committed but never signed (the legacy group cannot reach threshold, the
// usual reason a wallet times out) leaves each FROST target's inbound
// obligation open forever. A target that later must move funds can then
// never commit, is escalated (sanction) by its own moving-funds timeout, and
// cannot reset the clock while other targets are eligible.
// Real: Bridge, legacy commitment/timeout, FROST lifecycle entrypoints.
// FIXTURE: movementWorld (FrostRegistryFixture wallets), controlled legacy
// main and MovingFunds markers, synthetic regtest inclusion proofs.
import { ethers, network } from "hardhat"
import { expect } from "chai"
import {
  movementWorld,
  ascending,
  State,
  World,
} from "../helpers/frost-movement-world"

describe("ADV probe: a never-signed drain strands its FROST targets", () => {
  let w: World
  const members = [1, 2, 3]
  const advance = async (seconds: number) => {
    await network.provider.send("evm_increaseTime", [seconds])
    await network.provider.send("evm_mine")
  }
  const legacyNode = (pkh: string) =>
    w.entry(w.child(w.self, "registeredWallets"), pkh, "bytes20")

  before(async () => {
    w = await movementWorld(4)
    await w.legacyRegistry.setMember(w.operator.address)
  })

  it("target T cannot commit its own movement and is escalated", async () => {
    const lifecycle = await ethers.getContractAt(
      "IFrostLifecycleBridge",
      w.proxy.address
    )
    const [t0, t1, t2, t3] = ascending(w.wallets)
    // T is t0; it holds custody before it is chosen as a drain target.
    await w.fund(t0, 300000)

    // Legacy source S in MovingFunds with a 400,000-sat main.
    const pub = ethers.utils.computePublicKey(
      ethers.utils.hexZeroPad("0x2a2a", 32)
    )
    const pkh = ethers.utils.ripemd160(
      ethers.utils.sha256(ethers.utils.computePublicKey(pub, true))
    )
    await w.legacyRegistry.publish(
      ethers.utils.id("adv legacy"),
      `0x${pub.slice(4, 68)}`,
      `0x${pub.slice(68)}`
    )
    const main = {
      txHash: ethers.utils.id("adv legacy main"),
      txOutputIndex: 0,
      txOutputValue: 400000,
    }
    await w.writeField(
      w.child(legacyNode(pkh), "mainUtxoHash"),
      ethers.utils.solidityKeccak256(
        ["bytes32", "uint32", "uint64"],
        [main.txHash, 0, 400000]
      )
    )
    const live = w.child(w.self, "liveWalletsCount")
    await w.writeField(live, (await w.readField(live)) - 1)
    await w.writeField(w.child(legacyNode(pkh), "state"), 2)
    await w.writeField(
      w.child(legacyNode(pkh), "movingFundsRequestedAt"),
      await w.now()
    )

    // One legacy member commits the drain; the group never signs it.
    await w.frost.setFrostDrainEnabled(true)
    await w.bridge
      .connect(w.operator)
      .submitMovingFundsCommitment(pkh, main, members, 0, [t0.label, t1.label])
    await advance(7 * 86400 + 1)
    await w.bridge.notifyMovingFundsTimeout(pkh, members)
    expect(await w.readField(w.child(legacyNode(pkh), "state"))).to.equal(5)

    // Much later T must move funds (age) through the real lifecycle entry.
    const p = await w.bridge.walletParameters()
    await w.bridge.updateWalletParameters(
      p.walletCreationPeriod,
      p.walletCreationMinBtcBalance,
      p.walletCreationMaxBtcBalance,
      p.walletClosureMinBtcBalance,
      1,
      p.walletMaxBtcTransfer,
      p.walletClosingPeriod
    )
    await lifecycle.notifyFrostWalletCloseable(t0.id)
    expect(await w.state(t0)).to.equal(State.MovingFunds)
    expect(
      (await w.frost.frostMovementCounters(t0.id)).inboundCommitments
    ).to.equal(1)

    // 299,000 sats at 250,000 max transfer: two targets of the eligible ones.
    await expect(
      w.frost
        .connect(w.operator)
        .submitFrostMovingFundsCommitment(t0.id, 0, [t2.label, t3.label])
    ).to.be.revertedWith("FROST movement obligations")
    await expect(
      w.frost.resetFrostMovingFundsTimeout(t0.id)
    ).to.be.revertedWith("FROST movement reset state")
    await advance(7 * 86400 + 1)
    await expect(w.frost.notifyFrostMovingFundsTimeout(t0.id)).to.emit(
      w.frost,
      "FrostMovingFundsEscalated"
    )
    // No Bitcoin evidence exists for a transaction that was never signed,
    // so the conflict release cannot be used either.
    expect(await w.frost.frostDrainTargets(pkh)).to.deep.equal([
      t0.label,
      t1.label,
    ])
  })
})
