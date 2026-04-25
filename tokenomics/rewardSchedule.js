'use strict';

/**
 * tokenomics/rewardSchedule.js
 * Dynamic block reward emission for Tenet (TEN).
 *
 * Model: Bitcoin-style halving every BLOCKS_PER_HALVING blocks (~2 years).
 * Floor: MIN_BLOCK_REWARD — rewards never drop to zero.
 *
 * At 5 s/block:
 *   Blocks/year  ≈ 6,311,520
 *   BLOCKS_PER_HALVING = 12,623,040 (~2 years)
 *
 * Emission schedule (from 300M staking rewards pool):
 *   Era 0  (blocks       0 –  12,623,039): 5.00 TEN/block → ~63.1M TEN/2yr
 *   Era 1  (blocks  12,623,040 –  25,246,079): 2.50 TEN/block → ~31.6M TEN/2yr
 *   Era 2  (blocks  25,246,080 –  50,492,159): 1.25 TEN/block → ~15.8M TEN/2yr
 *   Era 3+ (blocks  50,492,160+):              0.625 → ... → 0.10 TEN/block (floor)
 *   Total from pool over ~20 years: ~190M TEN; remaining 110M via governance
 */

const {
  INITIAL_BLOCK_REWARD,
  BLOCKS_PER_HALVING,
  MIN_BLOCK_REWARD,
} = require('../config/constants');

/**
 * Current block reward at the given chain height.
 * @param {number} blockHeight  0-indexed (genesis = 0)
 * @returns {number} TEN per block
 */
function getCurrentReward(blockHeight) {
  if (blockHeight < 0) return INITIAL_BLOCK_REWARD;
  const halvings = Math.floor(blockHeight / BLOCKS_PER_HALVING);
  const reward   = INITIAL_BLOCK_REWARD / Math.pow(2, halvings);
  return Math.max(reward, MIN_BLOCK_REWARD);
}

/**
 * Cumulative TEN emitted from block rewards up to (but not including) blockHeight.
 * Iterates over each halving era — O(halvings), which is < 20 in practice.
 * @param {number} blockHeight
 * @returns {number} total TEN emitted
 */
function getCumulativeEmission(blockHeight) {
  if (blockHeight <= 0) return 0;
  let total     = 0;
  let remaining = blockHeight;
  let reward    = INITIAL_BLOCK_REWARD;

  while (remaining > 0) {
    const effectiveReward = Math.max(reward, MIN_BLOCK_REWARD);
    const blocksThisEra   = Math.min(remaining, BLOCKS_PER_HALVING);
    total    += blocksThisEra * effectiveReward;
    remaining -= blocksThisEra;
    if (reward <= MIN_BLOCK_REWARD) break;   // floor reached; fill rest at floor
    reward = reward / 2;
  }

  if (remaining > 0) total += remaining * MIN_BLOCK_REWARD;
  return total;
}

const BLOCKS_PER_YEAR = Math.round(365.25 * 24 * 3600 / 5);  // 6,311,520

/**
 * Annualised emission rate at the given block height.
 * @param {number} blockHeight
 * @returns {number} TEN/year
 */
function getAnnualEmission(blockHeight) {
  return getCurrentReward(blockHeight) * BLOCKS_PER_YEAR;
}

/**
 * Era number (0-indexed) at the given block height.
 */
function getEra(blockHeight) {
  return Math.floor(Math.max(0, blockHeight) / BLOCKS_PER_HALVING);
}

/**
 * Blocks remaining in the current era.
 */
function blocksUntilNextHalving(blockHeight) {
  return BLOCKS_PER_HALVING - (blockHeight % BLOCKS_PER_HALVING);
}

module.exports = {
  getCurrentReward,
  getCumulativeEmission,
  getAnnualEmission,
  getEra,
  blocksUntilNextHalving,
  BLOCKS_PER_YEAR,
};
