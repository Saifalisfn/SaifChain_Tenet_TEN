'use strict';

/**
 * tokenomics/airdrop.js
 * Airdrop eligibility scoring for Tenet Amoy testnet participants.
 *
 * ── Scoring ─────────────────────────────────────────────────────────────────
 *   txScore        = min(txCount × 1,        100)   max 100 pts
 *   recipientScore = min(uniqueRecipients × 5, 50)   max  50 pts
 *   volumeScore    = min(volumeTEN / 2000,     50)   max  50 pts
 *   uptimeScore    = min(validatorUptimePct,   100)  max 100 pts  (validators only)
 *   earlyBonus     = +10 pts if active before testnet day 30
 *   ──────────────────────────────────────────────────────────────
 *   Max possible score: 310 pts
 *
 * ── Anti-Sybil gates (must pass ALL to be eligible) ─────────────────────────
 *   • activeDays   ≥ 7 days (first→last tx span)
 *   • txCount      ≥ 3 unique transactions sent
 *   • uniqueRecipients ≥ 2 different destination addresses
 *
 * ── Allocation tiers (from 125M community airdrop pool) ─────────────────────
 *   Diamond (≥ 250 pts):  50,000 TEN
 *   Gold    (≥ 150 pts):  20,000 TEN
 *   Silver  (≥  75 pts):   5,000 TEN
 *   Bronze  (≥  25 pts):   1,000 TEN
 *   Ineligible (<25 pts or fails gate): 0 TEN
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   const { computeScore, processAirdrop } = require('./tokenomics/airdrop');
 *
 *   const result = computeScore({
 *     txCount: 150, uniqueRecipients: 12, volumeTEN: 5000,
 *     activeDays: 30, validatorUptimePct: 95, earlyAdopter: true,
 *   });
 *   // → { score: 310, tier: { name:'Diamond', amount:50000 }, eligible: true }
 *
 *   const report = processAirdrop(walletActivityArray);
 *   // → { distributions: [...], totalTEN: N, tierBreakdown: {...} }
 */

const TIERS = [
  { name: 'Diamond', minScore: 250, amount: 50_000 },
  { name: 'Gold',    minScore: 150, amount: 20_000 },
  { name: 'Silver',  minScore:  75, amount:  5_000 },
  { name: 'Bronze',  minScore:  25, amount:  1_000 },
];

const ANTI_SYBIL = {
  MIN_ACTIVE_DAYS: 7,
  MIN_TX_COUNT: 3,
  MIN_RECIPIENTS: 2,
};

const AIRDROP_BUDGET = 125_000_000;  // 50% of 250M community pool

/**
 * Compute the airdrop score and tier for a single wallet.
 *
 * @param {object} activity
 * @param {number}   activity.txCount             total transactions sent from wallet
 * @param {number}   activity.uniqueRecipients    unique destination addresses
 * @param {number}   activity.volumeTEN           total TEN transferred (whole units)
 * @param {number}   activity.activeDays          days from first tx to last tx
 * @param {number}   [activity.validatorUptimePct]  0–100 attestation rate (validators only)
 * @param {boolean}  [activity.earlyAdopter]      true if active before testnet day 30
 * @returns {{ score, tier, eligible, reason }}
 */
function computeScore(activity) {
  const {
    txCount            = 0,
    uniqueRecipients   = 0,
    volumeTEN          = 0,
    activeDays         = 0,
    validatorUptimePct = 0,
    earlyAdopter       = false,
  } = activity;

  // ── Anti-sybil gates ──────────────────────────────────────────────────────
  if (activeDays < ANTI_SYBIL.MIN_ACTIVE_DAYS) {
    return {
      score: 0, tier: null, eligible: false,
      reason: `Active span ${activeDays}d < required ${ANTI_SYBIL.MIN_ACTIVE_DAYS}d`,
    };
  }
  if (txCount < ANTI_SYBIL.MIN_TX_COUNT) {
    return {
      score: 0, tier: null, eligible: false,
      reason: `Tx count ${txCount} < required ${ANTI_SYBIL.MIN_TX_COUNT}`,
    };
  }
  if (uniqueRecipients < ANTI_SYBIL.MIN_RECIPIENTS) {
    return {
      score: 0, tier: null, eligible: false,
      reason: `Unique recipients ${uniqueRecipients} < required ${ANTI_SYBIL.MIN_RECIPIENTS}`,
    };
  }

  // ── Scoring ───────────────────────────────────────────────────────────────
  const txScore        = Math.min(txCount, 100);
  const recipientScore = Math.min(uniqueRecipients * 5, 50);
  const volumeScore    = Math.min(volumeTEN / 2000, 50);
  const uptimeScore    = Math.min(Math.max(0, validatorUptimePct), 100);
  const earlyBonus     = earlyAdopter ? 10 : 0;

  const score = Math.floor(txScore + recipientScore + volumeScore + uptimeScore + earlyBonus);
  const tier  = TIERS.find(t => score >= t.minScore) ?? null;

  return {
    score,
    tier,
    eligible: tier !== null,
    reason: tier ? `Qualifies for ${tier.name} tier` : 'Score below Bronze threshold (25)',
  };
}

/**
 * Process an array of wallet activities and produce the full airdrop distribution.
 * Warns if total distribution would exceed AIRDROP_BUDGET.
 *
 * @param {Array<{ address: string } & object>} wallets
 * @returns {{ distributions, totalTEN, tierBreakdown, withinBudget }}
 */
function processAirdrop(wallets) {
  const distributions = [];
  const tierBreakdown = { Diamond: 0, Gold: 0, Silver: 0, Bronze: 0, Ineligible: 0 };
  let totalTEN = 0;

  for (const wallet of wallets) {
    const result = computeScore(wallet);
    const amount = result.tier?.amount ?? 0;

    distributions.push({
      address:  wallet.address,
      score:    result.score,
      tier:     result.tier?.name ?? 'Ineligible',
      amount,
      eligible: result.eligible,
      reason:   result.reason,
    });

    tierBreakdown[result.tier?.name ?? 'Ineligible']++;
    totalTEN += amount;
  }

  // Sort by score descending for reporting
  distributions.sort((a, b) => b.score - a.score);

  return {
    distributions,
    totalTEN,
    tierBreakdown,
    withinBudget: totalTEN <= AIRDROP_BUDGET,
    budgetUtilisationPct: ((totalTEN / AIRDROP_BUDGET) * 100).toFixed(2) + '%',
  };
}

/**
 * Sybil cluster detection heuristic.
 * Flags wallets funded from the same source within the same block.
 *
 * @param {Array<{ address, fundingSource, fundingBlock }>} wallets
 * @returns {Set<string>} set of flagged addresses
 */
function detectSybilClusters(wallets) {
  const clusterMap = new Map();  // key: `${fundingSource}:${fundingBlock}` → [address]

  for (const w of wallets) {
    if (!w.fundingSource || w.fundingBlock == null) continue;
    const key = `${w.fundingSource}:${w.fundingBlock}`;
    if (!clusterMap.has(key)) clusterMap.set(key, []);
    clusterMap.get(key).push(w.address);
  }

  const flagged = new Set();
  for (const [, addresses] of clusterMap) {
    if (addresses.length >= 3) {
      // 3+ wallets funded from same source in same block = likely sybil cluster
      for (const addr of addresses) flagged.add(addr);
    }
  }

  return flagged;
}

module.exports = {
  computeScore,
  processAirdrop,
  detectSybilClusters,
  TIERS,
  ANTI_SYBIL,
  AIRDROP_BUDGET,
};
