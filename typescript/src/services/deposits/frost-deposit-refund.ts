import { BigNumber } from "ethers"
import * as tinysecp from "@bitcoinerlab/secp256k1"
import { Transaction } from "bitcoinjs-lib"
import { BitcoinTxHash } from "../../lib/bitcoin"
import {
  FrostDepositConstruction,
  FrostDepositTerms,
} from "../../lib/contracts"
import { Hex } from "../../lib/utils"
import {
  frostDepositOutputScript,
  frostBranchHash,
  frostDepositReceipt,
  frostLeafHash,
  frostRefundLeaf,
  frostTapTweak,
  FROST_DEPOSIT_INTERNAL_KEY,
} from "./frost-deposit"

/**
 * Sequence of the refund input: the absolute locktime is enabled and bit 31
 * stays set, so no BIP68 relative lock applies.
 */
const REFUND_SEQUENCE = 0xfffffffd

/**
 * Checks that the refund leaf belongs to these terms and that its control
 * block commits it to the deposit output key (BIP341).
 * @param terms - Deposit terms.
 * @param c - Construction to check.
 * @returns Nothing; throws on any mismatch.
 */
function checkRefundCommitment(
  terms: FrostDepositTerms,
  c: FrostDepositConstruction
): void {
  const receipt = frostDepositReceipt(terms)
  if (
    !c.receipt.equals(receipt) ||
    !c.refundLeaf.equals(frostRefundLeaf(receipt, terms))
  ) {
    throw new Error("construction does not belong to these terms")
  }
  const control = c.refundControl.toBuffer()
  if (
    control.length !== 65 ||
    (control[0] & 0xfe) !== 0xc0 ||
    !control.subarray(1, 33).equals(FROST_DEPOSIT_INTERNAL_KEY.toBuffer())
  ) {
    throw new Error("unexpected refund control block")
  }
  const root = frostBranchHash(
    frostLeafHash(c.refundLeaf),
    control.subarray(33)
  )
  const output = frostTapTweak(root)
  if (
    !output.key.equals(c.outputKey.toBuffer()) ||
    output.parity !== (control[0] & 1)
  ) {
    throw new Error("refund leaf is not committed to the deposit output")
  }
}

/**
 * Builds and signs the depositor's refund of one funded FROST deposit. It uses
 * only public construction data (from C-05 frostDepositRefundConstruction or
 * computed locally), the funding outpoint and the refund key: no operator is
 * involved. Bitcoin accepts it only once median-time-past passes the refund
 * locktime (BIP113).
 * @param terms - Deposit terms.
 * @param construction - Deposit construction for these terms.
 * @param fundingTxHash - Funding transaction hash (display byte order).
 * @param fundingOutputIndex - Funding output index.
 * @param destinationScript - Output script receiving the refund.
 * @param fee - Fee in satoshis, subtracted from the deposit amount.
 * @param refundPrivateKey - 32-byte secret of the terms' refund key.
 * @returns The signed raw transaction.
 */
export function buildFrostDepositRefund(
  terms: FrostDepositTerms,
  construction: FrostDepositConstruction,
  fundingTxHash: BitcoinTxHash,
  fundingOutputIndex: number,
  destinationScript: Hex,
  fee: BigNumber,
  refundPrivateKey: Hex
): Hex {
  const secret = refundPrivateKey.toBuffer()
  const publicKey = tinysecp.xOnlyPointFromScalar(secret)
  if (!Buffer.from(publicKey).equals(terms.refundKey.toBuffer())) {
    throw new Error("key is not the deposit refund key")
  }
  checkRefundCommitment(terms, construction)
  if (fee.lte(0) || fee.gte(terms.amount)) {
    throw new Error("refund fee outside the deposit value")
  }
  const tx = new Transaction()
  tx.version = 2
  tx.locktime = terms.refundLocktime
  tx.addInput(
    fundingTxHash.reverse().toBuffer(),
    fundingOutputIndex,
    REFUND_SEQUENCE
  )
  tx.addOutput(destinationScript.toBuffer(), terms.amount.sub(fee).toNumber())
  const digest = tx.hashForWitnessV1(
    0,
    [frostDepositOutputScript(construction).toBuffer()],
    [terms.amount.toNumber()],
    Transaction.SIGHASH_DEFAULT,
    frostLeafHash(construction.refundLeaf)
  )
  const signature = Buffer.from(tinysecp.signSchnorr(digest, secret))
  if (!tinysecp.verifySchnorr(digest, publicKey, signature)) {
    throw new Error("refund signature does not verify")
  }
  tx.setWitness(0, [
    signature,
    construction.refundLeaf.toBuffer(),
    construction.refundControl.toBuffer(),
  ])
  return Hex.from(tx.toBuffer())
}
