/* eslint-disable no-await-in-loop, no-restricted-syntax */
// Refs RebateStaking policy gap (K-09-restart/ADV-contracts.md, Notes (P3);
// review recheck N10; REVIEW-TEST-K09-CONTRACTS.md B1).
// Decision (tux, 2026-11-04, DECISIONS.md): FROST deposit reveals require
// RebateStaking to be unset (a governance precondition before FROST deposits
// open); no FROST rebate support now. The refusal must be explicit and
// documented, and legacy deposits keep rebates.
//
// Invariants:
// - REFUSED: with RebateStaking set, a FROST reveal is refused with the
//   explicit reason "FROST rebate unsupported" (the reason the frozen
//   K09.CutoverInvariants test already pins, so a fix keeps it).
// - LEGACY: with RebateStaking set on the upgraded Bridge, a legacy reveal
//   creates the same rebate as the same reveal on 40a11d1d (fee, rebate
//   entries, available rebate), and the rebate is released by the rolling
//   window as on 40a11d1d.
// - UNSET: with RebateStaking unset, the same kind of FROST reveal works.
// - DOCUMENTED: the precondition is documented where governance and
//   integrators read it: the NatSpec of `revealFrostDeposit` names
//   RebateStaking and the reason, and the NatSpec of `setRebateStaking`
//   says that setting it refuses FROST deposit reveals.
//
// How governance unsets RebateStaking on a Bridge where it is set and
// reinitializer(5) is spent (DECISIONS.md D20, answered 2026-11-05) is
// tested in B8.RebateStakingUnset.test.ts.
import { artifacts, ethers } from "hardhat"
import { expect } from "chai"
import {
  b8World,
  B8World,
  REBATE_CAP,
  REBATE_DEPOSIT,
} from "../helpers/b8-world"

const REASON = "FROST rebate unsupported"

describe("B8 RebateStaking: FROST reveals require RebateStaking unset", () => {
  let w: B8World
  beforeEach(async function setup() {
    this.timeout(180000)
    w = await b8World()
  })

  /// Governance sets RebateStaking on the upgraded Bridge; `rebater` stakes.
  const setRebates = async () => {
    await w.bridge.setRebateStaking(w.rebate.address)
    await w.stakeRebater()
    expect(await w.bridge.getRebateStaking()).to.equal(w.rebate.address)
  }

  it("[RebateStaking] set: a FROST reveal is refused with the explicit reason", async () => {
    await setRebates()
    const [x] = w.pool
    const { t, fundingTx } = await w.revealFrost(x, 200000)
    await expect(
      w.frost.connect(w.alias).revealFrostDeposit(t, fundingTx.tx, 0),
      "RebateStaking: a FROST reveal with RebateStaking set was not refused explicitly"
    ).to.be.revertedWith(REASON)
  })

  it("[RebateStaking] set: legacy reveals create and release rebates as on 40a11d1d", async () => {
    // The 40a11d1d witness: fee 1,000, rebate capped at 600, fee 400.
    expect(w.baselineRebate).to.deep.equal({
      treasuryFee: String(REBATE_DEPOSIT / 100 - REBATE_CAP),
      rebates: [String(REBATE_CAP)],
      available: "0",
      availableAfterWindow: String(REBATE_CAP),
    })
    await setRebates()
    const key = await w.legacyRebateReveal(w.bridge)
    expect(
      await w.rebateRecord(w.bridge, key),
      "RebateStaking: a legacy reveal's rebate differs from 40a11d1d"
    ).to.deep.equal(w.baselineRebate)
  })

  it("[RebateStaking] unset: a FROST reveal works", async () => {
    expect(await w.bridge.getRebateStaking()).to.equal(
      "0x0000000000000000000000000000000000000000"
    )
    const [x] = w.pool
    const { t, fundingTx } = await w.revealFrost(x, 200000)
    // The library event, emitted by the proxy.
    const admission = await ethers.getContractAt(
      "FrostDepositAdmission",
      w.proxy.address
    )
    await expect(
      w.frost.connect(w.alias).revealFrostDeposit(t, fundingTx.tx, 0),
      "RebateStaking: a FROST reveal with RebateStaking unset was refused"
    ).to.emit(admission, "FrostDepositRevealed")
  })

  it("[RebateStaking] documented: the governance precondition is in the NatSpec of revealFrostDeposit and setRebateStaking", async () => {
    // NatSpec from the compiler metadata of every contract compiled with
    // the Bridge and the FROST bridge interfaces.
    const docs: { method: string; text: string }[] = []
    const seen = new Set<string>()
    for (const fqn of [
      "contracts/bridge/Bridge.sol:Bridge",
      "contracts/frost/IFrostFundingBridge.sol:IFrostFundingBridge",
      "contracts/frost/IFrostBridge.sol:IFrostBridge",
    ]) {
      const info = await artifacts.getBuildInfo(fqn)
      if (info && !seen.has(info.id)) {
        seen.add(info.id)
        for (const contracts of Object.values(info.output.contracts))
          for (const c of Object.values(contracts as any)) {
            const meta = (c as any).metadata
            const output = meta ? JSON.parse(meta).output : undefined
            for (const kind of ["userdoc", "devdoc"])
              for (const [method, doc] of Object.entries(
                output?.[kind]?.methods ?? {}
              ))
                docs.push({ method, text: JSON.stringify(doc) })
          }
      }
    }
    const about = (prefix: string) =>
      docs
        .filter((d) => d.method.startsWith(prefix))
        .map((d) => d.text)
        .join(" ")
    const reveal = about("revealFrostDeposit(")
    expect(
      /rebate ?staking/i.test(reveal) && reveal.includes(REASON),
      `RebateStaking: the NatSpec of revealFrostDeposit does not state the RebateStaking precondition and the "${REASON}" refusal`
    ).to.equal(true)
    const set = about("setRebateStaking(")
    expect(
      /FROST/.test(set),
      "RebateStaking: the NatSpec of setRebateStaking does not say that setting it refuses FROST deposit reveals"
    ).to.equal(true)
  })
})
