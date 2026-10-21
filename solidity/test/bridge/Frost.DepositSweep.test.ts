/* eslint-disable no-await-in-loop, no-restricted-syntax */
// Component integration only. Registry/config roots are controlled, while every
// deposit, custody output and Bank credit must arise from the actual entry calls.
import { artifacts, ethers, network } from "hardhat"
import { expect } from "chai"
import fs from "fs"
import path from "path"
import * as secp from "@noble/secp256k1"
import runCoreWitnessCheck from "../helpers/frost-bitcoin"

const EVIDENCE =
  process.env.FROST_C05_COMPONENT_EVIDENCE ||
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require, import/newline-after-import
  require("../helpers/frost-test-isolation").evidenceDirectory("deposit-sweep")
const DIGEST = process.env.FROST_C05_DIGEST_BINARY
const TYPE =
  "tuple(uint8 scheme,uint8 profile,uint256 chainId,address registry,uint64 epoch,uint32[] members,address[] operators,uint16 threshold,bytes32 snowfallDescriptor,bytes32 outputKey)"

async function deploy(
  name: string,
  args: unknown[] = [],
  cache = new Map<string, string>()
): Promise<any> {
  const artifact = await artifacts.readArtifact(name)
  expect((artifact.deployedBytecode.length - 2) / 2, name).to.be.at.most(24576)
  let { bytecode } = artifact
  for (const [source, libraries] of Object.entries(artifact.linkReferences)) {
    for (const [library, positions] of Object.entries(libraries)) {
      const key = `${source}:${library}`
      if (!cache.has(key))
        cache.set(key, (await deploy(key, [], cache)).address)
      const address = cache.get(key)
      if (!address) throw Error(`Missing linked library ${key}`)
      for (const position of positions)
        bytecode =
          bytecode.slice(0, 2 + position.start * 2) +
          address.slice(2) +
          bytecode.slice(2 + (position.start + position.length) * 2)
    }
  }
  const [signer] = await ethers.getSigners()
  const c = await new ethers.ContractFactory(
    artifact.abi,
    bytecode,
    signer
  ).deploy(...args)
  await c.deployed()
  expect(
    (await ethers.provider.getCode(c.address)).length / 2 - 1
  ).to.be.at.most(24576)
  return c
}
const info = (material: any) => ({
  version: material.version,
  inputVector: material.inputVector,
  outputVector: material.outputVector,
  locktime: material.locktime,
})
const proof = (material: any) => ({
  merkleProof: material.merkleProof,
  txIndexInBlock: material.txIndexInBlock,
  bitcoinHeaders: material.bitcoinHeaders,
  coinbasePreimage: material.coinbasePreimage,
  coinbaseProof: material.coinbaseProof,
})
const rawHash = (txid: string) =>
  `0x${Buffer.from(txid, "hex").reverse().toString("hex")}`
const key = (txid: string, index: number) =>
  ethers.utils.solidityKeccak256(["bytes32", "uint32"], [rawHash(txid), index])
const normalized = (value: unknown) => JSON.parse(JSON.stringify(value))

describe("C-05 reveal/Core wallet-leaf sweep/real Bank component", () => {
  let fixture: any
  let bank: any
  let depositor: any
  let treasury: any
  let other: any
  let data: any
  let descriptor: any
  let depositKey: string
  let sweptKey: string
  let sweep: any
  let snapshot: string

  before(async () => {
    const [owner, payer, feeRecipient, stranger] = await ethers.getSigners()
    depositor = payer
    treasury = feeRecipient
    other = stranger
    const verifier = await deploy("FrostVerifier") // Actual current C-07 implementation, not a test validator.
    fixture = await deploy("FrostDepositSweepFixture", [treasury.address])
    bank = await ethers.getContractAt("Bank", await fixture.bank())
    const q = `0x${Buffer.from(
      secp.schnorr.getPublicKey("3".padStart(64, "0"))
    ).toString("hex")}`
    const { chainId } = await ethers.provider.getNetwork()
    descriptor = {
      scheme: 2,
      profile: 1,
      chainId,
      registry: owner.address,
      epoch: await ethers.provider.getBlockNumber(),
      members: [1, 2, 3],
      operators: [owner.address, depositor.address, treasury.address],
      threshold: 2,
      snowfallDescriptor: ethers.utils.id(
        "controlled component descriptor root"
      ),
      outputKey: q,
    }
    const descriptorHash = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", TYPE],
        [ethers.utils.id("tbtc-v2/frost-descriptor/v1"), descriptor]
      )
    )
    const latest = await ethers.provider.getBlock("latest")
    // Core invokes no Ethereum setters and has its own 180-second lifetime cap.
    data = await runCoreWitnessCheck(path.join(EVIDENCE, "core"), DIGEST, {
      chainId: String(chainId),
      bridge: fixture.address,
      depositor: depositor.address,
      vault: ethers.constants.AddressZero,
      descriptorHash,
      refundLocktime:
        Math.max(latest.timestamp, Math.floor(Date.now() / 1000)) + 1800,
    })
    expect(data.walletKey).to.equal(q)
    await fixture.seedWallet(descriptor)
    await fixture.configure(verifier.address, data.terms.bitcoinGenesis)
    depositKey = key(data.sweep.input.txid, data.sweep.input.index)
    sweptKey = key(data.sweep.txid, 0)
    sweep = {
      walletId: data.terms.fullWalletId,
      transaction: info(data.sweep.transaction),
      proof: proof(data.sweep.proof),
      includeMain: false,
      vault: ethers.constants.AddressZero,
    }
    expect(await bank.owner()).to.equal(fixture.address)
    expect(await bank.bridge()).to.equal(fixture.address)
    snapshot = await network.provider.send("evm_snapshot")
  })

  beforeEach(async () => {
    expect(await network.provider.send("evm_revert", [snapshot])).to.equal(true)
    snapshot = await network.provider.send("evm_snapshot")
  })

  const frame = async (extraKeys: string[] = []) =>
    normalized({
      deposit: await fixture.deposit(depositKey),
      pending: await fixture.pending(data.terms.fullWalletId),
      wallet: await fixture.wallet(data.terms.fullWalletId),
      output: await fixture.custodyOutput(sweptKey),
      fundingSpent: await fixture.spent(depositKey),
      outputSpent: await fixture.spent(sweptKey),
      entered: await fixture.entered(),
      walletState: await fixture.walletState(data.terms.fullWalletId),
      configuration: await fixture.configuration(),
      balances: await Promise.all(
        [
          depositor.address,
          treasury.address,
          fixture.address,
          bank.address,
          other.address,
        ].map(async (address) => (await bank.balanceOf(address)).toString())
      ),
      allowances: await Promise.all(
        [
          depositor.address,
          treasury.address,
          fixture.address,
          other.address,
        ].map(async (address) =>
          (await bank.allowance(address, fixture.address)).toString()
        )
      ),
      nonces: await Promise.all(
        [
          depositor.address,
          treasury.address,
          fixture.address,
          other.address,
        ].map(async (address) => (await bank.nonces(address)).toString())
      ),
      bankBridge: await bank.bridge(),
      bankOwner: await bank.owner(),
      extraOutputs: await Promise.all(
        extraKeys.map(async (outpoint) => ({
          key: outpoint,
          deposit: await fixture.deposit(outpoint),
          custody: await fixture.custodyOutput(outpoint),
          spent: await fixture.spent(outpoint),
        }))
      ),
    })
  const reveal = async () =>
    fixture
      .connect(depositor)
      .reveal(
        data.terms,
        info(data.funding[0].transaction),
        data.sweep.input.index
      )
  const credits = async () => {
    expect(await bank.balanceOf(depositor.address)).to.equal(98000)
    expect(await bank.balanceOf(treasury.address)).to.equal(1000)
    expect(await bank.balanceOf(fixture.address)).to.equal(0)
    expect(await bank.balanceOf(bank.address)).to.equal(0)
    expect((await fixture.wallet(data.terms.fullWalletId)).value).to.equal(
      99000
    )
    expect((await fixture.custodyOutput(sweptKey)).value).to.equal(99000)
    expect((await fixture.custodyOutput(sweptKey)).walletId).to.equal(
      data.terms.fullWalletId
    )
    expect(await fixture.pending(data.terms.fullWalletId)).to.equal(0)
    expect(await fixture.spent(depositKey)).to.equal(true)
    expect((await fixture.deposit(depositKey)).sweptAt).not.to.equal(0)
    expect(await fixture.walletState(data.terms.fullWalletId)).to.equal(4)
    expect(await fixture.entered()).to.equal(false)
  }

  it("creates no custody/Bank credit on reveal, then credits only after actual Core sweep SPV", async () => {
    expect((await fixture.wallet(data.terms.fullWalletId)).value).to.equal(0)
    expect((await fixture.deposit(depositKey)).revealedAt).to.equal(0)
    expect(await bank.balanceOf(depositor.address)).to.equal(0)
    const expected = await fixture.output(data.terms)
    expect(expected.key).to.equal(data.depositKey)
    expect(expected.root).to.equal(data.profile.root)
    expect(expected.parity).to.equal(data.parity)
    await reveal()
    expect((await fixture.deposit(depositKey)).treasuryFee).to.equal(1000)
    expect((await fixture.deposit(depositKey)).maximumSweepFee).to.equal(2000)
    expect(await fixture.pending(data.terms.fullWalletId)).to.equal(1)
    expect((await fixture.wallet(data.terms.fullWalletId)).value).to.equal(0)
    expect(await bank.balanceOf(depositor.address)).to.equal(0)
    await fixture.prove(sweep)
    await credits()
    fs.writeFileSync(
      path.join(EVIDENCE, "accounting-result.json"),
      JSON.stringify(
        {
          scope:
            "Component only: controlled metadata, actual Core proofs, actual verifier and Bank",
          amount: 100000,
          bitcoinFee: 1000,
          treasury: 1000,
          depositor: 98000,
          recognizedCustody: 99000,
          productionQualification: false,
        },
        null,
        2
      )
    )
  })

  it("refuses credit for an independently refunded deposit and Core rejects its pre-signed late wallet spend", async () => {
    const conflict = data.refund.walletConflict
    expect(conflict.sourceFundingIndex).eq(1)
    expect(conflict.sourceFundingTransaction).eq(data.funding[1].txid)
    expect(conflict.input.txid).eq(data.refund.input.txid)
    expect(conflict.input.index).eq(data.refund.input.index)
    expect(conflict.walletLeaf).eq(data.profile.walletLeaf)
    expect(conflict.walletSigningEnabledAtPresign).eq(true)
    expect(conflict.earlyAdmission.allowed).eq(true)
    expect(conflict.postRefundRefusal.allowed).eq(false)
    expect(conflict.postRefundRefusal["reject-reason"]).eq("missing-inputs")
    expect(conflict.postRefundRefusal.txid).eq(conflict.earlyAdmission.txid)
    expect(conflict.walletSigningCallbackDisabled).eq(true)
    expect(conflict.walletOperatorSigningCallsDuringRefund).eq(0)
    expect(data.refund.walletSigningCallbackDisabled).eq(true)
    expect(data.refund.walletOperatorSigningCalls).eq(0)

    // Reveal metadata for the actual second funding output, which Core has
    // already spent through the independent depositor refund leaf.
    const refundedKey = key(data.refund.input.txid, data.refund.input.index)
    const refundOutput = key(data.refund.txid, 0)
    const lateWalletOutput = key(conflict.earlyAdmission.txid, 0)
    await fixture
      .connect(depositor)
      .reveal(
        data.terms,
        info(data.funding[1].transaction),
        data.refund.input.index
      )
    expect((await fixture.deposit(refundedKey)).revealedAt).not.eq(0)
    expect((await fixture.deposit(refundedKey)).sweptAt).eq(0)
    expect(await fixture.pending(data.terms.fullWalletId)).eq(1)
    const tracked = [refundedKey, refundOutput, lateWalletOutput]
    const before = await frame(tracked)
    // This is the REAL mined refund transaction and its actual Core inclusion
    // proof, not fabricated inclusion for the unmined wallet alternative.
    await expect(
      fixture.prove({
        ...sweep,
        transaction: info(data.refund.transaction),
        proof: proof(data.refund.proof),
      })
    ).revertedWith("FROST sweep output count")
    expect(await frame(tracked)).deep.eq(before)
    expect((await fixture.wallet(data.terms.fullWalletId)).value).eq(0)
    expect(await bank.balanceOf(depositor.address)).eq(0)
    expect(await bank.balanceOf(treasury.address)).eq(0)
    expect((await fixture.custodyOutput(refundOutput)).walletId).eq(
      ethers.constants.HashZero
    )
    expect((await fixture.custodyOutput(lateWalletOutput)).walletId).eq(
      ethers.constants.HashZero
    )
    // Pending reveal metadata is deliberately retained: removing refunded
    // obligations is a separate lifecycle/cleanup task, outside this witness.
  })

  it("refuses replay of a valid sweep proof without double credit or state changes", async () => {
    await reveal()
    await fixture.prove(sweep)
    const before = await frame()
    await expect(fixture.prove(sweep)).to.be.revertedWith(
      "FROST sweep main required"
    )
    expect(await frame()).to.deep.equal(before)
  })

  it("refuses an actual valid proof bound to a different wallet output key", async () => {
    await reveal()
    const different = { ...descriptor, outputKey: data.terms.refundKey }
    await fixture.seedWallet(different)
    const wrongId = ethers.utils.keccak256(
      ethers.utils.concat([
        ethers.utils.id("tbtc-v2/frost-wallet-id/v1"),
        different.outputKey,
      ])
    )
    const before = await frame()
    const wrongWallet = normalized(await fixture.wallet(wrongId))
    await expect(
      fixture.prove({ ...sweep, walletId: wrongId })
    ).to.be.revertedWith("FROST sweep output key")
    expect(await frame()).to.deep.equal(before)
    expect(normalized(await fixture.wallet(wrongId))).to.deep.equal(wrongWallet)
  })

  it("completes a revealed obligation with a valid proof while address/reveal gates are paused", async () => {
    await reveal()
    await fixture.setGates(false, false)
    await expect(fixture.output(data.terms)).to.be.revertedWith(
      "FROST addresses disabled"
    )
    await expect(reveal()).to.be.revertedWith("FROST reveal disabled")
    await fixture.prove(sweep)
    await credits()
  })

  it("rolls back the full frame on a corrupted Merkle proof without a mocked validator", async () => {
    await reveal()
    const before = await frame()
    const altered = {
      ...sweep,
      proof: {
        ...sweep.proof,
        merkleProof: `0x${"00".repeat(
          (sweep.proof.merkleProof.length - 2) / 2
        )}`,
      },
    }
    await expect(fixture.prove(altered)).to.be.revertedWith(
      "Tx merkle proof is not valid for provided header and tx hash"
    )
    expect(await frame()).to.deep.equal(before)
  })

  it("rolls back deposit/custody/Bank credit after the late treasury Bank call fails, then retries", async () => {
    await reveal()
    await fixture.setTreasuryForTest(bank.address) // Configuration fault only: no balance or custody seed.
    const before = await frame()
    await expect(fixture.prove(sweep)).to.be.revertedWith(
      "Can not increase balance for Bank"
    )
    expect(await frame()).to.deep.equal(before)
    await fixture.setTreasuryForTest(treasury.address)
    await fixture.prove(sweep)
    await credits()
  })

  it("does not permit Terms overrides to replace derived genesis/full wallet identity/refund keys", async () => {
    for (const field of [
      "bitcoinGenesis",
      "fullWalletId",
      "refundKey",
      "amount",
    ]) {
      let error: unknown
      try {
        await runCoreWitnessCheck(EVIDENCE, DIGEST, {
          [field]: "forged",
        } as any)
      } catch (caught) {
        error = caught
      }
      expect(String(error)).to.contain(`Unsupported Terms override: ${field}`)
    }
  })
})
