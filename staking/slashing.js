/**
 * staking/slashing.js
 * Slashing – punish Byzantine or offline validators
 *
 * Offences & penalties
 * ────────────────────
 *  DOUBLE_VOTE     – equivocation vote (same slot, two block hashes): 20% slash
 *  DOUBLE_PROPOSAL – equivocation proposal (same slot, two blocks):   15% slash
 *  OFFLINE         – missed all attestations in an epoch:              2% slash
 *
 * Validator is deactivated if remaining stake < MIN_STAKE.
 */

const {
  SLASH_DOUBLE_VOTE,
  SLASH_DOUBLE_PROPOSAL,
  SLASH_OFFLINE,
  MIN_STAKE,
} = require('../config/constants');

const OFFENCE = {
  DOUBLE_VOTE:     'DOUBLE_VOTE',
  DOUBLE_PROPOSAL: 'DOUBLE_PROPOSAL',
  OFFLINE:         'OFFLINE',
};

const SLASH_RATE = {
  [OFFENCE.DOUBLE_VOTE]:     SLASH_DOUBLE_VOTE,
  [OFFENCE.DOUBLE_PROPOSAL]: SLASH_DOUBLE_PROPOSAL,
  [OFFENCE.OFFLINE]:         SLASH_OFFLINE,
};

class Slashing {
  /**
   * @param {import('../staking/staking')} staking  – shared staking registry
   */
  constructor(staking, options = {}) {
    this.staking = staking;
    this._onChange = options.onChange ?? (() => {});
    /** @type {Array<{ address, offence, slot, timestamp }>} */
    this.slashLog = [];
  }

  /**
   * Slash a validator for a given offence.
   * @param {string} address
   * @param {string} offence  – OFFENCE constant
   * @param {number} slot
   */
  slash(address, offence, slot) {
    const validator = this.staking.validatorPool.get(address);
    if (!validator) {
      console.warn(`[Slash] Unknown validator ${address}`);
      return;
    }
    if (validator.slashed) {
      console.log(`[Slash] ${address.slice(0,10)}… already slashed`);
      return;
    }

    const rate    = SLASH_RATE[offence] ?? SLASH_DOUBLE_VOTE;
    const penalty = Math.floor(validator.stake * rate);
    validator.stake -= penalty;
    this.staking.state.removeStake(address, penalty);
    this.staking.state.coin.burn(address, 0); // coins were already in stake, not liquid

    this.slashLog.push({ address, offence, slot, penalty, timestamp: Date.now() });
    this._onChange();

    console.warn(
      `[Slash] ⚠️  ${address.slice(0,10)}… slashed ${penalty} SFC for ${offence} @ slot ${slot}`
    );

    // Deactivate if below minimum
    if (validator.stake < MIN_STAKE) {
      validator.active  = false;
      validator.slashed = true;
      console.warn(`[Slash] ${address.slice(0,10)}… DEACTIVATED`);
    }
  }

  /**
   * Detect a double-vote: same validator, same slot, different block hashes.
   */
  checkDoubleVote(validatorAddress, slot, blockHash1, blockHash2) {
    if (blockHash1 !== blockHash2) {
      this.slash(validatorAddress, OFFENCE.DOUBLE_VOTE, slot);
      return true;
    }
    return false;
  }

  checkDoubleProposal(validatorAddress, slot, blockHash1, blockHash2) {
    if (blockHash1 !== blockHash2) {
      this.slash(validatorAddress, OFFENCE.DOUBLE_PROPOSAL, slot);
      return true;
    }
    return false;
  }

  getSlashLog() {
    return this.slashLog;
  }

  loadSnapshot(entries = []) {
    this.slashLog = entries;
  }
}

module.exports = { Slashing, OFFENCE };
