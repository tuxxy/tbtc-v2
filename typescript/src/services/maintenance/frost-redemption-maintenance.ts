import {
  assembleBitcoinSpvProof,
  BitcoinClient,
  BitcoinTxHash,
  extractBitcoinRawTxVectors,
} from "../../lib/bitcoin"
import {
  FrostBridge,
  FrostRedemptionRequestState,
  isFrostReservationUnresolved,
} from "../../lib/contracts"
import { Hex } from "../../lib/utils"

/**
 * One maintainer transaction submitted by {@link FrostRedemptionMaintenance}.
 */
export interface FrostMaintenanceAction {
  kind:
    | "payment-proof"
    | "cancellation-proof"
    | "timeout"
    | "unreserved-refund"
    | "resolved-refund"
    | "budget-claim"
  id: Hex
  transactionHash?: BitcoinTxHash
}

const isZero = (h: Hex) => h.toBuffer().every((b) => b === 0)

/**
 * Permissionless K-05 maintenance for one FROST wallet: inclusion proofs,
 * timeout notices, refunds and cancellation budget returns. Transactions are
 * identified by their admitted hash, never by a HASH160 of a wallet key.
 */
export class FrostRedemptionMaintenance {
  constructor(
    private readonly bridge: FrostBridge,
    private readonly bitcoinClient: BitcoinClient,
    private readonly confirmations: number
  ) {
    if (confirmations <= 0) {
      throw new Error("confirmations must be positive")
    }
  }

  private async confirmed(hash: BitcoinTxHash): Promise<boolean> {
    try {
      return (
        (await this.bitcoinClient.getTransactionConfirmations(hash)) >=
        this.confirmations
      )
    } catch {
      return false
    }
  }

  private async proof(hash: BitcoinTxHash) {
    const proof = await assembleBitcoinSpvProof(
      hash,
      this.confirmations,
      this.bitcoinClient
    )
    const raw = await this.bitcoinClient.getRawTransaction(hash)
    return { vectors: extractBitcoinRawTxVectors(raw), proof }
  }

  /**
   * Proves the payment, or else a confirmed admitted cancellation alternative,
   * of one unresolved reservation. At most one of them can be confirmed on
   * Bitcoin because they share the reserved conflict input.
   * @param reservationId - Reservation ID.
   * @returns The submitted action, or undefined when nothing is provable.
   */
  async proveSettlement(
    reservationId: Hex
  ): Promise<FrostMaintenanceAction | undefined> {
    const reservation = await this.bridge.reservation(reservationId)
    if (!isFrostReservationUnresolved(reservation.state)) {
      return undefined
    }
    if (await this.confirmed(reservation.transactionHash)) {
      const { vectors, proof } = await this.proof(reservation.transactionHash)
      await this.bridge.submitRedemptionProof(reservationId, vectors, proof)
      return {
        kind: "payment-proof",
        id: reservationId,
        transactionHash: reservation.transactionHash,
      }
    }
    for (const alternative of await this.bridge.cancellationAlternatives(
      reservationId
    )) {
      // eslint-disable-next-line no-await-in-loop
      if (await this.confirmed(alternative.transactionHash)) {
        // eslint-disable-next-line no-await-in-loop
        const { vectors, proof } = await this.proof(alternative.transactionHash)
        // eslint-disable-next-line no-await-in-loop
        await this.bridge.submitCancellationProof(reservationId, vectors, proof)
        return {
          kind: "cancellation-proof",
          id: reservationId,
          transactionHash: alternative.transactionHash,
        }
      }
    }
    return undefined
  }

  /**
   * Notifies a due timeout, refunds an unreserved timed-out request after its
   * captured finality boundary, or collects a proof-resolved refund. A reserved
   * timed-out request is never refunded: it waits for a settlement proof.
   * @param requestId - Request ID.
   * @returns The submitted action, or undefined.
   */
  async processRequest(
    requestId: Hex
  ): Promise<FrostMaintenanceAction | undefined> {
    const [r, block] = await Promise.all([
      this.bridge.redemptionRequest(requestId),
      this.bridge.latestBlock(),
    ])
    if (
      (r.state === FrostRedemptionRequestState.Requested ||
        r.state === FrostRedemptionRequestState.Reserved) &&
      block.timestamp >= r.deadline
    ) {
      await this.bridge.notifyTimeout(requestId)
      return { kind: "timeout", id: requestId }
    }
    if (
      r.state === FrostRedemptionRequestState.TimeoutPending &&
      isZero(r.reservationId) &&
      block.number >= r.timeoutBlock + r.finalityBlocks
    ) {
      await this.bridge.refundUnreserved(requestId)
      return { kind: "unreserved-refund", id: requestId }
    }
    if (r.state === FrostRedemptionRequestState.Refundable) {
      await this.bridge.refundResolved(requestId)
      return { kind: "resolved-refund", id: requestId }
    }
    return undefined
  }

  /**
   * Returns every unused cancellation budget of a terminal reservation. The
   * contract refuses the burned winning budget.
   * @param reservationId - Reservation ID.
   * @returns The submitted claims.
   */
  async claimBudgets(reservationId: Hex): Promise<FrostMaintenanceAction[]> {
    const reservation = await this.bridge.reservation(reservationId)
    if (isFrostReservationUnresolved(reservation.state)) {
      return []
    }
    const out: FrostMaintenanceAction[] = []
    for (const alternative of await this.bridge.cancellationAlternatives(
      reservationId
    )) {
      if (alternative.budgetSettled) continue
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.bridge.claimCancellationBudget(
          reservationId,
          alternative.transactionHash
        )
        out.push({
          kind: "budget-claim",
          id: reservationId,
          transactionHash: alternative.transactionHash,
        })
      } catch {
        // The winning budget is burned, not claimable.
      }
    }
    return out
  }

  /**
   * Runs every maintenance step for one wallet.
   * @param walletId - 32-byte FROST wallet ID.
   * @param fromBlock - Optional first block for event scans.
   * @returns Every submitted action.
   */
  async maintain(
    walletId: Hex,
    fromBlock?: number
  ): Promise<FrostMaintenanceAction[]> {
    const actions: FrostMaintenanceAction[] = []
    const reservations = await this.bridge.reservationIds(walletId, fromBlock)
    for (const id of reservations) {
      // eslint-disable-next-line no-await-in-loop
      const proved = await this.proveSettlement(id)
      if (proved) actions.push(proved)
    }
    for (const id of await this.bridge.requestIds(walletId, fromBlock)) {
      // eslint-disable-next-line no-await-in-loop
      const action = await this.processRequest(id)
      if (action) actions.push(action)
    }
    for (const id of reservations) {
      // eslint-disable-next-line no-await-in-loop
      actions.push(...(await this.claimBudgets(id)))
    }
    return actions
  }
}
