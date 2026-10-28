import { network } from "hardhat"
import { expect } from "chai"
import { publicFundedFixture } from "../helpers/frost-public-funding"

describe("C-04 public Bridge funding component (controlled readiness and regtest work)", () => {
  let f: Awaited<ReturnType<typeof publicFundedFixture>>
  let snapshot: string
  before(async () => {
    f = await publicFundedFixture()
    snapshot = await network.provider.send("evm_snapshot")
  })
  beforeEach(async () => {
    expect(await network.provider.send("evm_revert", [snapshot])).to.equal(true)
    snapshot = await network.provider.send("evm_snapshot")
  })
  it("funds through public registry callbacks, reveal and actual Core sweep proof only", async () => {
    expect(await f.bank.bridge()).to.equal(f.bridge.address)
    expect(await f.bank.balanceOf(f.depositor.address)).to.equal(98000)
    expect(await f.bank.balanceOf(f.treasury.address)).to.equal(1000)
    expect((await f.frost.frostWalletCustody(f.walletId)).value).to.equal(99000)
    expect(f.descriptor.threshold).to.equal(2)
    expect(f.descriptor.operators).to.deep.equal(
      f.operators.map((s) => s.address)
    )
    expect(f.coreWitness.terms.bridge).to.equal(f.bridge.address)
    expect(f.coreWitness.terms.descriptorHash).to.equal(f.descriptorHash)
    expect(f.coreWitness.terms.bitcoinGenesis).to.equal(f.genesis)
  })
  it("refuses replay through public dispatch without changing custody or Bank credits", async () => {
    const before = await f.frost.frostWalletCustody(f.walletId)
    await expect(
      f.frost.submitFrostDepositSweepProof(f.sweep)
    ).to.be.revertedWith("FROST sweep main required")
    expect(await f.frost.frostWalletCustody(f.walletId)).to.deep.equal(before)
    expect(await f.bank.balanceOf(f.depositor.address)).to.equal(98000)
    expect(await f.bank.balanceOf(f.treasury.address)).to.equal(1000)
  })
  it("refuses direct or unauthorized readiness callbacks without altering the public wallet", async () => {
    const before = await f.walletView()
    await expect(
      f.registry.connect(f.depositor).ready(f.walletId, f.descriptorHash)
    ).to.be.revertedWith("Controlled registry owner only")
    await expect(
      f.frost
        .connect(f.depositor)
        .__snowfallWalletReady(f.walletId, f.descriptorHash, 1, 1)
    ).to.be.revertedWith("FROST callback sender")
    expect(await f.walletView()).to.deep.equal(before)
  })
})
