/* eslint-disable no-await-in-loop, no-restricted-syntax */
import { ethers, network } from "hardhat"
import { expect } from "chai"
import {
  publicVaultCallbackFixture,
  fundingStorageFrame,
} from "../helpers/frost-public-vault-callback"
import { outpointKey } from "../helpers/frost-public-funding"
import { reservationProposal } from "../helpers/frost-reservation-proposal"

// Actual public proxy/Bank/Core proof paths. Controlled readiness, known scalar
// 3 and zero regtest relay difficulty do not qualify threshold signing or G-F.
describe("C-04 public Vault callback and captured watchtower boundaries", () => {
  let f: Awaited<ReturnType<typeof publicVaultCallbackFixture>>
  let snapshot: string
  const script = `0x0014${"11".repeat(20)}`
  const evidence =
    process.env.FROST_C04_CALLBACK_EVIDENCE ||
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    require("../helpers/frost-test-isolation").evidenceDirectory(
      "vault-callback"
    )

  before(async () => {
    f = await publicVaultCallbackFixture(evidence)
    const movement = Array.from(await f.bridge.movingFundsParameters())
    movement[1] = 500
    await f.bridge.updateMovingFundsParameters(...movement)
    await f.bridge.updateRedemptionParameters(3000, 100, 2000, 2000, 3600, 0, 0)
    await configureWatchtower(ethers.constants.AddressZero)
    snapshot = await network.provider.send("evm_snapshot")
  })
  beforeEach(async () => {
    await network.provider.send("evm_revert", [snapshot])
    snapshot = await network.provider.send("evm_snapshot")
  })
  async function configureWatchtower(address: string) {
    await f.frost.setFrostRedemptionsEnabled(false)
    await f.frost.configureFrostRedemptions(
      f.genesis,
      2,
      1000,
      address,
      ethers.utils.id("UNQUALIFIED local D08 callback reference")
    )
    await f.frost.setFrostRedemptionsEnabled(true)
  }
  async function request() {
    await f.bank.connect(f.depositor).approveBalance(f.frost.address, 20000)
    const caller = f.frost.connect(f.depositor)
    const id = await caller.callStatic.requestFrostRedemption(
      f.walletId,
      script,
      20000,
      f.depositor.address
    )
    await caller.requestFrostRedemption(
      f.walletId,
      script,
      20000,
      f.depositor.address
    )
    return id
  }
  async function proposal(id: string) {
    const custody = await f.frost.frostWalletCustody(f.walletId)
    return reservationProposal({
      bridge: f.frost.address,
      chainId: (await ethers.provider.getNetwork()).chainId,
      walletId: f.walletId,
      descriptorHash: f.descriptorHash,
      genesis: f.genesis,
      outputKey: f.descriptor.outputKey,
      generation: custody.generation.add(1),
      stateVersion: custody.stateVersion,
      validUntilBlock: (await ethers.provider.getBlockNumber()) + 500,
      inputs: [f.custodyUTXO],
      requests: [{ id, value: 18800, script }],
      fee: 1000,
      operators: f.operators,
    })
  }
  function reservationId(p: Awaited<ReturnType<typeof proposal>>) {
    const c = p.certificate
    return ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        [
          "bytes32",
          "uint256",
          "address",
          "bytes32",
          "bytes32",
          "uint64",
          "uint64",
          "bytes32",
        ],
        [
          ethers.utils.id("tbtc-v2/frost-reservation-id/v1"),
          f.descriptor.chainId,
          f.frost.address,
          c.walletId,
          c.descriptorHash,
          c.generation,
          c.stateVersion,
          c.intentCommitment,
        ]
      )
    )
  }
  function nextRequestId() {
    return ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        [
          "string",
          "uint256",
          "address",
          "bytes32",
          "bytes32",
          "uint64",
          "bytes32",
        ],
        [
          "tbtc-v2/frost-redemption-request/v1",
          f.descriptor.chainId,
          f.frost.address,
          f.walletId,
          f.descriptorHash,
          2,
          ethers.utils.keccak256(script),
        ]
      )
    )
  }
  async function frame(id: string, intentId = ethers.constants.HashZero) {
    const actors = [
      f.frost.address,
      f.vault.address,
      f.depositor.address,
      f.treasury.address,
      f.governance.address,
    ]
    const custody = await f.frost.frostWalletCustody(f.walletId)
    return JSON.stringify(
      await Promise.all([
        f.frost.frostDeposit(f.depositKey),
        f.frost.frostDeposit(outpointKey(f.custodyUTXO.txHash, 0)),
        f.frost.frostWalletCustody(f.walletId),
        f.frost.frostCustodyOutput(f.sweepKey),
        f.frost.frostCustodyOutput(outpointKey(f.custodyUTXO.txHash, 0)),
        f.walletView(),
        f.frost.frostRedemptionEscrow(f.walletId),
        f.frost.frostRedemptionRequest(id),
        f.frost.frostRedemptionRequest(nextRequestId()),
        f.frost.frostRedemptionPolicy(id),
        f.frost.frostRedemptionPolicy(nextRequestId()),
        f.frost.frostReservation(intentId),
        f.frost.frostReservation(custody.activeReservation),
        f.frost.frostRedemptionConfiguration(),
        fundingStorageFrame(f.frost.address, f.walletId, [
          f.depositKey,
          f.sweepKey,
          outpointKey(f.custodyUTXO.txHash, 0),
        ]),
        Promise.all(actors.map((actor) => f.bank.balanceOf(actor))),
        Promise.all(actors.map((actor) => f.bank.nonces(actor))),
        Promise.all(
          actors.flatMap((a) => actors.map((b) => f.bank.allowance(a, b)))
        ),
        f.bank.bridge(),
        f.bank.owner(),
        f.bank.DOMAIN_SEPARATOR(),
        f.bridge.isVaultTrusted(f.vault.address),
        f.vault.calls(),
        f.vault.observedBankBalance(),
        f.vault.received(f.depositor.address),
        f.vault.callbackSuccess(0),
        f.vault.callbackResult(0),
        f.vault.callbackSuccess(1),
        f.vault.callbackResult(1),
      ])
    )
  }
  async function prepareCallbacks(revertAfter: boolean) {
    const id = await request()
    const p = await proposal(id)
    const intentId = reservationId(p)
    // Publicly reserve the proven initial main before the deposit-only sweep.
    // F2 permits additive deposit-only credit while this intent retains main.
    await f.frost.reserveFrostRedemption(p)
    const activeIntent = await f.frost.frostReservation(intentId)
    const capturedCustody = await f.frost.frostWalletCustody(f.walletId)
    expect(activeIntent.state).eq(1)
    expect(activeIntent.snapshot).eq(p.snapshot)
    expect(activeIntent.requestIds).deep.eq([id])
    expect(activeIntent.certificate.generation).eq(1)
    expect(activeIntent.certificate.stateVersion).eq(1)
    expect(capturedCustody.activeReservation).eq(intentId)
    expect(capturedCustody.generation).eq(1)
    expect(capturedCustody.stateVersion).eq(1)
    expect((await f.frost.frostRedemptionRequest(id)).state).eq(2)
    const payloads = [
      f.frost.interface.encodeFunctionData("requestFrostRedemption", [
        f.walletId,
        script,
        20000,
        f.depositor.address,
      ]),
      f.frost.interface.encodeFunctionData("reserveFrostRedemption", [p]),
    ]
    await f.vault.configure(payloads, revertAfter)
    return { id, p, payloads, intentId, activeIntent, capturedCustody }
  }
  async function checkSuccessfulCredit(
    prepared: Awaited<ReturnType<typeof prepareCallbacks>>
  ) {
    expect(await f.bridge.isVaultTrusted(f.vault.address)).eq(true)
    expect(await f.bank.balanceOf(f.vault.address)).eq(98000)
    expect(await f.vault.observedBankBalance()).eq(98000)
    expect(await f.vault.received(f.depositor.address)).eq(98000)
    expect(await f.vault.calls()).eq(1)
    expect(await f.bank.balanceOf(f.depositor.address)).eq(78000)
    expect(await f.bank.balanceOf(f.treasury.address)).eq(2000)
    expect(await f.bank.balanceOf(f.frost.address)).eq(20000)
    const custody = await f.frost.frostWalletCustody(f.walletId)
    expect(custody.value).eq(198000)
    expect(custody.stateVersion).eq(1)
    expect(custody.generation).eq(1)
    expect(custody.mainOutpoint).eq(outpointKey(f.custodyUTXO.txHash, 0))
    expect(custody.activeReservation).eq(prepared.intentId)
    expect(custody.stateVersion).eq(prepared.capturedCustody.stateVersion)
    expect(custody.generation).eq(prepared.capturedCustody.generation)
    expect(custody.cancellationExposure).eq(
      prepared.capturedCustody.cancellationExposure
    )
    expect(await f.frost.frostReservation(prepared.intentId)).deep.eq(
      prepared.activeIntent
    )
    expect((await f.frost.frostRedemptionRequest(prepared.id)).state).eq(2)
    expect(
      (await f.frost.frostRedemptionRequest(prepared.id)).reservationId
    ).eq(prepared.intentId)
    const escrow = await f.frost.frostRedemptionEscrow(f.walletId)
    expect(escrow.gross).eq(20000)
    expect(escrow.netLiability).eq(19800)
    expect((await f.frost.frostCustodyOutput(f.sweepKey)).spent).eq(false)
    expect(
      (await f.frost.frostCustodyOutput(outpointKey(f.custodyUTXO.txHash, 0)))
        .spent
    ).eq(false)
    expect(
      (await f.bank.balanceOf(f.vault.address))
        .add(await f.bank.balanceOf(f.depositor.address))
        .add(await f.bank.balanceOf(f.treasury.address))
        .add(await f.bank.balanceOf(f.frost.address))
    ).eq(custody.value)
    const reason = ethers.utils.hexConcat([
      "0x08c379a0",
      ethers.utils.defaultAbiCoder.encode(
        ["string"],
        ["FROST redemption reentry"]
      ),
    ])
    for (const index of [0, 1]) {
      expect(await f.vault.callbackSuccess(index)).eq(false)
      expect(await f.vault.callbackResult(index)).eq(reason)
    }
  }

  it("credits a trusted Vault through Bank while main is reserved and rejects request/reserve reentry during C05 sweep", async () => {
    // Establish the F2 precondition: a populated unreserved wallet must sweep
    // main, so the exact deposit-only proof is unavailable until reservation.
    const unreserved = await frame(ethers.constants.HashZero)
    await expect(
      f.frost.submitFrostDepositSweepProof(f.vaultSweep)
    ).revertedWith("FROST sweep main required")
    expect(await frame(ethers.constants.HashZero)).eq(unreserved)
    const prepared = await prepareCallbacks(false)
    const { id, payloads, intentId, activeIntent } = prepared
    await f.frost.submitFrostDepositSweepProof(f.vaultSweep)
    await checkSuccessfulCredit(prepared)
    expect((await f.frost.frostRedemptionRequest(nextRequestId())).state).eq(0)
    // The request becomes usable after entered clears. The exact reservation
    // payload instead reaches normal active-main serialization, retaining intent.
    await f.vault.execute(payloads[0])
    expect((await f.frost.frostRedemptionRequest(nextRequestId())).state).eq(1)
    expect(
      (await f.frost.frostRedemptionRequest(nextRequestId())).reservationId
    ).eq(ethers.constants.HashZero)
    expect((await f.frost.frostRedemptionRequest(id)).state).eq(2)
    expect(await f.bank.balanceOf(f.vault.address)).eq(78000)
    expect(await f.bank.balanceOf(f.frost.address)).eq(40000)
    expect((await f.frost.frostRedemptionEscrow(f.walletId)).gross).eq(40000)
    expect((await f.frost.frostRedemptionEscrow(f.walletId)).netLiability).eq(
      39600
    )
    const before = await frame(id, intentId)
    await expect(f.vault.execute(payloads[1])).revertedWith(
      "FROST reservation custody state"
    )
    expect(await frame(id, intentId)).eq(before)
    expect(await f.frost.frostReservation(intentId)).deep.eq(activeIntent)
    const custody = await f.frost.frostWalletCustody(f.walletId)
    expect(custody.activeReservation).eq(intentId)
    expect(custody.stateVersion).eq(1)
    expect(custody.generation).eq(1)
  })

  it("rolls back all proof/deposit/custody/Bank/Vault effects on a callback-reverting late failure", async () => {
    const prepared = await prepareCallbacks(true)
    const { id, payloads, intentId, activeIntent } = prepared
    const before = await frame(id, intentId)
    await expect(
      f.frost.submitFrostDepositSweepProof(f.vaultSweep)
    ).revertedWith("Vault late failure")
    expect(await frame(id, intentId)).eq(before)
    expect(await f.frost.frostReservation(intentId)).deep.eq(activeIntent)
    expect((await f.frost.frostRedemptionRequest(id)).state).eq(2)
    const custody = await f.frost.frostWalletCustody(f.walletId)
    expect(custody.activeReservation).eq(intentId)
    expect(custody.value).eq(99000)
    expect(custody.stateVersion).eq(1)
    expect(custody.generation).eq(1)
    expect((await f.frost.frostCustodyOutput(f.sweepKey)).walletId).eq(
      ethers.constants.HashZero
    )
    expect(await f.bank.balanceOf(f.vault.address)).eq(0)
    expect(await f.vault.calls()).eq(0)
    await f.vault.configure(payloads, false)
    await f.frost.submitFrostDepositSweepProof(f.vaultSweep)
    await checkSuccessfulCredit(prepared)
  })

  it("retains captured watchtower policy/delay across configuration changes and refuses the old service's veto", async () => {
    const oldPolicy = ethers.utils.id("captured-policy-A")
    const old = await (
      await ethers.getContractFactory("FrostCapturedWatchtowerFixture")
    ).deploy(oldPolicy, 120)
    const replacement = await (
      await ethers.getContractFactory("FrostCapturedWatchtowerFixture")
    ).deploy(ethers.utils.id("replacement-policy"), 0)
    await configureWatchtower(old.address)
    const id = await request()
    const captured = await f.frost.frostRedemptionPolicy(id)
    expect(captured.watchtower).eq(old.address)
    expect(captured.policyId).eq(oldPolicy)
    const capturedAt = (await ethers.provider.getBlock("latest")).timestamp
    expect(captured.notBefore).eq(capturedAt + 120)
    await old.changeRequestPolicy(ethers.utils.id("new-policy-B"), 0)
    await configureWatchtower(replacement.address)
    const p = await proposal(id)
    const intentId = reservationId(p)
    let before = await frame(id, intentId)
    await expect(f.frost.reserveFrostRedemption(p)).revertedWith(
      "FROST request delay"
    )
    expect(await frame(id, intentId)).eq(before)
    await network.provider.send("evm_setNextBlockTimestamp", [
      captured.notBefore.toNumber(),
    ])
    await network.provider.send("evm_mine")
    await old.setAdmissionAllowed(false)
    expect(await replacement.isAllowed(id, await replacement.policy())).eq(true)
    before = await frame(id, intentId)
    await expect(f.frost.reserveFrostRedemption(p)).revertedWith(
      "FROST watchtower admission refused"
    )
    expect(await frame(id, intentId)).eq(before)
    expect(await f.frost.frostRedemptionPolicy(id)).deep.eq(captured)
    await old.setAdmissionAllowed(true)
    await f.frost.reserveFrostRedemption(p)
    expect((await f.frost.frostRedemptionRequest(id)).state).eq(2)
    expect((await f.frost.frostReservation(intentId)).state).eq(1)
    expect(await f.frost.frostRedemptionPolicy(id)).deep.eq(captured)
  })
})
