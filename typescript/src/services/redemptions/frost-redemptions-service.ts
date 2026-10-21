import { BigNumber } from "ethers"
import {
  ChainIdentifier,
  FrostBridge,
  FrostRedemptionRequest,
  FrostRedemptionRequestState,
} from "../../lib/contracts"
import { Hex } from "../../lib/utils"

/**
 * Recipient script types the C-04 profile accepts (D-06: the existing legacy
 * recipient set). P2TR recipients are a separate gated extension.
 * @param script - Redeemer output script.
 * @returns True for P2PKH, P2WPKH, P2SH and P2WSH.
 */
export function isSupportedFrostRedeemerScript(script: Hex): boolean {
  const b = script.toBuffer()
  const p2pkh =
    b.length === 25 &&
    b[0] === 0x76 &&
    b[1] === 0xa9 &&
    b[2] === 0x14 &&
    b[23] === 0x88 &&
    b[24] === 0xac
  const p2wpkh = b.length === 22 && b[0] === 0x00 && b[1] === 0x14
  const p2sh =
    b.length === 23 && b[0] === 0xa9 && b[1] === 0x14 && b[22] === 0x87
  const p2wsh = b.length === 34 && b[0] === 0x00 && b[1] === 0x20
  return p2pkh || p2wpkh || p2sh || p2wsh
}

/**
 * Which refund a request can take now, if any. A reserved request that timed
 * out is never refundable here: it waits for a proven payment or cancellation.
 */
export type FrostRefundKind = "unreserved" | "resolved"

/**
 * Redeemer-facing K-05 service for FROST wallets. It is separate from the
 * legacy ECDSA redemption service and never touches legacy requests (D-08).
 */
export class FrostRedemptionsService {
  constructor(private readonly bridge: FrostBridge) {}

  /**
   * Requests a redemption from a FROST wallet. The Bank balance must already be
   * approved for the Bridge. Refuses unsupported or wallet-owned scripts and a
   * non-positive amount before any transaction.
   * @param walletId - 32-byte FROST wallet ID.
   * @param redeemerOutputScript - Bitcoin script receiving the payout.
   * @param gross - Requested amount in satoshis (Bank balance).
   * @param redeemer - Ethereum address refunded on a proven cancellation.
   * @returns The Ethereum transaction hash.
   */
  async requestRedemption(
    walletId: Hex,
    redeemerOutputScript: Hex,
    gross: BigNumber,
    redeemer: ChainIdentifier
  ): Promise<Hex> {
    if (walletId.toBuffer().length !== 32) {
      throw new Error("FROST wallet ID must be 32 bytes")
    }
    if (!isSupportedFrostRedeemerScript(redeemerOutputScript)) {
      throw new Error("unsupported FROST redeemer output script")
    }
    if (gross.lte(0) || gross.gt(BigNumber.from("2100000000000000"))) {
      throw new Error("redemption amount outside the satoshi domain")
    }
    return this.bridge.requestRedemption(
      walletId,
      redeemerOutputScript,
      gross,
      redeemer
    )
  }

  /**
   * @param requestId - Request ID.
   * @returns The request with its captured terms and state.
   */
  async getRedemptionRequest(requestId: Hex): Promise<FrostRedemptionRequest> {
    return this.bridge.redemptionRequest(requestId)
  }

  /**
   * @param requestId - Request ID.
   * @returns The refund the request can take at the current block, or
   *          undefined.
   */
  async refundable(requestId: Hex): Promise<FrostRefundKind | undefined> {
    const [r, block] = await Promise.all([
      this.bridge.redemptionRequest(requestId),
      this.bridge.latestBlock(),
    ])
    if (r.state === FrostRedemptionRequestState.Refundable) {
      return "resolved"
    }
    if (
      r.state === FrostRedemptionRequestState.TimeoutPending &&
      r.reservationId.toBuffer().every((b) => b === 0) &&
      block.number >= r.timeoutBlock + r.finalityBlocks
    ) {
      return "unreserved"
    }
    return undefined
  }
}
