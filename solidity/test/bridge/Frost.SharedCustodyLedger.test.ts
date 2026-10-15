/* eslint-disable no-await-in-loop, no-restricted-syntax */
import { artifacts, ethers } from "hardhat"
import { expect } from "chai"
import { BigNumber, Contract } from "ethers"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"

// Component only: roots, Bank issuance, plan snapshot and unauthenticated
// certificate are synthetic. No funded or public lifecycle qualification.
describe("C-04 shared custody settlement component with real Bank", () => {
  const walletId = ethers.utils.id("synthetic-component-wallet")
  const descriptorHash = ethers.utils.id("synthetic-component-descriptor")
  const script = `0x0014${"11".repeat(20)}`
  const rootA = {
    txHash: ethers.utils.id("synthetic-root-A"),
    txOutputIndex: 0,
    txOutputValue: 100000,
  }
  const rootB = {
    txHash: ethers.utils.id("synthetic-root-B"),
    txOutputIndex: 1,
    txOutputValue: 50000,
  }
  const lateA = {
    txHash: ethers.utils.id("synthetic-late-A"),
    txOutputIndex: 2,
    txOutputValue: 30000,
  }
  const lateB = {
    txHash: ethers.utils.id("synthetic-late-B"),
    txOutputIndex: 3,
    txOutputValue: 20000,
  }
  const followup = {
    txHash: ethers.utils.id("synthetic-followup"),
    txOutputIndex: 4,
    txOutputValue: 7000,
  }
  const paymentHash = ethers.utils.id("synthetic-payment")
  const cancellationHash = ethers.utils.id("synthetic-cancellation")
  const changeIndex = 2
  const key = (txHash: string, index: number) =>
    ethers.utils.solidityKeccak256(["bytes32", "uint32"], [txHash, index])
  const inputKey = (input: typeof rootA) =>
    key(input.txHash, input.txOutputIndex)
  const roots = [inputKey(rootA), inputKey(rootB)]
  const late = [inputKey(lateA), inputKey(lateB)]
  const outputKeys = [
    ...roots,
    ...late,
    inputKey(followup),
    key(paymentHash, changeIndex),
    key(cancellationHash, changeIndex),
  ]
  let f: Contract
  let bank: Contract
  let owner: SignerWithAddress
  let redeemer: SignerWithAddress
  let sponsor: SignerWithAddress
  let treasury: SignerWithAddress
  let outsider: SignerWithAddress
  let actors: string[]
  let requestId: string
  let remainingId: string
  let intentId: string
  let snapshot: string

  async function credit(input: typeof rootA, generation: number) {
    await f.creditForComponent(
      walletId,
      generation,
      input.txHash,
      input.txOutputIndex,
      input.txOutputValue
    )
  }

  before(async () => {
    const [
      componentOwner,
      componentRedeemer,
      componentSponsor,
      componentTreasury,
      componentOutsider,
    ] = await ethers.getSigners()
    owner = componentOwner
    redeemer = componentRedeemer
    sponsor = componentSponsor
    treasury = componentTreasury
    outsider = componentOutsider
    const artifact = await artifacts.readArtifact(
      "FrostSharedCustodyLedgerFixture"
    )
    expect((artifact.deployedBytecode.length - 2) / 2).at.most(24576)
    f = await (
      await ethers.getContractFactory("FrostSharedCustodyLedgerFixture")
    ).deploy()
    await f.deployed()
    bank = await ethers.getContractAt("Bank", await f.bank())
    actors = [
      f.address,
      owner.address,
      redeemer.address,
      sponsor.address,
      treasury.address,
      outsider.address,
    ]
    for (const [address, value] of [
      [owner.address, 100000],
      [redeemer.address, 700],
      [sponsor.address, 20000],
      [treasury.address, 1000],
      [outsider.address, 333],
    ] as const)
      await f.issueForComponent(address, value)
    await bank.connect(owner).approveBalance(f.address, 15000)
    await bank.connect(sponsor).approveBalance(f.address, 12000)
    await credit(rootA, 0)
    await credit(rootB, 0)
    const admission = {
      walletId,
      descriptorHash,
      balanceOwner: owner.address,
      redeemer: redeemer.address,
      gross: 10000,
      treasuryFee: 100,
      maximumBitcoinFee: 100,
      timeoutSeconds: 86400,
      finalityBlocks: 3,
      script,
    }
    requestId = await f.callStatic.request(admission)
    await f.request(admission)
    const remaining = { ...admission, gross: 5000, treasuryFee: 50 }
    remainingId = await f.callStatic.request(remaining)
    await f.request(remaining)
    const certificate = {
      walletId,
      descriptorHash,
      generation: 1,
      stateVersion: 2,
      intentCommitment: ethers.utils.id(
        "SYNTHETIC UNAUTHENTICATED intent commitment"
      ),
      requestIdsHash: ethers.utils.id("SYNTHETIC request hash"),
      conflictTxHash: rootA.txHash,
      conflictOutputIndex: rootA.txOutputIndex,
      minimumFee: 1,
      maximumFee: 12000,
      maximumSatPerVByte: 100,
      validUntilBlock: 1000000,
    }
    const plan = {
      snapshot: ethers.utils.id("SYNTHETIC component snapshot"),
      genesis: ethers.utils.id("SYNTHETIC component network"),
      requests: [{ id: requestId, value: 9800, script }],
    }
    intentId = await f.callStatic.reserveForComponent(
      certificate,
      plan,
      paymentHash,
      [rootA, rootB]
    )
    await f.reserveForComponent(certificate, plan, paymentHash, [rootA, rootB])
    await f.fundCancellationForComponent(
      intentId,
      cancellationHash,
      sponsor.address,
      12000
    )
    snapshot = await ethers.provider.send("evm_snapshot", [])
  })
  beforeEach(async () => {
    await ethers.provider.send("evm_revert", [snapshot])
    snapshot = await ethers.provider.send("evm_snapshot", [])
  })

  async function bankFrame() {
    const [balances, nonces, allowances] = await Promise.all([
      Promise.all(actors.map((actor) => bank.balanceOf(actor))),
      Promise.all(actors.map((actor) => bank.nonces(actor))),
      Promise.all(
        actors.flatMap((a) => actors.map((b) => bank.allowance(a, b)))
      ),
    ])
    return {
      balances: balances.map((v: BigNumber) => v.toString()),
      nonces: nonces.map((v: BigNumber) => v.toString()),
      allowances: allowances.map((v: BigNumber) => v.toString()),
      bridge: await bank.bridge(),
      owner: await bank.owner(),
      domain: await bank.DOMAIN_SEPARATOR(),
    }
  }
  async function frame() {
    return {
      custodyLedger: await f.frame(
        walletId,
        intentId,
        [requestId, remainingId],
        outputKeys
      ),
      bank: await bankFrame(),
    }
  }
  async function rejects(operation: () => Promise<unknown>, reason: string) {
    const before = await frame()
    await expect(operation()).revertedWith(reason)
    expect(await frame()).deep.eq(before)
  }
  async function addLateCredits() {
    const before = await f.wallet(walletId)
    const bankBefore = await bankFrame()
    await credit(lateA, 1)
    await credit(lateB, 1)
    const wallet = await f.wallet(walletId)
    expect(wallet.value).eq(200000)
    for (const field of [
      "mainOutpoint",
      "activeReservation",
      "generation",
      "stateVersion",
      "cancellationExposure",
    ]) {
      expect(wallet[field]).eq(before[field])
    }
    expect(wallet.mainOutpoint).eq(roots[0])
    expect(wallet.activeReservation).eq(intentId)
    expect(wallet.generation).eq(1)
    expect(wallet.stateVersion).eq(2)
    expect(wallet.cancellationExposure).eq(2100)
    expect(await f.escrow(walletId)).eq(15000)
    expect(await f.netLiability(walletId)).eq(14850)
    expect(await bankFrame()).deep.eq(bankBefore)
    for (const outputKey of [...roots, ...late])
      expect((await f.output(outputKey)).spent).eq(false)
  }
  const modes = ["pay", "cancel"] as const
  type Mode = typeof modes[number]
  async function settle(mode: Mode) {
    if (mode === "pay")
      return f.pay(intentId, treasury.address, 140100, changeIndex)
    return f.cancel(intentId, 138000, changeIndex)
  }

  modes.forEach((mode) => {
    it(`preserves post-reservation credits through ${mode}, consumes captured inputs once and retains followup main`, async () => {
      await addLateCredits()
      const before = await bankFrame()
      await settle(mode)
      const changeKey = key(
        mode === "pay" ? paymentHash : cancellationHash,
        changeIndex
      )
      const expectedValue = mode === "pay" ? 190100 : 188000
      const wallet = await f.wallet(walletId)
      expect(wallet.value).eq(expectedValue)
      expect(wallet.mainOutpoint).eq(changeKey)
      expect(wallet.generation).eq(1)
      expect(wallet.stateVersion).eq(3)
      expect(wallet.activeReservation).eq(ethers.constants.HashZero)
      expect(wallet.cancellationExposure).eq(0)
      for (const outputKey of roots) {
        const output = await f.output(outputKey)
        expect(output.walletId).eq(walletId)
        expect(output.spent).eq(true)
      }
      for (const [input, value] of [
        [lateA, 30000],
        [lateB, 20000],
      ] as const) {
        const output = await f.output(inputKey(input))
        expect(output.walletId).eq(walletId)
        expect(output.value).eq(value)
        expect(output.spent).eq(false)
      }
      const change = await f.output(changeKey)
      expect(change.walletId).eq(walletId)
      expect(change.spent).eq(false)
      expect(change.value).eq(mode === "pay" ? 140100 : 138000)
      expect((await f.requestRecord(requestId)).state).eq(
        mode === "pay" ? 4 : 5
      )
      expect((await f.requestRecord(remainingId)).state).eq(1)
      expect((await f.intentRecord(intentId)).state).eq(mode === "pay" ? 2 : 3)
      expect(await f.escrow(walletId)).eq(5000)
      expect(await f.netLiability(walletId)).eq(4950)
      const after = await bankFrame()
      expect(after.balances).deep.eq([
        "5000",
        "85000",
        mode === "pay" ? "700" : "10700",
        mode === "pay" ? "20000" : "8000",
        mode === "pay" ? "1100" : "1000",
        "333",
      ])
      expect(after.allowances).deep.eq(before.allowances)
      expect(after.nonces).deep.eq(before.nonces)
      expect(after.bridge).eq(f.address)
      expect(after.owner).eq(before.owner)
      expect(after.domain).eq(before.domain)
      const sum = (balances: string[]) =>
        balances.reduce((total, value) => total.add(value), BigNumber.from(0))
      expect(sum(before.balances).sub(sum(after.balances))).eq(
        mode === "pay" ? 9900 : 12000
      )
      await rejects(
        () => settle(mode),
        mode === "pay"
          ? "FROST intent already resolved"
          : "FROST cancellation not authorized"
      )
      await rejects(() => credit(rootA, 1), "FROST custody duplicate")
      await rejects(() => credit(lateA, 1), "FROST custody duplicate")
      await rejects(() => credit(followup, 2), "FROST custody generation")
      const bankBeforeFollowup = await bankFrame()
      await credit(followup, 1)
      const later = await f.wallet(walletId)
      expect(later.value).eq(expectedValue + 7000)
      expect(later.mainOutpoint).eq(changeKey)
      expect(later.generation).eq(1)
      expect(later.stateVersion).eq(4)
      expect(later.cancellationExposure).eq(0)
      expect(later.activeReservation).eq(ethers.constants.HashZero)
      expect((await f.output(inputKey(followup))).spent).eq(false)
      expect((await f.output(inputKey(followup))).value).eq(7000)
      expect(await bankFrame()).deep.eq(bankBeforeFollowup)
      expect(await f.escrow(walletId)).eq(5000)
      expect(await f.netLiability(walletId)).eq(4950)
    })

    it(`rolls back the complete custody/escrow/Bank frame for duplicate or stale ${mode} inputs`, async () => {
      await addLateCredits()
      for (const fault of ["duplicate", "value", "spent"]) {
        const checkpoint = await ethers.provider.send("evm_snapshot", [])
        if (fault === "duplicate")
          await f.corruptCapturedInput(intentId, 1, rootA)
        else if (fault === "value")
          await f.corruptCapturedInput(intentId, 1, {
            ...rootB,
            txOutputValue: 50001,
          })
        else await f.markSpentForComponent(roots[1])
        // Second captured input fails after request bookkeeping and first-input
        // spend/value changes. Every earlier write must revert with the Bank frame.
        await rejects(() => settle(mode), "FROST spent reservation input")
        expect((await f.output(roots[0])).spent).eq(false)
        expect((await f.requestRecord(requestId)).state).eq(2)
        expect(await f.escrow(walletId)).eq(15000)
        expect(await f.netLiability(walletId)).eq(14850)
        expect((await f.wallet(walletId)).value).eq(200000)
        await ethers.provider.send("evm_revert", [checkpoint])
      }
      await settle(mode)
      expect((await f.output(late[0])).spent).eq(false)
      expect((await f.output(late[1])).spent).eq(false)
    })
  })
})
