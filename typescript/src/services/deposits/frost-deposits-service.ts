import { BigNumber } from "ethers"
import { Transaction, address } from "bitcoinjs-lib"
import {
  BitcoinClient,
  BitcoinNetwork,
  BitcoinRawTx,
  BitcoinTxHash,
  toBitcoinJsLibNetwork,
} from "../../lib/bitcoin"
import {
  FrostBridge,
  FrostDepositConstruction,
  FrostDepositTerms,
} from "../../lib/contracts"
import { Hex } from "../../lib/utils"
import {
  computeFrostDepositConstruction,
  frostDepositKey,
  frostDepositOutputScript,
  sameFrostDepositConstruction,
} from "./frost-deposit"
import { buildFrostDepositRefund } from "./frost-deposit-refund"

/**
 * A FROST deposit address with the data its refund needs.
 */
export interface FrostDepositAddress {
  construction: FrostDepositConstruction
  outputScript: Hex
  address: string
}

/**
 * Depositor-facing K-06 service for FROST wallets. It is separate from the
 * legacy deposit service. An address is returned only when the SDK's own D-04
 * construction equals the contract's byte for byte, and the refund needs no
 * operator: only C-05's historical refund data and the refund key.
 */
export class FrostDepositsService {
  constructor(
    private readonly bridge: FrostBridge,
    private readonly bitcoinClient?: BitcoinClient
  ) {}

  /**
   * Computes the deposit locally and compares it with C-05.
   * @param terms - Deposit terms.
   * @param walletKey - 32-byte x-only FROST wallet key Q.
   * @param network - Bitcoin network of the address.
   * @returns The address and construction.
   * @throws When the SDK and contract constructions differ.
   */
  async prepareDeposit(
    terms: FrostDepositTerms,
    walletKey: Hex,
    network: BitcoinNetwork
  ): Promise<FrostDepositAddress> {
    const local = computeFrostDepositConstruction(terms, walletKey)
    const onChain = await this.bridge.depositConstruction(terms)
    if (!sameFrostDepositConstruction(local, onChain)) {
      throw new Error("SDK and C-05 deposit constructions differ")
    }
    const outputScript = frostDepositOutputScript(local)
    return {
      construction: local,
      outputScript,
      // Encoded directly: a P2TR witness program is bech32m version 1.
      address: address.toBech32(
        local.outputKey.toBuffer(),
        1,
        toBitcoinJsLibNetwork(network).bech32
      ),
    }
  }

  /**
   * Builds the depositor refund of a revealed deposit, and broadcasts it when
   * a Bitcoin client is configured. Bitcoin accepts it only after
   * median-time-past passes the refund locktime.
   * @param terms - Deposit terms.
   * @param fundingTxHash - Funding transaction hash (display byte order).
   * @param fundingOutputIndex - Funding output index.
   * @param destinationScript - Output script receiving the refund.
   * @param fee - Fee in satoshis.
   * @param refundPrivateKey - Secret of the refund key.
   * @returns The signed transaction and its hash.
   */
  async refund(
    terms: FrostDepositTerms,
    fundingTxHash: BitcoinTxHash,
    fundingOutputIndex: number,
    destinationScript: Hex,
    fee: BigNumber,
    refundPrivateKey: Hex
  ): Promise<{ transaction: BitcoinRawTx; transactionHash: BitcoinTxHash }> {
    const key = frostDepositKey(fundingTxHash.reverse(), fundingOutputIndex)
    const construction = await this.bridge.depositRefundConstruction(key)
    const raw = buildFrostDepositRefund(
      terms,
      construction,
      fundingTxHash,
      fundingOutputIndex,
      destinationScript,
      fee,
      refundPrivateKey
    )
    const transaction: BitcoinRawTx = { transactionHex: raw.toString() }
    if (this.bitcoinClient) {
      await this.bitcoinClient.broadcast(transaction)
    }
    return {
      transaction,
      transactionHash: BitcoinTxHash.from(
        Transaction.fromHex(raw.toString()).getId()
      ),
    }
  }
}
