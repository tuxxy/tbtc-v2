import {
  BigNumber,
  Contract,
  ContractTransaction,
  Signer,
  providers,
} from "ethers"
import { BitcoinRawTxVectors, BitcoinSpvProof, BitcoinTxHash } from "../bitcoin"
import {
  FrostBridge,
  FrostCancellationAlternative,
  FrostRedemptionRequest,
  FrostRedemptionRequestState,
  FrostReservation,
  FrostReservationState,
  ChainIdentifier,
} from "../contracts"
import { Hex } from "../utils"
import { EthersTransactionUtils } from "./adapter"
import { EthereumAddress } from "./address"

import FrostBridgeABI from "./artifacts/frost/IFrostBridge.json"

/**
 * Explicit configuration of the inactive FROST Bridge entrypoints. FROST is not
 * deployed by default, so the Bridge proxy address is always required.
 */
export interface EthereumFrostBridgeConfig {
  address: string
  signerOrProvider: Signer | providers.Provider
  /**
   * First block scanned for wallet events (the Bridge or wallet funding block).
   */
  deployedAtBlockNumber?: number
  totalRetryAttempts?: number
}

// Bitcoin hashes are stored on chain in internal byte order.
const internal = (h: BitcoinTxHash): string => h.reverse().toPrefixedString()
const display = (raw: string): BitcoinTxHash =>
  BitcoinTxHash.from(Hex.from(raw).reverse().toString())

function txParam(tx: BitcoinRawTxVectors) {
  return {
    version: tx.version.toPrefixedString(),
    inputVector: tx.inputs.toPrefixedString(),
    outputVector: tx.outputs.toPrefixedString(),
    locktime: tx.locktime.toPrefixedString(),
  }
}

function proofParam(proof: BitcoinSpvProof) {
  return {
    merkleProof: proof.merkleProof.toPrefixedString(),
    txIndexInBlock: proof.txIndexInBlock,
    bitcoinHeaders: proof.bitcoinHeaders.toPrefixedString(),
    coinbasePreimage: proof.coinbasePreimage.toPrefixedString(),
    coinbaseProof: proof.coinbaseProof.toPrefixedString(),
  }
}

/**
 * Ethereum implementation of the C-04 FROST redemption entrypoints, attached
 * to the Bridge proxy with the IFrostBridge ABI plus library events.
 * @see {FrostBridge} for reference.
 */
export class EthereumFrostBridge implements FrostBridge {
  private readonly _instance: Contract
  private readonly _fromBlock: number
  private readonly _retries: number

  constructor(config: EthereumFrostBridgeConfig) {
    this._instance = new Contract(
      config.address,
      FrostBridgeABI.abi,
      config.signerOrProvider
    )
    this._fromBlock = config.deployedAtBlockNumber ?? 0
    this._retries = config.totalRetryAttempts ?? 3
  }

  private async send(fn: () => Promise<ContractTransaction>): Promise<Hex> {
    const tx = await EthersTransactionUtils.sendWithRetry<ContractTransaction>(
      fn,
      this._retries
    )
    return Hex.from(tx.hash)
  }

  async latestBlock(): Promise<{ number: number; timestamp: number }> {
    const block = await this._instance.provider.getBlock("latest")
    return { number: block.number, timestamp: block.timestamp }
  }

  async requestRedemption(
    walletId: Hex,
    redeemerOutputScript: Hex,
    gross: BigNumber,
    redeemer: ChainIdentifier
  ): Promise<Hex> {
    return this.send(() =>
      this._instance.requestFrostRedemption(
        walletId.toPrefixedString(),
        redeemerOutputScript.toPrefixedString(),
        gross,
        `0x${redeemer.identifierHex}`
      )
    )
  }

  async redemptionRequest(requestId: Hex): Promise<FrostRedemptionRequest> {
    const id = requestId.toPrefixedString()
    const r = await this._instance.frostRedemptionRequest(id)
    return {
      requestId,
      walletId: Hex.from(r.walletId),
      descriptorHash: Hex.from(r.descriptorHash),
      reservationId: Hex.from(r.reservationId),
      redeemer: EthereumAddress.from(r.redeemer),
      gross: BigNumber.from(r.gross),
      treasuryFee: BigNumber.from(r.treasuryFee),
      maximumBitcoinFee: BigNumber.from(r.maximumBitcoinFee),
      deadline: BigNumber.from(r.deadline).toNumber(),
      finalityBlocks: BigNumber.from(r.finalityBlocks).toNumber(),
      timeoutBlock: BigNumber.from(r.timeoutBlock).toNumber(),
      state: r.state as FrostRedemptionRequestState,
      redeemerOutputScript: Hex.from(r.script),
    }
  }

  async reservation(reservationId: Hex): Promise<FrostReservation> {
    const r = await this._instance.frostReservation(
      reservationId.toPrefixedString()
    )
    return {
      reservationId,
      walletId: Hex.from(r.certificate.walletId),
      transactionHash: display(r.transactionHash),
      admittedBlock: BigNumber.from(r.admittedBlock).toNumber(),
      state: r.state as FrostReservationState,
      requestIds: r.requestIds.map((id: string) => Hex.from(id)),
      payouts: r.payouts.map((p: BigNumber) => BigNumber.from(p)),
    }
  }

  async cancellationAlternatives(
    reservationId: Hex
  ): Promise<FrostCancellationAlternative[]> {
    const id = reservationId.toPrefixedString()
    const count = BigNumber.from(
      await this._instance.frostCancellationCount(id)
    ).toNumber()
    const out: FrostCancellationAlternative[] = []
    for (let i = 0; i < count; i++) {
      // eslint-disable-next-line no-await-in-loop
      const hash = await this._instance.frostCancellationHash(id, i)
      // eslint-disable-next-line no-await-in-loop
      const r = await this._instance.frostCancellationAlternative(id, hash)
      out.push({
        transactionHash: display(r.transactionHash),
        fee: BigNumber.from(r.fee),
        sponsor: EthereumAddress.from(r.sponsor),
        admittedBlock: BigNumber.from(r.admittedBlock).toNumber(),
        budgetSettled: r.budgetSettled,
      })
    }
    return out
  }

  private async events(
    name: string,
    topics: (string | null)[],
    fromBlock?: number
  ): Promise<providers.Log[]> {
    const filter = this._instance.filters[name](...topics)
    const logs = await this._instance.queryFilter(
      filter,
      fromBlock ?? this._fromBlock
    )
    return logs.filter((l) => !l.removed)
  }

  async requestIds(walletId: Hex, fromBlock?: number): Promise<Hex[]> {
    const logs = await this.events(
      "FrostRedemptionRequested",
      [null, walletId.toPrefixedString()],
      fromBlock
    )
    return logs.map((l) => Hex.from(l.topics[1]))
  }

  async reservationIds(walletId: Hex, fromBlock?: number): Promise<Hex[]> {
    const logs = await this.events(
      "FrostReservationAdmitted",
      [null, walletId.toPrefixedString()],
      fromBlock
    )
    return logs.map((l) => Hex.from(l.topics[1]))
  }

  async notifyTimeout(requestId: Hex): Promise<Hex> {
    return this.send(() =>
      this._instance.notifyFrostRedemptionTimeout(requestId.toPrefixedString())
    )
  }

  async refundUnreserved(requestId: Hex): Promise<Hex> {
    return this.send(() =>
      this._instance.refundUnreservedFrostRedemption(
        requestId.toPrefixedString()
      )
    )
  }

  async refundResolved(requestId: Hex): Promise<Hex> {
    return this.send(() =>
      this._instance.refundResolvedFrostRedemption(requestId.toPrefixedString())
    )
  }

  async submitRedemptionProof(
    reservationId: Hex,
    transaction: BitcoinRawTxVectors,
    proof: BitcoinSpvProof
  ): Promise<Hex> {
    return this.send(() =>
      this._instance.submitFrostRedemptionProof(
        reservationId.toPrefixedString(),
        txParam(transaction),
        proofParam(proof)
      )
    )
  }

  async submitCancellationProof(
    reservationId: Hex,
    transaction: BitcoinRawTxVectors,
    proof: BitcoinSpvProof
  ): Promise<Hex> {
    return this.send(() =>
      this._instance.submitFrostCancellationProof(
        reservationId.toPrefixedString(),
        txParam(transaction),
        proofParam(proof)
      )
    )
  }

  async claimCancellationBudget(
    reservationId: Hex,
    transactionHash: BitcoinTxHash
  ): Promise<Hex> {
    return this.send(() =>
      this._instance.claimFrostCancellationBudget(
        reservationId.toPrefixedString(),
        internal(transactionHash)
      )
    )
  }
}
