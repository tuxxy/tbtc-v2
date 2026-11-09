/* eslint-disable no-await-in-loop, no-restricted-syntax, @typescript-eslint/no-explicit-any, @typescript-eslint/no-loop-func */
// C-11a property 5: FROST governance reachable through the production
// authority (tuxxy/tbtc-v2#57, D22 pick (a); #58). Split from
// Frost.Upgrade.test.ts to keep each file under the 2 min budget; the
// invariants and the world are described there and in test/c11/README.md.
import { ethers } from "hardhat"
import { expect } from "chai"
import {
  BUDGET_RECORD,
  C11World,
  EVIDENCE,
  GENESIS,
  GOVERNANCE_REASONS,
  MAX_UINT64,
  OWNABLE_REASON,
  RECIPES,
  RECORD,
  ZERO_ADDRESS,
  activate,
  c11Frame,
  c11World,
  calldata,
  changed,
  codehash,
  context,
  expectField,
  forward,
  frostAt,
  frostReveal,
  frostTerms,
  frostWallet,
  gov,
  p2tr,
  refused,
  setup,
  transaction,
  upgraded,
} from "./c11-cases"

describe("C-11a FROST governance through BridgeGovernance (tbtc-v2#57, #58)", function () {
  this.timeout(180_000)
  let c: C11World
  /// The world is built once (suite setup); each case starts from a snapshot.
  before(async () => {
    c = await c11World()
  })
  afterEach(function timing() {
    if (process.env.C11_TIMING)
      console.log(
        `C11 TIMING ${this.currentTest?.duration} ms ${this.currentTest?.title}`
      )
  })

  for (const name of Object.keys(RECIPES))
    it(`[5 #57] ${name}: the council's every argument reaches the Bridge through BridgeGovernance at once; everyone else is refused`, async () => {
      const { c: w, bundle } = await upgraded()
      c = w
      const r = context(c, bundle)
      await setup(r, name)
      const calls = await RECIPES[name].calls(r)
      const data = await calldata(name, calls[0].args)
      const before = await c11Frame(c)
      for (const [who, s] of Object.entries({
        outsider: c.outsider,
        deployer: c.deployer,
        "historical deployer": c.historicalDeployer,
      }))
        await refused(
          `${name}: the ${who} through BridgeGovernance`,
          () => s.sendTransaction({ to: bundle.bridgeGovernance, data }),
          [OWNABLE_REASON]
        )
      for (const [who, s] of Object.entries({
        council: c.council,
        outsider: c.outsider,
      }))
        await refused(
          `${name}: the ${who} directly on the Bridge`,
          () => s.sendTransaction({ to: c.proxy.address, data }),
          GOVERNANCE_REASONS
        )
      expect(
        changed(before, await c11Frame(c)),
        `${name}: frame unchanged by refusals`
      ).to.deep.equal([])
      // Every call (both directions of a switch, distinct values for
      // same-typed arguments) through BridgeGovernance, immediately.
      for (const call of calls) await forward(r, name, call)
    })

  it("[5 runbook] with RebateStaking still set, the installs and open gates refuse a FROST reveal (D20 precondition)", async () => {
    const { c: w, bundle } = await upgraded()
    c = w
    const r = context(c, bundle)
    const frost = await frostAt(c)
    await gov(r, "configureFrostRegistry", [c.frostRegistry.address])
    await gov(r, "configureFrostFunding", [
      bundle.verifier,
      await codehash(bundle.verifier),
      RECORD,
      GENESIS,
    ])
    const controller = await ethers.getContractAt(
      "FrostExposureController",
      bundle.exposureController
    )
    await controller
      .connect(c.council)
      .openBudgetPeriod(MAX_UINT64, MAX_UINT64, BUDGET_RECORD)
    await gov(r, "installFrostExposureController", [bundle.exposureController])
    await gov(r, "setFrostFundingGates", [true, true])
    const y = await frostWallet(r, 0x3200)
    const { t, fundingTx } = await frostReveal(r, y, 200000)
    await refused(
      "runbook without the unset: FROST reveal refused",
      () => frost.connect(c.alias).revealFrostDeposit(t, fundingTx.tx, 0),
      ["FROST rebate unsupported"]
    )
  })

  it("[5 runbook] activation through the production route: retire rebated redemptions, unset RebateStaking, install registry, verifier and controller, open the gates; a FROST reveal passes the rebate check", async () => {
    const { c: w, bundle } = await upgraded()
    c = w
    const r = context(c, bundle)
    const frost = await frostAt(c)
    const admission = await ethers.getContractAt(
      "FrostDepositAdmission",
      c.proxy.address
    )
    const { wallet: x } = await activate(r)
    expect(
      await c.legacy.getRebateStaking(),
      "D20: RebateStaking unset"
    ).to.equal(ZERO_ADDRESS)
    const { t, fundingTx } = await frostReveal(r, x, 200000)
    await expect(
      frost.connect(c.alias).revealFrostDeposit(t, fundingTx.tx, 0),
      "runbook: a FROST reveal passes the rebate check"
    ).to.emit(admission, "FrostDepositRevealed")
  })

  it("[5 emergency] close every switch the runbook opens and contain, through the production route", async () => {
    const { c: w, bundle } = await upgraded()
    c = w
    const r = context(c, bundle)
    const frost = await frostAt(c)
    const { wallet: x, controller } = await activate(r, false)
    // Open everything the runbook can open.
    await gov(r, "configureFrostRedemptions", [
      GENESIS,
      6,
      100,
      c.tower.address,
      EVIDENCE,
    ])
    await gov(r, "setFrostRedemptionsEnabled", [true])
    await gov(r, "setFrostRequestsEnabled", [true])
    await gov(r, "setFrostDrainEnabled", [true])
    const switches: [string, string[]][] = [
      [
        "address gate",
        ["self", "frostFunding", "configuration", "addressesEnabled"],
      ],
      [
        "reveal gate",
        ["self", "frostFunding", "configuration", "revealEnabled"],
      ],
      [
        "FROST redemptions",
        ["self", "frostRedemptions", "configuration", "enabled"],
      ],
      ["FROST wallet requests", ["self", "frost", "requestsEnabled"]],
      ["drain", ["self", "frostMovement", "drainEnabled"]],
    ]
    for (const [label, p] of switches)
      await expectField(r, p, BigInt(1), `emergency setup: ${label} open`)
    // The emergency direction.
    await gov(r, "setFrostFundingGates", [false, false])
    await gov(r, "setFrostRedemptionsEnabled", [false])
    await gov(r, "setFrostRequestsEnabled", [false])
    await gov(r, "setFrostDrainEnabled", [false])
    await controller
      .connect(c.council)
      .contain(ethers.utils.id("C11 emergency"))
    for (const [label, p] of switches)
      await expectField(r, p, BigInt(0), `emergency: ${label} closed`)
    expect(await controller.contained(), "emergency: contained").to.equal(true)
    const blocked = await frostTerms(r, x, 200000)
    const fundingTx = transaction(
      [[ethers.utils.id("C11 emergency funding"), 0]],
      [{ value: 200000, script: p2tr(x.q) }]
    )
    await refused("emergency: FROST reveal refused", () =>
      frost.connect(c.alias).revealFrostDeposit(blocked, fundingTx.tx, 0)
    )
    await refused(
      "emergency: FROST wallet request refused",
      () => frost.connect(c.outsider).requestNewFrostWallet(),
      ["FROST requests disabled"]
    )
  })
})
