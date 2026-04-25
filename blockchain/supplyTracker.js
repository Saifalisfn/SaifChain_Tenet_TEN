'use strict';

/**
 * blockchain/supplyTracker.js
 * Real-time supply accounting for Tenet (TEN).
 *
 * Reports:
 *   totalSupply       – hard cap (1,000,000,000 TEN, never changes)
 *   mintedSupply      – tokens ever minted (≤ totalSupply)
 *   burnedSupply      – tokens at BURN_ADDRESS (destroyed, unspendable)
 *   circulatingSupply – minted − burned − staked − locked
 *   stakedSupply      – tokens locked in validator stakes
 *   lockedSupply      – tokens in vesting lock (not yet transferable)
 *   liquidSupply      – tokens freely transferable right now
 */

const { GENESIS_SUPPLY, BURN_ADDRESS, STAKING_POOL_ADDRESS } = require('../config/constants');

class SupplyTracker {
  /**
   * @param {import('./coin')}  coin
   * @param {import('./state')} state
   * @param {import('../staking/staking')} staking
   */
  constructor(coin, state, staking) {
    this.coin    = coin;
    this.state   = state;
    this.staking = staking;
  }

  /** Total hard-cap supply (constant). */
  get totalSupply() {
    return GENESIS_SUPPLY;
  }

  /** Tokens ever created by mint() calls. */
  get mintedSupply() {
    return this.coin.totalMinted;
  }

  /** Tokens that have been burned (at BURN_ADDRESS, permanently unspendable). */
  get burnedSupply() {
    return this.coin.totalBurned;
  }

  /** Tokens locked in validator stakes. */
  get stakedSupply() {
    return this.staking.totalActiveStake();
  }

  /** Tokens in vesting lock (held but not transferable). */
  get lockedSupply() {
    let total = 0;
    for (const amount of this.state.vestingLocks.values()) total += amount;
    return total;
  }

  /** Tokens still held in staking rewards emission pool. */
  get emissionPoolBalance() {
    return this.coin.getBalance(STAKING_POOL_ADDRESS) ?? 0;
  }

  /**
   * Tokens in free circulation (liquid + staked − burned − locked).
   * This is what DEX price discovery acts on.
   */
  get circulatingSupply() {
    return Math.max(0, this.mintedSupply - this.burnedSupply - this.emissionPoolBalance);
  }

  /** Freely transferable liquid tokens (circulating minus staked minus locked). */
  get liquidSupply() {
    return Math.max(0, this.circulatingSupply - this.stakedSupply - this.lockedSupply);
  }

  /** Remaining mint capacity before hard cap. */
  get remainingMintCapacity() {
    return GENESIS_SUPPLY - this.mintedSupply;
  }

  /** Full supply snapshot for APIs and monitoring. */
  snapshot() {
    return {
      totalSupply:        this.totalSupply,
      mintedSupply:       this.mintedSupply,
      burnedSupply:       this.burnedSupply,
      emissionPool:       this.emissionPoolBalance,
      circulatingSupply:  this.circulatingSupply,
      stakedSupply:       this.stakedSupply,
      lockedSupply:       this.lockedSupply,
      liquidSupply:       this.liquidSupply,
      remainingMintCap:   this.remainingMintCapacity,
      burnAddressBalance: this.coin.getBalance(BURN_ADDRESS) ?? 0,
    };
  }
}

module.exports = SupplyTracker;
