'use strict';

/**
 * staking/delegation.js
 * Token delegation — let holders delegate stake weight to validators
 * without becoming validators themselves.
 *
 * Architecture:
 *   - Delegator locks TEN (coin.burn from liquid balance)
 *   - Validator's effective stake increases by delegation amount
 *   - Delegator earns a share of the validator's ATTESTATION_REWARD
 *   - Anti-centralization: any one validator may not hold >33% of total stake
 *     (own + delegated combined)
 *
 * Delegation reward split:
 *   validator keeps DELEGATION_VALIDATOR_KEEP (20%)
 *   delegators share DELEGATION_DELEGATOR_SHARE (80%) proportionally
 */

const {
  MIN_STAKE,
  DELEGATION_MIN_AMOUNT,
  MAX_VALIDATOR_STAKE_PCT,
  ATTESTATION_REWARD,
} = require('../config/constants');

const DELEGATION_VALIDATOR_KEEP  = 0.20;  // validator's commission
const DELEGATION_DELEGATOR_SHARE = 0.80;  // split among delegators

class DelegationManager {
  /**
   * @param {import('./staking')}         staking
   * @param {import('../blockchain/state')} state
   */
  constructor(staking, state, options = {}) {
    this.staking   = staking;
    this.state     = state;
    this._onChange = options.onChange ?? (() => {});

    /**
     * delegations[validatorAddress][delegatorAddress] = amount
     * @type {Map<string, Map<string, number>>}
     */
    this.delegations = new Map();
  }

  // ── Delegation ────────────────────────────────────────────────────

  /**
   * Delegate `amount` TEN from `delegator` to `validator`.
   * Locks the tokens in the delegation contract (not re-stakeable).
   */
  delegate(delegator, validatorAddress, amount) {
    if (amount < DELEGATION_MIN_AMOUNT) {
      throw new Error(`Minimum delegation is ${DELEGATION_MIN_AMOUNT} TEN`);
    }

    const validator = this.staking.validatorPool.get(validatorAddress);
    if (!validator || !validator.active) {
      throw new Error(`Validator ${validatorAddress} is not active`);
    }

    // Anti-centralization cap check
    const totalStake      = this.staking.totalActiveStake() + this._totalDelegatedAll();
    const validatorTotal  = validator.stake + this._delegatedTo(validatorAddress);
    const maxAllowed      = Math.floor(totalStake * MAX_VALIDATOR_STAKE_PCT);
    if (validatorTotal + amount > maxAllowed) {
      throw new Error(
        `Anti-centralization cap: validator would hold ${((validatorTotal + amount) / (totalStake + amount) * 100).toFixed(1)}% of total stake (max ${MAX_VALIDATOR_STAKE_PCT * 100}%)`
      );
    }

    // Lock tokens from delegator's liquid balance
    const balance = this.state.getSpendableBalance(delegator);
    if (balance < amount) {
      throw new Error(`Insufficient spendable balance: ${balance} < ${amount}`);
    }
    this.state.coin.burn(delegator, amount);

    // Record delegation
    if (!this.delegations.has(validatorAddress)) {
      this.delegations.set(validatorAddress, new Map());
    }
    const existing = this.delegations.get(validatorAddress).get(delegator) ?? 0;
    this.delegations.get(validatorAddress).set(delegator, existing + amount);

    this._onChange();
    console.log(`[Delegation] ${delegator.slice(0,10)}… delegated ${amount} TEN to ${validatorAddress.slice(0,10)}…`);
  }

  /**
   * Undelegate `amount` TEN — returns tokens to delegator's liquid balance.
   * Subject to an unbonding period (enforced externally; here just immediate for testnet).
   */
  undelegate(delegator, validatorAddress, amount) {
    const pool = this.delegations.get(validatorAddress);
    if (!pool) throw new Error('No delegations found for this validator');
    const current = pool.get(delegator) ?? 0;
    if (current < amount) throw new Error(`Cannot undelegate ${amount} — only ${current} delegated`);

    pool.set(delegator, current - amount);
    if (pool.get(delegator) === 0) pool.delete(delegator);

    // Return tokens to liquid balance
    this.state.coin.mint(delegator, amount);
    this._onChange();
    console.log(`[Delegation] ${delegator.slice(0,10)}… undelegated ${amount} TEN from ${validatorAddress.slice(0,10)}…`);
  }

  // ── Rewards ───────────────────────────────────────────────────────

  /**
   * Distribute delegation rewards at epoch end.
   * Called alongside staking.distributeRewards().
   *
   * @param {string[]} attestingValidators  validators that attested this epoch
   */
  distributeDelegationRewards(attestingValidators) {
    for (const validatorAddress of attestingValidators) {
      const pool = this.delegations.get(validatorAddress);
      if (!pool || pool.size === 0) continue;

      const totalDelegated = this._delegatedTo(validatorAddress);
      if (totalDelegated === 0) continue;

      // Delegation reward = ATTESTATION_REWARD × (delegated / total_validator_weight)
      // For simplicity: base reward split proportionally
      const rewardPool    = ATTESTATION_REWARD * DELEGATION_DELEGATOR_SHARE;
      const validatorCut  = ATTESTATION_REWARD * DELEGATION_VALIDATOR_KEEP;

      // Validator gets their commission share
      this.state.coin.mint(validatorAddress, validatorCut);

      // Delegators share proportionally
      for (const [delegator, amount] of pool) {
        const share = Math.floor((amount / totalDelegated) * rewardPool * 100) / 100;
        if (share > 0) {
          this.state.coin.mint(delegator, share);
        }
      }
    }
    this._onChange();
  }

  // ── Queries ───────────────────────────────────────────────────────

  /** Total TEN delegated to a specific validator. */
  _delegatedTo(validatorAddress) {
    const pool = this.delegations.get(validatorAddress);
    if (!pool) return 0;
    let total = 0;
    for (const amt of pool.values()) total += amt;
    return total;
  }

  /** Total TEN delegated across all validators. */
  _totalDelegatedAll() {
    let total = 0;
    for (const pool of this.delegations.values()) {
      for (const amt of pool.values()) total += amt;
    }
    return total;
  }

  /** Effective stake of a validator (own + delegated). */
  getEffectiveStake(validatorAddress) {
    const validator = this.staking.validatorPool.get(validatorAddress);
    return (validator?.stake ?? 0) + this._delegatedTo(validatorAddress);
  }

  /** All delegators for a validator with their amounts. */
  getDelegatorsFor(validatorAddress) {
    const pool = this.delegations.get(validatorAddress);
    if (!pool) return [];
    return [...pool.entries()].map(([delegator, amount]) => ({ delegator, amount }));
  }

  /** All delegations made by a specific address. */
  getDelegationsBy(delegatorAddress) {
    const result = [];
    for (const [validator, pool] of this.delegations) {
      const amount = pool.get(delegatorAddress);
      if (amount) result.push({ validator, amount });
    }
    return result;
  }

  // ── Serialization ─────────────────────────────────────────────────

  snapshot() {
    const snap = {};
    for (const [validator, pool] of this.delegations) {
      snap[validator] = Object.fromEntries(pool);
    }
    return snap;
  }

  loadSnapshot(snap = {}) {
    this.delegations = new Map();
    for (const [validator, pool] of Object.entries(snap)) {
      this.delegations.set(validator, new Map(Object.entries(pool)));
    }
  }
}

module.exports = DelegationManager;
