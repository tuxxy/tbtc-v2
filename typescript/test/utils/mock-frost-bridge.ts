import { BigNumber } from "ethers"
import {
  BitcoinRawTxVectors,
  BitcoinSpvProof,
  BitcoinTxHash,
  EthereumAddress,
  FrostBridge,
  FrostCancellationAlternative,
  FrostRedemptionRequest,
  FrostRedemptionRequestState,
  FrostReservation,
  Hex,
} from "../../src"

export const zero = Hex.from("00".repeat(32))
export const id = (n: number) => Hex.from(n.toString(16).padStart(64, "0"))

// In-memory FROST Bridge. It records calls; it is not C-04 evidence (the
// keep-core K-05 integration tests use the deployed contracts).
export class MockFrostBridge implements FrostBridge {
  block = { number: 100, timestamp: 1_000_000 }
  requests = new Map<string, FrostRedemptionRequest>()
  reservations = new Map<string, FrostReservation>()
  alternatives = new Map<string, FrostCancellationAlternative[]>()
  calls: { name: string; args: unknown[] }[] = []
  failClaim = new Set<string>()

  private record(name: string, ...args: unknown[]): Hex {
    this.calls.push({ name, args })
    return Hex.from("aa".repeat(32))
  }
  async latestBlock() {
    return this.block
  }
  async requestRedemption(...args: unknown[]) {
    return this.record("requestRedemption", ...args)
  }
  async redemptionRequest(requestId: Hex) {
    const r = this.requests.get(requestId.toString())
    if (!r) throw new Error("unknown request")
    return r
  }
  async reservation(reservationId: Hex) {
    const r = this.reservations.get(reservationId.toString())
    if (!r) throw new Error("unknown reservation")
    return r
  }
  async cancellationAlternatives(reservationId: Hex) {
    return this.alternatives.get(reservationId.toString()) ?? []
  }
  async requestIds() {
    return [...this.requests.values()].map((r) => r.requestId)
  }
  async reservationIds() {
    return [...this.reservations.values()].map((r) => r.reservationId)
  }
  async notifyTimeout(requestId: Hex) {
    return this.record("notifyTimeout", requestId)
  }
  async refundUnreserved(requestId: Hex) {
    return this.record("refundUnreserved", requestId)
  }
  async refundResolved(requestId: Hex) {
    return this.record("refundResolved", requestId)
  }
  async submitRedemptionProof(
    reservationId: Hex,
    tx: BitcoinRawTxVectors,
    proof: BitcoinSpvProof
  ) {
    return this.record("submitRedemptionProof", reservationId, tx, proof)
  }
  async submitCancellationProof(
    reservationId: Hex,
    tx: BitcoinRawTxVectors,
    proof: BitcoinSpvProof
  ) {
    return this.record("submitCancellationProof", reservationId, tx, proof)
  }
  async claimCancellationBudget(reservationId: Hex, hash: BitcoinTxHash) {
    if (this.failClaim.has(hash.toString())) throw new Error("winner")
    return this.record("claimCancellationBudget", reservationId, hash)
  }
}

export function request(
  n: number,
  state: FrostRedemptionRequestState,
  overrides: Partial<FrostRedemptionRequest> = {}
): FrostRedemptionRequest {
  return {
    requestId: id(n),
    walletId: id(0x77),
    descriptorHash: id(0x78),
    reservationId: zero,
    redeemer: EthereumAddress.from("0x" + "11".repeat(20)),
    gross: BigNumber.from(50_000),
    treasuryFee: BigNumber.from(500),
    maximumBitcoinFee: BigNumber.from(2000),
    deadline: 1_000_000,
    finalityBlocks: 2,
    timeoutBlock: 0,
    state,
    redeemerOutputScript: Hex.from("0014" + "11".repeat(20)),
    ...overrides,
  }
}

// Installs the legacy redemption proof fixture as a confirmed transaction.
