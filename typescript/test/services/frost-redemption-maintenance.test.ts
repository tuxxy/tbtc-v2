import { BigNumber } from "ethers"
import { expect } from "chai"
import {
  BitcoinHashUtils,
  BitcoinRawTx,
  BitcoinRawTxVectors,
  BitcoinTx,
  BitcoinTxHash,
  BitcoinTxMerkleBranch,
  EthereumAddress,
  FrostCancellationAlternative,
  FrostRedemptionMaintenance,
  FrostRedemptionRequestState,
  FrostReservationState,
  Hex,
} from "../../src"
import { MockBitcoinClient } from "../utils/mock-bitcoin-client"
import { redemptionProof } from "../data/redemption"
import { id, MockFrostBridge, request } from "../utils/mock-frost-bridge"

function proofClient(): { client: MockBitcoinClient; hash: BitcoinTxHash } {
  const client = new MockBitcoinClient()
  const data = redemptionProof.bitcoinChainData
  const hash = data.transaction.transactionHash
  const transactions = new Map<string, BitcoinTx>()
  transactions.set(hash.toString(), data.transaction)
  client.transactions = transactions
  const raw = new Map<string, BitcoinRawTx>()
  raw.set(hash.toString(), data.rawTransaction)
  client.latestHeight = data.latestBlockHeight
  client.headersChain = data.headersChain
  const height = data.latestBlockHeight - data.accumulatedTxConfirmations + 1
  const merkle = new Map<string, BitcoinTxMerkleBranch>()
  merkle.set(
    `${hash.toString()}${height.toString(16)}`,
    data.transactionMerkleBranch
  )
  const confirmations = new Map<string, number>()
  confirmations.set(hash.toString(), data.accumulatedTxConfirmations)
  client.confirmations = confirmations
  const coinbase = BitcoinTxHash.from(
    BitcoinHashUtils.computeHash256(
      Hex.from(data.coinbaseRawTransaction.transactionHex)
    ).toString()
  )
  const coinbaseHashes = new Map<number, BitcoinTxHash>()
  coinbaseHashes.set(height, coinbase)
  client.coinbaseHashes = coinbaseHashes
  raw.set(coinbase.toString(), data.coinbaseRawTransaction)
  client.rawTransactions = raw
  merkle.set(
    `${coinbase.toString()}${height.toString(16)}`,
    data.coinbaseMerkleBranch
  )
  client.transactionMerkle = merkle
  return { client, hash }
}

describe("FROST redemption maintenance (K-05)", () => {
  describe("FrostRedemptionMaintenance", () => {
    it("proves the admitted payment with its exact transaction", async () => {
      const { client, hash } = proofClient()
      const bridge = new MockFrostBridge()
      bridge.reservations.set(id(5).toString(), {
        reservationId: id(5),
        walletId: id(0x77),
        transactionHash: hash,
        admittedBlock: 90,
        state: FrostReservationState.TimeoutPending,
        requestIds: [id(1)],
        payouts: [BigNumber.from(1)],
      })
      const m = new FrostRedemptionMaintenance(bridge, client, 1)
      const action = await m.proveSettlement(id(5))
      expect(action?.kind).to.equal("payment-proof")
      expect(bridge.calls[0].name).to.equal("submitRedemptionProof")
      const tx = bridge.calls[0].args[1] as BitcoinRawTxVectors
      expect(tx).to.deep.equal(
        redemptionProof.expectedRedemptionProof.redemptionTx
      )
    })

    it("proves a confirmed cancellation alternative when the payment is absent", async () => {
      const { client, hash } = proofClient()
      const bridge = new MockFrostBridge()
      bridge.reservations.set(id(5).toString(), {
        reservationId: id(5),
        walletId: id(0x77),
        transactionHash: BitcoinTxHash.from("22".repeat(32)),
        admittedBlock: 90,
        state: FrostReservationState.Quarantined,
        requestIds: [id(1)],
        payouts: [BigNumber.from(1)],
      })
      bridge.alternatives.set(id(5).toString(), [
        {
          transactionHash: BitcoinTxHash.from("33".repeat(32)),
          fee: BigNumber.from(1000),
          sponsor: EthereumAddress.from("0x" + "22".repeat(20)),
          admittedBlock: 95,
          budgetSettled: false,
        },
        {
          transactionHash: hash,
          fee: BigNumber.from(1500),
          sponsor: EthereumAddress.from("0x" + "22".repeat(20)),
          admittedBlock: 96,
          budgetSettled: false,
        },
      ])
      const m = new FrostRedemptionMaintenance(bridge, client, 1)
      const action = await m.proveSettlement(id(5))
      expect(action?.kind).to.equal("cancellation-proof")
      expect(action?.transactionHash?.toString()).to.equal(hash.toString())
      expect(bridge.calls.map((c) => c.name)).to.deep.equal([
        "submitCancellationProof",
      ])
    })

    it("does nothing for settled reservations or unconfirmed transactions", async () => {
      const bridge = new MockFrostBridge()
      const m = new FrostRedemptionMaintenance(
        bridge,
        new MockBitcoinClient(),
        1
      )
      bridge.reservations.set(id(5).toString(), {
        reservationId: id(5),
        walletId: id(0x77),
        transactionHash: BitcoinTxHash.from("22".repeat(32)),
        admittedBlock: 90,
        state: FrostReservationState.Reserved,
        requestIds: [],
        payouts: [],
      })
      expect(await m.proveSettlement(id(5))).to.be.undefined
      bridge.reservations.get(id(5).toString())!.state =
        FrostReservationState.Paid
      expect(await m.proveSettlement(id(5))).to.be.undefined
      expect(bridge.calls).to.be.empty
    })

    it("notifies timeouts and refunds only unreserved or resolved requests", async () => {
      const bridge = new MockFrostBridge()
      const m = new FrostRedemptionMaintenance(
        bridge,
        new MockBitcoinClient(),
        1
      )
      bridge.requests.set(
        id(1).toString(),
        request(1, FrostRedemptionRequestState.Requested, { deadline: 999_999 })
      )
      bridge.requests.set(
        id(2).toString(),
        request(2, FrostRedemptionRequestState.Reserved, {
          reservationId: id(9),
        })
      )
      bridge.requests.set(
        id(3).toString(),
        request(3, FrostRedemptionRequestState.TimeoutPending, {
          reservationId: id(9),
          timeoutBlock: 1,
        })
      )
      bridge.requests.set(
        id(4).toString(),
        request(4, FrostRedemptionRequestState.TimeoutPending, {
          timeoutBlock: 99,
        })
      )
      bridge.requests.set(
        id(5).toString(),
        request(5, FrostRedemptionRequestState.TimeoutPending, {
          timeoutBlock: 98,
        })
      )
      bridge.requests.set(
        id(6).toString(),
        request(6, FrostRedemptionRequestState.Refundable, {
          reservationId: id(9),
        })
      )
      bridge.requests.set(
        id(7).toString(),
        request(7, FrostRedemptionRequestState.Requested, {
          deadline: 1_000_001,
        })
      )
      const kinds = []
      for (let n = 1; n <= 7; n++) {
        // eslint-disable-next-line no-await-in-loop
        kinds.push((await m.processRequest(id(n)))?.kind)
      }
      expect(kinds).to.deep.equal([
        "timeout",
        "timeout",
        undefined, // reserved TimeoutPending waits for a settlement proof
        undefined, // unreserved, before its finality boundary
        "unreserved-refund",
        "resolved-refund",
        undefined, // before the deadline
      ])
    })

    it("claims only unused budgets of terminal reservations", async () => {
      const bridge = new MockFrostBridge()
      const m = new FrostRedemptionMaintenance(
        bridge,
        new MockBitcoinClient(),
        1
      )
      const alt = (
        b: string,
        settled: boolean
      ): FrostCancellationAlternative => ({
        transactionHash: BitcoinTxHash.from(b.repeat(32)),
        fee: BigNumber.from(1),
        sponsor: EthereumAddress.from("0x" + "22".repeat(20)),
        admittedBlock: 1,
        budgetSettled: settled,
      })
      bridge.reservations.set(id(5).toString(), {
        reservationId: id(5),
        walletId: id(0x77),
        transactionHash: BitcoinTxHash.from("22".repeat(32)),
        admittedBlock: 90,
        state: FrostReservationState.TimeoutPending,
        requestIds: [],
        payouts: [],
      })
      bridge.alternatives.set(id(5).toString(), [
        alt("33", false),
        alt("44", true),
        alt("55", false),
      ])
      bridge.failClaim.add("55".repeat(32))
      expect(await m.claimBudgets(id(5))).to.be.empty
      bridge.reservations.get(id(5).toString())!.state =
        FrostReservationState.Cancelled
      const claims = await m.claimBudgets(id(5))
      expect(claims.map((c) => c.transactionHash?.toString())).to.deep.equal([
        "33".repeat(32),
      ])
    })

    it("rejects a zero confirmation requirement", () => {
      expect(
        () =>
          new FrostRedemptionMaintenance(
            new MockFrostBridge(),
            new MockBitcoinClient(),
            0
          )
      ).to.throw()
    })
  })
})
