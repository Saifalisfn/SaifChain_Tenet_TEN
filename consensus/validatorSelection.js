/**
 * consensus/validatorSelection.js
 * Weighted-random proposer selection (VRF-lite simulation)
 *
 * Algorithm
 * ─────────
 *  1. Collect all active validators and their stakes.
 *  2. Build a cumulative-weight array.
 *  3. Hash (seed + slot + epoch) → deterministic random number.
 *  4. Walk cumulative array to find the selected validator.
 *
 * This approximates Ethereum's RANDAO-based proposer selection
 * without a real VRF. Every node running the same slot/epoch
 * will arrive at the same proposer deterministically.
 */

const { sha256 } = require('../utils/hash');

class ValidatorSelection {
  /**
   * @param {import('../staking/staking')} staking
   */
  constructor(staking) {
    this.staking = staking;
    this._seed   = sha256('saifchain_genesis_seed');
  }

  /**
   * Select the block proposer for a given slot.
   * Returns the validator object { address, publicKey, stake }.
   */
  selectProposer(slot, epoch) {
    const validators = this._getDeterministicValidators();
    if (validators.length === 0) throw new Error('No active validators');

    const selected = this._weightedRandom(validators, slot, epoch, 'PROPOSER');
    console.log(`[Selection] Slot ${slot} proposer → ${selected.address.slice(0,12)}…`);
    return selected;
  }

  /**
   * Return the full ordered committee for a slot.
   * For simplicity: all active validators are the committee.
   */
  getCommittee(slot, epoch) {
    return this._getDeterministicValidators();
  }

  // ── Internal ───────────────────────────────────────────────────────

  _weightedRandom(validators, slot, epoch, role) {
    const totalStake = validators.reduce((s, v) => s + v.stake, 0);

    // Deterministic random value in [0, totalStake)
    const hashHex = sha256({ seed: this._seed, slot, epoch, role });
    const rand    = (parseInt(hashHex.slice(0, 8), 16) % totalStake);

    let cumulative = 0;
    for (const v of validators) {
      cumulative += v.stake;
      if (rand < cumulative) return v;
    }

    // Fallback (shouldn't happen)
    return validators[validators.length - 1];
  }

  _getDeterministicValidators() {
    return this.staking.getActiveValidators()
      .slice()
      .sort((a, b) => a.address.localeCompare(b.address));
  }
}

module.exports = ValidatorSelection;
