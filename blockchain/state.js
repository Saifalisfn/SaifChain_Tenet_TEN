/**
 * blockchain/state.js
 * World State – The SaifChain "State Trie" (simplified)
 *
 * Aggregates:
 *  - Coin balances  (via Coin module)
 *  - Account nonces (replay-attack protection)
 *  - Staking records
 *
 * The state is applied per block: transactions mutate balances & nonces.
 * A stateRoot (hash of the snapshot) is embedded in every block header.
 */

const { sha256 } = require('../utils/hash');
const { TX_FEE, TX_FEE_BURN_PCT, BURN_ADDRESS } = require('../config/constants');
const Coin       = require('./coin');

class State {
  constructor() {
    this.coin   = new Coin();
    /** @type {Map<string, number>} address → next expected nonce */
    this.nonces = new Map();
    /** @type {Map<string, number>} address → staked amount */
    this.stakes = new Map();
    /** @type {Map<string, number>} address → vesting-locked amount (cannot be transferred) */
    this.vestingLocks = new Map();
  }

  // ── Vesting locks ─────────────────────────────────────────────────

  /** Lock an amount from being transferred (vesting enforcement). */
  addVestingLock(address, amount) {
    this.vestingLocks.set(address, (this.vestingLocks.get(address) ?? 0) + amount);
  }

  /** Release a vesting unlock (called by vesting engine at cliff/tick). */
  releaseVestingLock(address, amount) {
    const locked  = this.vestingLocks.get(address) ?? 0;
    const newLock = Math.max(0, locked - amount);
    if (newLock === 0) this.vestingLocks.delete(address);
    else               this.vestingLocks.set(address, newLock);
  }

  getLockedBalance(address) {
    return this.vestingLocks.get(address) ?? 0;
  }

  /** Liquid spendable balance = total balance − vesting lock. */
  getSpendableBalance(address) {
    return Math.max(0, this.coin.getBalance(address) - this.getLockedBalance(address));
  }

  // ── Nonce ─────────────────────────────────────────────────────────
  getNonce(address) {
    return this.nonces.get(address) ?? 0;
  }

  incrementNonce(address) {
    this.nonces.set(address, this.getNonce(address) + 1);
  }

  // ── Balances (delegate to Coin) ───────────────────────────────────
  getBalance(address) {
    return this.coin.getBalance(address);
  }

  // ── Stake ─────────────────────────────────────────────────────────
  getStake(address) {
    return this.stakes.get(address) ?? 0;
  }

  addStake(address, amount) {
    this.stakes.set(address, this.getStake(address) + amount);
  }

  removeStake(address, amount) {
    const current = this.getStake(address);
    this.stakes.set(address, Math.max(0, current - amount));
  }

  totalStake() {
    let total = 0;
    for (const s of this.stakes.values()) total += s;
    return total;
  }

  // ── Apply block transactions ──────────────────────────────────────

  /**
   * Apply all transactions in a block to the state.
   * Returns false if any tx is invalid (block should be rejected).
   *
   * Fee model: TX_FEE deducted per user tx.
   *   TX_FEE_BURN_PCT  → burned (coin.burn)
   *   remainder        → validator (block.validator) via coinbase-style credit
   */
  applyBlock(block) {
    let feeAccrued = 0;

    for (const txData of block.transactions) {
      if (txData.from === 'COINBASE') {
        // Reward mint — only allowed if supply cap permits
        try {
          this.coin.mint(txData.to, txData.amount);
        } catch (err) {
          console.warn(`[State] Coinbase mint blocked: ${err.message}`);
          // Cap hit — skip reward rather than reject block
        }
        continue;
      }

      // Nonce check
      const expectedNonce = this.getNonce(txData.from);
      if (txData.nonce !== expectedNonce) {
        console.warn(`[State] Bad nonce from ${txData.from}: expected ${expectedNonce}, got ${txData.nonce}`);
        return false;
      }

      // Spendable balance check (respects vesting locks)
      const totalRequired = txData.amount + TX_FEE;
      if (this.getSpendableBalance(txData.from) < totalRequired) {
        console.warn(`[State] Insufficient spendable balance: ${txData.from} (need ${totalRequired}, have ${this.getSpendableBalance(txData.from)})`);
        return false;
      }

      // Execute transfer
      this.coin.transfer(txData.from, txData.to, txData.amount);
      this.incrementNonce(txData.from);

      // Fee: split TX_FEE between burn address and block proposer (pure transfer, no mint)
      const burnAmount      = Math.round(TX_FEE * TX_FEE_BURN_PCT * 100) / 100;
      const validatorAmount = TX_FEE - burnAmount;
      const validator       = block.validator;

      if (burnAmount > 0) {
        this.coin.transfer(txData.from, BURN_ADDRESS, burnAmount);
      }
      if (validatorAmount > 0 && validator && validator !== 'GENESIS') {
        this.coin.transfer(txData.from, validator, validatorAmount);
      } else if (validatorAmount > 0) {
        // Genesis block or unknown proposer — burn the validator portion too
        this.coin.transfer(txData.from, BURN_ADDRESS, validatorAmount);
      }
    }

    return true;
  }

  // ── State root ────────────────────────────────────────────────────

  /** Deterministic hash of the current state. Embeds in block header. */
  computeStateRoot() {
    return sha256({
      balances: this.coin.snapshot(),
      nonces:   Object.fromEntries(this.nonces),
      stakes:   Object.fromEntries(this.stakes),
    });
  }

  // ── Snapshot / restore ────────────────────────────────────────────

  snapshot() {
    return {
      balances:     this.coin.snapshot(),
      nonces:       Object.fromEntries(this.nonces),
      stakes:       Object.fromEntries(this.stakes),
      vestingLocks: Object.fromEntries(this.vestingLocks),
    };
  }

  loadSnapshot(snap) {
    this.coin.loadSnapshot(snap.balances ?? {});
    this.nonces       = new Map(Object.entries(snap.nonces       ?? {}));
    this.stakes       = new Map(Object.entries(snap.stakes       ?? {}));
    this.vestingLocks = new Map(Object.entries(snap.vestingLocks ?? {}));
  }
}

module.exports = State;
