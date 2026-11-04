/* eslint-disable no-await-in-loop, no-restricted-syntax, no-console */
// ADV probe (adversarial review 2026-11-04): an ECDSA-to-FROST drain
// commitment the Bridge accepts must have a movement proof that fits the
// 2^24 transaction gas cap. Measures commitment and proof gas by target
// count through the public Bridge entrypoints.
// FIXTURE: movementWorld (FrostRegistryFixture wallets, controlled legacy
// main and MovingFunds markers), synthetic regtest inclusion proofs.
import { ethers, network } from "hardhat"
import {
  movementWorld,
  transaction,
  inclusion,
  p2tr,
  ascending,
  split,
  World,
} from "../helpers/frost-movement-world"

const GAS_CAP = 16777216
const FEE = 3000

describe("ADV probe: legacy drain proof gas by target count", () => {
  let w: World
  let created = 0
  const LegacyState = { Live: 1, MovingFunds: 2 }
  const members = [1, 2, 3]

  const legacyNode = (pkh: string) =>
    w.entry(w.child(w.self, "registeredWallets"), pkh, "bytes20")

  const legacySource = async (value: number) => {
    created += 1
    const pub = ethers.utils.computePublicKey(
      ethers.utils.hexZeroPad(ethers.utils.hexlify(7000 + created), 32)
    )
    const compressed = ethers.utils.computePublicKey(pub, true)
    const pkh = ethers.utils.ripemd160(ethers.utils.sha256(compressed))
    await w.legacyRegistry.publish(
      ethers.utils.id(`adv legacy ${created}`),
      `0x${pub.slice(4, 68)}`,
      `0x${pub.slice(68)}`
    )
    const main = {
      txHash: ethers.utils.id(`adv legacy main ${pkh}`),
      txOutputIndex: 0,
      txOutputValue: value,
    }
    await w.writeField(
      w.child(legacyNode(pkh), "mainUtxoHash"),
      ethers.utils.solidityKeccak256(
        ["bytes32", "uint32", "uint64"],
        [main.txHash, main.txOutputIndex, main.txOutputValue]
      )
    )
    const live = w.child(w.self, "liveWalletsCount")
    await w.writeField(live, (await w.readField(live)) - 1)
    await w.writeField(
      w.child(legacyNode(pkh), "state"),
      LegacyState.MovingFunds
    )
    await w.writeField(
      w.child(legacyNode(pkh), "movingFundsRequestedAt"),
      await w.now()
    )
    return { pkh, main }
  }

  const setMaxTransfer = async (max: number) => {
    const p = await w.bridge.walletParameters()
    await w.bridge.updateWalletParameters(
      p.walletCreationPeriod,
      p.walletCreationMinBtcBalance,
      p.walletCreationMaxBtcBalance,
      p.walletClosureMinBtcBalance,
      p.walletMaxAge,
      max,
      p.walletClosingPeriod
    )
  }

  before(async () => {
    w = await movementWorld(Number(process.env.ADV_WALLETS ?? 200))
    await w.legacyRegistry.setMember(w.operator.address)
    await w.frost.setFrostDrainEnabled(true)
  })

  const counts = (process.env.ADV_COUNTS ?? "60,80,100,120,140,160,200")
    .split(",")
    .map(Number)
  for (const k of counts) {
    it(`drain with ${k} targets`, async () => {
      const snapshot = await network.provider.send("evm_snapshot")
      const value = k * 100000 + FEE
      await setMaxTransfer(Math.ceil(value / k))
      const { pkh, main } = await legacySource(value)
      const targets = ascending(w.wallets).slice(0, k)
      const labels = targets.map((t) => t.label)
      const commitGas = await w.bridge
        .connect(w.operator)
        .estimateGas.submitMovingFundsCommitment(
          pkh,
          main,
          members,
          0,
          labels,
          { gasLimit: 29000000 }
        )
      await (
        await w.bridge
          .connect(w.operator)
          .submitMovingFundsCommitment(pkh, main, members, 0, labels, {
            gasLimit: 29000000,
          })
      ).wait()
      const values = split(value - FEE, k)
      const tx = transaction(
        [[main.txHash, 0]],
        targets.map((t, i) => ({ value: values[i], script: p2tr(t.q) }))
      )
      const proveGas = await w.bridge.estimateGas.submitMovingFundsProof(
        tx.tx,
        inclusion(tx.hash),
        main,
        pkh,
        { gasLimit: 29000000 }
      )
      console.log(
        `ADV k=${k} commit=${commitGas.toString()} prove=${proveGas.toString()} commitFits=${commitGas.lte(
          GAS_CAP
        )} proveFits=${proveGas.lte(GAS_CAP)}`
      )
      await network.provider.send("evm_revert", [snapshot])
    })
  }
})
