import { artifacts, ethers } from "hardhat"
import { expect } from "chai"
import { Contract } from "ethers"
import {
  evidenceDirectory as isolatedEvidence,
  prepareEvidenceDirectory,
} from "./frost-test-isolation"
import {
  publicFundedFixture,
  bitcoinInfo,
  bitcoinProof,
  rawTxHash,
  outpointKey,
} from "./frost-public-funding"
import runCoreWitnessCheck from "./frost-bitcoin"

// New helper only; existing public origin/Core helpers are read-only dependencies.
// Known scalar 3, controlled readiness and zero-difficulty regtest relay remain
// explicit limits. No injected Bridge/custody/Bank storage or issuance helper.
type PublicVaultFixture = Awaited<ReturnType<typeof publicFundedFixture>> & {
  vault: Contract
  vaultSweep: {
    walletId: string
    transaction: ReturnType<typeof bitcoinInfo>
    proof: ReturnType<typeof bitcoinProof>
    includeMain: boolean
    vault: string
  }
  vaultWitness: Awaited<ReturnType<typeof runCoreWitnessCheck>>
  depositKey: string
  sweepKey: string
}
export async function publicVaultCallbackFixture(
  evidenceDirectory: string = isolatedEvidence(
    "vault-callback",
    process.env.FROST_C04_CALLBACK_EVIDENCE
  )
): Promise<PublicVaultFixture> {
  prepareEvidenceDirectory(evidenceDirectory)
  const f = await publicFundedFixture({
    evidenceDirectory: `${evidenceDirectory}/origin`,
  })
  const vault = await (
    await ethers.getContractFactory("FrostVaultCallbackFixture")
  ).deploy(f.bank.address, f.frost.address)
  await vault.deployed()
  await f.bridge.setVaultStatus(vault.address, true)
  const now = (await ethers.provider.getBlock("latest")).timestamp
  const witness = await runCoreWitnessCheck(
    `${evidenceDirectory}/vault-core`,
    process.env.FROST_C04_DIGEST_BINARY,
    {
      chainId: (await ethers.provider.getNetwork()).chainId.toString(),
      bridge: f.frost.address,
      depositor: f.depositor.address,
      vault: vault.address,
      descriptorHash: f.descriptorHash,
      refundLocktime: Math.max(now, Math.floor(Date.now() / 1000)) + 1800,
    }
  )
  expect(witness.terms.bitcoinGenesis).eq(f.genesis)
  expect(witness.terms.fullWalletId).eq(f.walletId)
  const depositKey = outpointKey(
    rawTxHash(witness.funding[0].txid),
    witness.sweep.input.index
  )
  await f.frost
    .connect(f.depositor)
    .revealFrostDeposit(
      witness.terms,
      bitcoinInfo(witness.funding[0].transaction),
      witness.sweep.input.index
    )
  const vaultSweep = {
    walletId: f.walletId,
    transaction: bitcoinInfo(witness.sweep.transaction),
    proof: bitcoinProof(witness.sweep.proof),
    includeMain: false,
    vault: vault.address,
  }
  const sweepKey = outpointKey(rawTxHash(witness.sweep.txid), 0)
  return {
    ...f,
    vault,
    vaultSweep,
    vaultWitness: witness,
    depositKey,
    sweepKey,
  }
}

/// Read actual storage slots using compiler layout; never inject state. Public
/// deposit/custody/ledger getters supply the corresponding dynamic records.
export async function fundingStorageFrame(
  bridge: string,
  walletId: string,
  outpoints: string[]
): Promise<string[]> {
  const info = await artifacts.getBuildInfo(
    "contracts/bridge/Bridge.sol:Bridge"
  )
  if (!info) throw Error("Bridge build information missing")
  const layout = (
    info.output.contracts["contracts/bridge/Bridge.sol"].Bridge as unknown as {
      storageLayout: {
        storage: { label: string; slot: string; type: string }[]
        types: Record<
          string,
          {
            numberOfBytes: string
            members: { label: string; slot: string; type: string }[]
          }
        >
      }
    }
  ).storageLayout
  function findField<T extends { label: string }>(
    fields: T[],
    label: string
  ): T {
    const field = fields.find((entry) => entry.label === label)
    if (!field) throw Error(`Storage field ${label} missing`)
    return field
  }
  const root = findField(layout.storage, "self")
  const { members } = layout.types[root.type]
  const funding = findField(members, "frostFunding")
  const base = ethers.BigNumber.from(root.slot).add(funding.slot)
  const fundingType = layout.types[funding.type]
  const pending = findField(fundingType.members, "pendingReveals")
  const spent = findField(members, "spentMainUTXOs")
  const slots = Array.from(
    { length: Number(fundingType.numberOfBytes) / 32 },
    (_, i) => base.add(i).toHexString()
  )
  slots.push(
    ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", "uint256"],
        [walletId, base.add(pending.slot)]
      )
    )
  )
  const redemptions = findField(members, "frostRedemptions")
  const ledger = findField(layout.types[redemptions.type].members, "ledger")
  const nonce = findField(layout.types[ledger.type].members, "requestNonce")
  slots.push(
    ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", "uint256"],
        [
          walletId,
          ethers.BigNumber.from(root.slot)
            .add(redemptions.slot)
            .add(ledger.slot)
            .add(nonce.slot),
        ]
      )
    )
  )
  outpoints.forEach((outpoint) =>
    slots.push(
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ["bytes32", "uint256"],
          [outpoint, ethers.BigNumber.from(root.slot).add(spent.slot)]
        )
      )
    )
  )
  return Promise.all(
    slots.map((slot) => ethers.provider.getStorageAt(bridge, slot))
  )
}
