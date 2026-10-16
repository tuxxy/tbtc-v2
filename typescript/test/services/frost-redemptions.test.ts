import { BigNumber } from "ethers"
import { expect } from "chai"
import {
  EthereumAddress,
  FrostRedemptionRequestState,
  FrostRedemptionsService,
  Hex,
  isSupportedFrostRedeemerScript,
} from "../../src"
import { id, MockFrostBridge, request } from "../utils/mock-frost-bridge"

describe("FROST redemptions (K-05)", () => {
  describe("FrostRedemptionsService", () => {
    it("accepts exactly the legacy recipient script types", () => {
      const ok = [
        "76a914" + "11".repeat(20) + "88ac",
        "0014" + "11".repeat(20),
        "a914" + "11".repeat(20) + "87",
        "0020" + "11".repeat(32),
      ]
      const bad = [
        "5120" + "11".repeat(32), // P2TR (separate gated extension, D-06)
        "0014" + "11".repeat(19),
        "6a",
        "",
      ]
      ok.forEach(
        (s) => expect(isSupportedFrostRedeemerScript(Hex.from(s))).to.be.true
      )
      bad.forEach(
        (s) => expect(isSupportedFrostRedeemerScript(Hex.from(s))).to.be.false
      )
    })

    it("refuses unsafe requests before any transaction", async () => {
      const bridge = new MockFrostBridge()
      const service = new FrostRedemptionsService(bridge)
      const redeemer = EthereumAddress.from("0x" + "11".repeat(20))
      const script = Hex.from("0014" + "11".repeat(20))
      for (const [wallet, s, gross] of [
        [Hex.from("11"), script, BigNumber.from(1)],
        [id(1), Hex.from("5120" + "11".repeat(32)), BigNumber.from(1)],
        [id(1), script, BigNumber.from(0)],
        [id(1), script, BigNumber.from("2100000000000001")],
      ] as [Hex, Hex, BigNumber][]) {
        let failed = false
        try {
          await service.requestRedemption(wallet, s, gross, redeemer)
        } catch {
          failed = true
        }
        expect(failed).to.be.true
      }
      expect(bridge.calls).to.be.empty
      await service.requestRedemption(
        id(1),
        script,
        BigNumber.from(5000),
        redeemer
      )
      expect(bridge.calls.map((c) => c.name)).to.deep.equal([
        "requestRedemption",
      ])
    })

    it("never reports a reserved timed-out request as refundable", async () => {
      const bridge = new MockFrostBridge()
      const service = new FrostRedemptionsService(bridge)
      bridge.requests.set(
        id(1).toString(),
        request(1, FrostRedemptionRequestState.TimeoutPending, {
          reservationId: id(9),
          timeoutBlock: 10,
        })
      )
      bridge.requests.set(
        id(2).toString(),
        request(2, FrostRedemptionRequestState.TimeoutPending, {
          timeoutBlock: 99,
        })
      )
      bridge.requests.set(
        id(3).toString(),
        request(3, FrostRedemptionRequestState.TimeoutPending, {
          timeoutBlock: 98,
        })
      )
      bridge.requests.set(
        id(4).toString(),
        request(4, FrostRedemptionRequestState.Refundable, {
          reservationId: id(9),
        })
      )
      expect(await service.refundable(id(1))).to.be.undefined
      expect(await service.refundable(id(2))).to.be.undefined // before finality
      expect(await service.refundable(id(3))).to.equal("unreserved")
      expect(await service.refundable(id(4))).to.equal("resolved")
    })
  })
})
