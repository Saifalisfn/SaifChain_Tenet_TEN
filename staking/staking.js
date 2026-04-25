/**
 * staking/staking.js
 * Staking Registry – tracks validator stakes and the active validator set.
 *
 * Flow
 * ────
 *  1. A user calls stake(address, amount, publicKey) to register.
 *  2. Their coins are "locked" (deducted from liquid balance via State).
 *  3. They enter the active validator set once stake ≥ MIN_STAKE.
 *  4. Rewards are added each epoch via distributeRewards().
 *  5. Unstaking returns coins (minus any pending slash).
 */

const { MIN_STAKE, ATTESTATION_REWARD, STAKING_POOL_ADDRESS } = require('../config/constants');

class Staking {
  /**
   * @param {import('../blockchain/state')} state  – shared world-state
   */
  constructor(state, options = {}) {
    this.state = state;
    this._onChange = options.onChange ?? (() => {});

    /**
     * validatorPool: Map<address, { publicKey, stake, active, slashed }>
     */
    this.validatorPool = new Map();
  }

  // ── Registration ──────────────────────────────────────────────────

  /**
   * Lock `amount` TEN from `address` into the staking contract.
   */
  stake(address, amount, publicKey, joinedEpoch = 0) {
    if (amount < MIN_STAKE) {
      throw new Error(`Minimum stake is ${MIN_STAKE} TEN`);
    }
    const balance = this.state.getBalance(address);
    if (balance < amount) {
      throw new Error(`Insufficient balance: ${balance} < ${amount}`);
    }

    // Transfer to staking pool (not burn — staked coins are locked, not destroyed)
    this.state.coin.transfer(address, STAKING_POOL_ADDRESS, amount);
    // Add to staking state
    this.state.addStake(address, amount);

    // Upsert validator record
    const existing = this.validatorPool.get(address);
    if (existing) {
      existing.stake += amount;
      this._onChange();
    } else {
      this.validatorPool.set(address, {
        address,
        publicKey,
        stake:   amount,
        active:  true,
        slashed: false,
        joinedEpoch,
      });
      this._onChange();
    }

    console.log(`[Staking] ${address.slice(0, 10)}… staked ${amount} TEN (total ${this.getValidatorStake(address)})`);
  }

  importValidator(record) {
    if (!record?.address) {
      return false;
    }

    const existing = this.validatorPool.get(record.address);
    if (existing) {
      existing.publicKey = record.publicKey ?? existing.publicKey;
      existing.stake = record.stake ?? existing.stake;
      existing.active = record.active ?? existing.active;
      existing.slashed = record.slashed ?? existing.slashed;
      existing.joinedEpoch = record.joinedEpoch ?? existing.joinedEpoch ?? 0;
      this._onChange();
      return false;
    }

    this.validatorPool.set(record.address, {
      address: record.address,
      publicKey: record.publicKey ?? null,
      stake: record.stake ?? 0,
      active: record.active ?? true,
      slashed: record.slashed ?? false,
      joinedEpoch: record.joinedEpoch ?? 0,
    });

    this._onChange();
    return true;
  }

  /**
   * Unlock stake and return coins to liquid balance.
   */
  unstake(address, amount) {
    const validator = this.validatorPool.get(address);
    if (!validator) throw new Error('Not a validator');
    if (validator.stake < amount) throw new Error('Insufficient stake');

    validator.stake -= amount;
    this.state.removeStake(address, amount);
    // Return coins from staking pool to liquid balance
    this.state.coin.transfer(STAKING_POOL_ADDRESS, address, amount);

    if (validator.stake < MIN_STAKE) {
      validator.active = false;
      console.log(`[Staking] ${address.slice(0, 10)}… deactivated (stake below minimum)`);
    }

    this._onChange();
  }

  // ── Queries ───────────────────────────────────────────────────────

  getValidatorStake(address) {
    return this.validatorPool.get(address)?.stake ?? 0;
  }

  /** Return all active, non-slashed validators as an array. */
  getActiveValidators() {
    return [...this.validatorPool.values()].filter(v => v.active && !v.slashed);
  }

  totalActiveStake() {
    return this.getActiveValidators().reduce((s, v) => s + v.stake, 0);
  }

  // ── Rewards ───────────────────────────────────────────────────────

  /**
   * Distribute attestation rewards at end of epoch.
   * @param {string[]} attesters  list of addresses that attested this epoch
   */
  distributeRewards(attesters) {
    for (const address of attesters) {
      if (this.validatorPool.has(address)) {
        this.state.coin.mint(address, ATTESTATION_REWARD);
        console.log(`[Staking] Reward +${ATTESTATION_REWARD} TEN → ${address.slice(0, 10)}…`);
      }
    }

    this._onChange();
  }

  // ── Serialization ─────────────────────────────────────────────────
  getValidatorList() {
    return [...this.validatorPool.values()];
  }

  snapshot() {
    return this.getValidatorList();
  }

  loadSnapshot(records = []) {
    this.validatorPool = new Map(records.map(record => [record.address, record]));
  }
}

module.exports = Staking;
