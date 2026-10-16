import { BigNumber } from "ethers"
import { BitcoinRawTxVectors, BitcoinSpvProof, BitcoinTxHash } from "../bitcoin"
import { Hex } from "../utils"
import { ChainIdentifier } from "./chain-identifier"

/* eslint-disable no-unused-vars */
/**
 * C-04 FROST redemption request states (FrostRedemptionLedger.RequestState).
 */
export enum FrostRedemptionRequestState {
  Unknown = 0,
  Requested = 1,
  Reserved = 2,
  TimeoutPending = 3,
  Paid = 4,
  Refunded = 5,
  Refundable = 6,
}

/**
 * C-04 FROST reservation (intent) states (FrostRedemptionLedger.IntentState).
 */
export enum FrostReservationState {
  Unknown = 0,
  Reserved = 1,
  Paid = 2,
  Cancelled = 3,
  TimeoutPending = 4,
  Quarantined = 5,
  ConflictResolved = 6,
}
/* eslint-enable no-unused-vars */

/**
 * Reports whether a payment or cancellation proof may still settle the
 * reservation.
 * @param state - Reservation state.
 * @returns True for Reserved, TimeoutPending and Quarantined.
 */
export function isFrostReservationUnresolved(
  state: FrostReservationState
): boolean {
  return (
    state === FrostReservationState.Reserved ||
    state === FrostReservationState.TimeoutPending ||
    state === FrostReservationState.Quarantined
  )
}

/**
 * A funded FROST redemption request with its captured terms.
 */
export interface FrostRedemptionRequest {
  requestId: Hex
  walletId: Hex
  descriptorHash: Hex
  /**
   * Zero when the request is not reserved.
   */
  reservationId: Hex
  redeemer: ChainIdentifier
  gross: BigNumber
  treasuryFee: BigNumber
  maximumBitcoinFee: BigNumber
  /**
   * Unix timestamp (seconds) of the request deadline.
   */
  deadline: number
  finalityBlocks: number
  timeoutBlock: number
  state: FrostRedemptionRequestState
  redeemerOutputScript: Hex
}

/**
 * An admitted FROST reservation. The transaction hash is in Bitcoin explorer
 * (display) byte order, like every {@link BitcoinTxHash}.
 */
export interface FrostReservation {
  reservationId: Hex
  walletId: Hex
  transactionHash: BitcoinTxHash
  admittedBlock: number
  state: FrostReservationState
  requestIds: Hex[]
  payouts: BigNumber[]
}

/**
 * One admitted cancellation alternative of a reservation.
 */
export interface FrostCancellationAlternative {
  transactionHash: BitcoinTxHash
  fee: BigNumber
  sponsor: ChainIdentifier
  admittedBlock: number
  budgetSettled: boolean
}

/**
 * Terms of one FROST deposit, as C-05 FrostDepositProfile.Terms. The template
 * is the proposed D-04 NUMS two-leaf profile (owner decision D-04 OPEN).
 */
export interface FrostDepositTerms {
  chainId: BigNumber
  /** 20-byte Bridge address. */
  bridge: Hex
  bitcoinGenesis: Hex
  fullWalletId: Hex
  descriptorHash: Hex
  /** 20-byte depositor address. */
  depositor: Hex
  /** 20-byte vault address, zero for none. */
  vault: Hex
  /** 8 bytes. */
  blinding: Hex
  /** Satoshis. */
  amount: BigNumber
  /** 32-byte x-only refund public key. */
  refundKey: Hex
  /** Unix timestamp (seconds) checked against Bitcoin median-time-past. */
  refundLocktime: number
  extraData: Hex
}

/**
 * Complete Bitcoin data of one deposit; equal to C-05
 * FrostDepositAdmission.Construction.
 */
export interface FrostDepositConstruction {
  outputKey: Hex
  root: Hex
  parity: number
  receipt: Hex
  walletLeaf: Hex
  refundLeaf: Hex
  walletControl: Hex
  refundControl: Hex
}

/**
 * Interface for the inactive C-04 FROST redemption entrypoints of the Bridge.
 * Every write is permissionless except where the contract requires an SPV
 * maintainer (inclusion proofs).
 */
export interface FrostBridge {
  /**
   * @returns The current block number and its timestamp (seconds).
   */
  latestBlock(): Promise<{ number: number; timestamp: number }>

  requestRedemption(
    walletId: Hex,
    redeemerOutputScript: Hex,
    gross: BigNumber,
    redeemer: ChainIdentifier
  ): Promise<Hex>

  redemptionRequest(requestId: Hex): Promise<FrostRedemptionRequest>

  reservation(reservationId: Hex): Promise<FrostReservation>

  cancellationAlternatives(
    reservationId: Hex
  ): Promise<FrostCancellationAlternative[]>

  /**
   * Request IDs of a wallet from FrostRedemptionRequested events, oldest first.
   */
  requestIds(walletId: Hex, fromBlock?: number): Promise<Hex[]>

  /**
   * Reservation IDs of a wallet from FrostReservationAdmitted events.
   */
  reservationIds(walletId: Hex, fromBlock?: number): Promise<Hex[]>

  notifyTimeout(requestId: Hex): Promise<Hex>

  refundUnreserved(requestId: Hex): Promise<Hex>

  refundResolved(requestId: Hex): Promise<Hex>

  submitRedemptionProof(
    reservationId: Hex,
    transaction: BitcoinRawTxVectors,
    proof: BitcoinSpvProof
  ): Promise<Hex>

  submitCancellationProof(
    reservationId: Hex,
    transaction: BitcoinRawTxVectors,
    proof: BitcoinSpvProof
  ): Promise<Hex>

  claimCancellationBudget(
    reservationId: Hex,
    transactionHash: BitcoinTxHash
  ): Promise<Hex>
}
