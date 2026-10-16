import { expect } from "chai"
import { utils } from "ethers"
import FrostBridgeABI from "../../../src/lib/ethereum/artifacts/frost/IFrostBridge.json"

// The adapter attaches this ABI to the Bridge proxy. Events are emitted by
// linked FROST libraries, so the generated ABI must carry them explicitly.
describe("EthereumFrostBridge ABI (K-05, K-06)", () => {
  const iface = new utils.Interface(FrostBridgeABI.abi)
  const functions = [
    "requestFrostRedemption",
    "frostRedemptionRequest",
    "frostReservation",
    "frostCancellationCount",
    "frostCancellationHash",
    "frostCancellationAlternative",
    "notifyFrostRedemptionTimeout",
    "refundUnreservedFrostRedemption",
    "refundResolvedFrostRedemption",
    "submitFrostRedemptionProof",
    "submitFrostCancellationProof",
    "claimFrostCancellationBudget",
    "frostDepositConstruction",
    "frostDepositRefundConstruction",
  ]
  const events = [
    "FrostRedemptionRequested",
    "FrostReservationAdmitted",
    "FrostRedemptionPaid",
    "FrostRedemptionRefunded",
    "FrostRedemptionTimeoutPending",
    "FrostCancellationAuthorized",
    "FrostCancellationConfirmed",
  ]

  it("exposes every entrypoint the adapter calls", () => {
    functions.forEach((name) =>
      expect(() => iface.getFunction(name), name).not.to.throw()
    )
  })

  it("decodes the library events the adapter filters", () => {
    events.forEach((name) =>
      expect(() => iface.getEvent(name), name).not.to.throw()
    )
  })

  it("indexes request and reservation events by wallet", () => {
    for (const name of [
      "FrostRedemptionRequested",
      "FrostReservationAdmitted",
    ]) {
      const inputs = iface.getEvent(name).inputs
      expect(inputs[0].indexed && inputs[1].indexed, name).to.be.true
      expect(inputs[1].name).to.equal("walletId")
    }
  })
})
