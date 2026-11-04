/* eslint-disable no-restricted-syntax, no-continue */
// K-09 legacy obligation ledger (tuxxy/tbtc-v2#16, K09-5; KC-SF-V3 K-09
// "keep a legacy wallet with each pending obligation across the upgrade" and
// §9.1 item 7 "reachable completion for every outstanding obligation class").
//
// An obligation class is legacy Bridge state that a later Bridge call must
// resolve. Classes are derived from the 40a11d1d Bridge source: every
// state-changing entrypoint, every Bridge storage mapping and every non-final
// wallet state must be mapped here, or `ledger.test` fails at
// `unmapped baseline ...`. Every discharge route of every class needs a
// witness case (or a recorded deferral), or it fails at
// `uncovered obligation class`.
import { execFileSync } from "child_process"
import path from "path"
import { LEGACY_BASELINE } from "../helpers/frost-legacy-baseline"

export type Route = { id: string; entrypoint: string }
export type ObligationClass = {
  id: string
  what: string
  creators: string[]
  storage: string[]
  states: string[]
  routes: Route[]
}

export const CLASSES: ObligationClass[] = [
  {
    id: "unswept-deposit",
    what: "a revealed deposit not yet swept",
    creators: ["revealDeposit", "revealDepositWithExtraData"],
    storage: ["deposits"],
    states: [],
    routes: [{ id: "deposit-sweep", entrypoint: "submitDepositSweepProof" }],
  },
  {
    id: "pending-redemption",
    what: "a pending redemption request escrowing the redeemer's balance",
    creators: ["requestRedemption", "receiveBalanceApproval"],
    storage: ["pendingRedemptions"],
    states: [],
    routes: [
      { id: "redemption-proof", entrypoint: "submitRedemptionProof" },
      { id: "redemption-timeout", entrypoint: "notifyRedemptionTimeout" },
      { id: "redemption-veto", entrypoint: "notifyRedemptionVeto" },
    ],
  },
  {
    id: "timed-out-redemption",
    what: "a timed-out request the wallet may still pay",
    creators: ["notifyRedemptionTimeout"],
    storage: ["timedOutRedemptions"],
    states: [],
    routes: [
      { id: "timed-out-redemption-proof", entrypoint: "submitRedemptionProof" },
    ],
  },
  {
    id: "moving-funds",
    what: "a MovingFunds wallet without a target commitment",
    creators: [
      "notifyWalletCloseable",
      "notifyRedemptionTimeout",
      "__ecdsaWalletHeartbeatFailedCallback",
    ],
    storage: [],
    states: ["MovingFunds"],
    routes: [
      { id: "drain-commitment", entrypoint: "submitMovingFundsCommitment" },
      { id: "moving-funds-reset", entrypoint: "resetMovingFundsTimeout" },
      { id: "moving-funds-timeout", entrypoint: "notifyMovingFundsTimeout" },
      {
        id: "moving-funds-below-dust",
        entrypoint: "notifyMovingFundsBelowDust",
      },
    ],
  },
  {
    id: "moving-funds-commitment",
    what: "a MovingFunds wallet with a legacy commitment made before the cutover",
    creators: ["submitMovingFundsCommitment"],
    storage: [],
    states: ["MovingFunds"],
    routes: [
      { id: "moving-funds-proof", entrypoint: "submitMovingFundsProof" },
      {
        id: "committed-moving-funds-timeout",
        entrypoint: "notifyMovingFundsTimeout",
      },
    ],
  },
  {
    id: "moved-funds-sweep",
    what: "a pending moved-funds sweep request on a target wallet",
    creators: ["submitMovingFundsProof"],
    storage: ["movedFundsSweepRequests"],
    states: [],
    routes: [
      {
        id: "moved-funds-sweep-proof",
        entrypoint: "submitMovedFundsSweepProof",
      },
      {
        id: "moved-funds-sweep-timeout",
        entrypoint: "notifyMovedFundsSweepTimeout",
      },
    ],
  },
  {
    id: "closing-wallet",
    what: "a Closing wallet waiting out its closing period",
    creators: [
      "submitMovingFundsProof",
      "notifyMovingFundsBelowDust",
      "notifyWalletCloseable",
    ],
    storage: [],
    states: ["Closing"],
    routes: [
      { id: "closing-elapsed", entrypoint: "notifyWalletClosingPeriodElapsed" },
    ],
  },
  {
    id: "open-fraud-challenge",
    what: "an open fraud challenge holding the challenger's ETH deposit",
    creators: ["submitFraudChallenge"],
    storage: ["fraudChallenges"],
    states: [],
    routes: [
      { id: "fraud-defeat", entrypoint: "defeatFraudChallenge" },
      {
        id: "fraud-defeat-heartbeat",
        entrypoint: "defeatFraudChallengeWithHeartbeat",
      },
      { id: "fraud-timeout", entrypoint: "notifyFraudChallengeDefeatTimeout" },
    ],
  },
  {
    id: "live-legacy-wallet",
    what: "a Live legacy wallet holding custody, which must eventually retire",
    creators: ["__ecdsaWalletCreatedCallback"],
    storage: ["registeredWallets"],
    states: ["Live"],
    routes: [
      { id: "closeable", entrypoint: "notifyWalletCloseable" },
      {
        id: "heartbeat-failed",
        entrypoint: "__ecdsaWalletHeartbeatFailedCallback",
      },
    ],
  },
  {
    id: "legacy-dkg-in-flight",
    what: "an ECDSA wallet creation requested before the drain began",
    creators: ["requestNewWallet"],
    storage: [],
    states: [],
    routes: [
      {
        id: "in-flight-registration",
        entrypoint: "__ecdsaWalletCreatedCallback",
      },
    ],
  },
]

/// Routes with no witness, each with its reason. Empty: every route of the
/// 40a11d1d Bridge has a witness in `ledger.test`.
export const DEFERRED_ROUTES: Record<string, string> = {}

/// Baseline entrypoints, storage and states that hold no obligation.
export const NOT_OBLIGATIONS: Record<string, string> = {
  initialize: "one-time initializer",
  initializeV2_FixVaultZeroDeposit: "reinitializer; repairs configuration only",
  initializeV5_RepairRebateStaking: "reinitializer; repairs configuration only",
  setVaultStatus: "governance configuration",
  setSpvMaintainerStatus: "governance configuration",
  updateDepositParameters: "governance configuration",
  updateRedemptionParameters: "governance configuration",
  updateMovingFundsParameters: "governance configuration",
  updateWalletParameters: "governance configuration",
  updateFraudParameters: "governance configuration",
  updateTreasury: "governance configuration",
  setRebateStaking: "governance configuration",
  setRedemptionWatchtower: "governance configuration",
  // Storage mappings that record facts, not owed actions.
  isVaultTrusted: "configuration",
  isSpvMaintainer: "configuration",
  spentMainUTXOs: "a record used by fraud defeat; nothing is owed on it",
  // Final wallet states.
  Unknown: "no wallet",
  Closed: "final",
  Terminated: "final: a terminated wallet owes nothing the Bridge can act on",
}

/// A 40a11d1d Bridge source file, comments removed.
function baseline(file: string) {
  const source = execFileSync(
    "git",
    ["show", `${LEGACY_BASELINE}:solidity/contracts/bridge/${file}`],
    {
      cwd: path.resolve(__dirname, "../../.."),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }
  )
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
}

/// State-changing external/public entrypoints of the 40a11d1d Bridge.
export function baselineEntrypoints(): string[] {
  const source = baseline("Bridge.sol")
  const names = new Set<string>()
  for (const m of source.matchAll(/function\s+(\w+)\s*\(([^{;]*?)[{;]/gs)) {
    const header = m[2]
    if (!/\b(external|public)\b/.test(header)) continue
    if (/\b(view|pure)\b/.test(header)) continue
    names.add(m[1])
  }
  return [...names].sort()
}

/// The mappings in the 40a11d1d BridgeState.Storage.
export function baselineMappings(): string[] {
  const source = baseline("BridgeState.sol")
  return [...source.matchAll(/mapping\([^;]*\)\s+(\w+);/g)]
    .map((m) => m[1])
    .sort()
}

/// The 40a11d1d wallet states.
export function baselineWalletStates(): string[] {
  const source = baseline("Wallets.sol")
  const body = /enum\s+WalletState\s*\{([^}]*)\}/.exec(source)
  if (!body) throw Error("WalletState enum")
  return body[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}
