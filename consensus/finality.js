/**
 * consensus/finality.js
 * Finality – BFT-style 2/3 majority rule
 *
 * A block is FINALIZED when the attesting stake ≥ 2/3 of total active stake.
 * Once finalized, the block cannot be rolled back (safety guarantee).
 *
 * This mirrors Ethereum's Casper FFG finality gadget in spirit.
 */

const { FINALITY_THRESHOLD } = require('../config/constants');

class Finality {
  /**
   * @param {import('../consensus/attestation')} attestation
   * @param {import('../staking/staking')}       staking
   */
  constructor(attestation, staking) {
    this.attestation = attestation;
    this.staking     = staking;
  }

  /**
   * Check if a block has reached finality.
   *
   * @param {import('../blockchain/block')} block
   * @returns {boolean}
   */
  checkFinality(block) {
    if (block.finalized) return true;   // already finalized

    const totalStake    = this.staking.totalActiveStake();
    if (totalStake === 0) return false;

    const attestingStake = this.attestation.getAttestingStake(block.slot, block.hash);
    const ratio          = attestingStake / totalStake;

    console.log(
      `[Finality] Slot ${block.slot}: ${attestingStake}/${totalStake} stake attested ` +
      `(${(ratio * 100).toFixed(1)}% — need ${FINALITY_THRESHOLD * 100}%)`
    );

    if (ratio >= FINALITY_THRESHOLD) {
      block.finalized    = true;
      // Embed all attestations into the block
      block.attestations = this.attestation.getAttestations(block.slot);
      console.log(`[Finality] 🏁 Block #${block.index} FINALIZED`);
      return true;
    }

    return false;
  }

  /**
   * Force-check and finalize pending blocks in the chain.
   * Called at the end of each slot window.
   */
  tryFinalizeAll(chain) {
    for (const block of chain) {
      if (!block.finalized) {
        this.checkFinality(block);
      }
    }
  }
}

module.exports = Finality;
