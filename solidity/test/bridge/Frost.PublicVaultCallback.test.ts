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
    // D13 refinement (tuxxy/tbtc-v2#24): the reservation opens no
    // deposit-only credit beside the reserved main.
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

  // D13 refinement (tuxxy/tbtc-v2#24). These two cases previously required
  // the deposit-only Vault sweep to be credited while the main was reserved
  // (then checked request/reserve reentry from the Vault callback, and the
  // rollback of a late callback failure). Under the new rule that sweep is
  // refused before any Bank or Vault effect, in both callback
  // configurations. Vault-callback reentry and late-failure rollback stay
  // covered on the C-04 sweep-resolution route, the only sweep admitted
  // during a reservation (Frost.SweepConflictResolution.test.ts: "rejects
  // cross-entrypoint reentry from the trusted Vault after real Bank credit",
  // which also sends the request/reserve payloads, and "rolls back the
  // entire financial frame on a late Vault failure ...").
  const revertAfterModes = [false, true]
  revertAfterModes.forEach((revertAfter) => {
    it(`refuses the deposit-only trusted-Vault sweep while main is reserved, before any callback (callback ${
      revertAfter ? "reverting late" : "succeeding"
    })`, async () => {
      // The F2 precondition: a populated unreserved wallet must sweep main.
      const unreserved = await frame(ethers.constants.HashZero)
      await expect(
        f.frost.submitFrostDepositSweepProof(f.vaultSweep)
      ).revertedWith("FROST sweep main required")
      expect(await frame(ethers.constants.HashZero)).eq(unreserved)
      const prepared = await prepareCallbacks(revertAfter)
      const { id, intentId, activeIntent } = prepared
      const before = await frame(id, intentId)
      expect(
        await f.frost.submitFrostDepositSweepProof(f.vaultSweep).then(
          () => "accepted",
          (e: Error) => e.message
        ),
        "tbtc-v2#24: the deposit-only Vault sweep beside the reserved main was not refused by the main guard"
      ).to.match(/FROST sweep main (required|reserved)/)
      expect(await frame(id, intentId)).eq(before)
      expect(await f.frost.frostReservation(intentId)).deep.eq(activeIntent)
      expect((await f.frost.frostRedemptionRequest(id)).state).eq(2)
      const custody = await f.frost.frostWalletCustody(f.walletId)
      expect(custody.activeReservation).eq(intentId)
      expect(custody.value).eq(99000)
      expect(custody.stateVersion).eq(1)
      expect(custody.generation).eq(1)
      expect(custody.mainOutpoint).eq(outpointKey(f.custodyUTXO.txHash, 0))
      expect((await f.frost.frostCustodyOutput(f.sweepKey)).walletId).eq(
        ethers.constants.HashZero
      )
      expect(await f.bridge.spentMainUTXOs(f.depositKey)).eq(false)
      expect(await f.bank.balanceOf(f.vault.address)).eq(0)
      expect(await f.vault.calls()).eq(0)
    })
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
