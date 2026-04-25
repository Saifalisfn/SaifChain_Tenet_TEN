'use strict';

/**
 * tokenomics/vesting.js
 * Token vesting engine for Tenet (TEN) genesis allocations.
 *
 * Vesting types:
 *   IMMEDIATE    — fully unlocked at genesis (no lock-up)
 *   CLIFF_LINEAR — lock for cliffMonths, then linear daily unlock over vestingMonths
 *   EMISSION     — handled externally by rewardSchedule.js (not tracked here)
 *
 * On-chain enforcement:
 *   In the current simulation, vesting is advisory (enforced off-chain or via
 *   governance multisig). A future EVM upgrade can enforce it via a VestingVault
 *   smart contract. This module provides the unlock calculation logic.
 */

const MS_PER_DAY   = 24 * 60 * 60 * 1000;
const MS_PER_MONTH = 30.4375 * MS_PER_DAY;  // average month (365.25/12 days)

class VestingSchedule {
  /**
   * @param {object} cfg
   * @param {string}  cfg.name
   * @param {string}  cfg.address          beneficiary address
   * @param {number}  cfg.totalAmount      total TEN allocated
   * @param {string}  cfg.type             IMMEDIATE | CLIFF_LINEAR | EMISSION
   * @param {number}  [cfg.cliffMonths]    months before any vested tokens unlock (default 0)
   * @param {number}  [cfg.vestingMonths]  months of linear vesting after cliff (default 0)
   * @param {number}  [cfg.immediateUnlockPct]  fraction (0–1) unlocked at genesis (default 0)
   * @param {number}  [cfg.genesisTimestamp]    Unix ms of genesis (default: now)
   */
  constructor(cfg) {
    this.name               = cfg.name;
    this.address            = cfg.address;
    this.totalAmount        = cfg.totalAmount;
    this.type               = cfg.type;
    this.cliffMonths        = cfg.cliffMonths        ?? 0;
    this.vestingMonths      = cfg.vestingMonths      ?? 0;
    this.immediateUnlockPct = cfg.immediateUnlockPct ?? 0;
    this.genesisTs          = cfg.genesisTimestamp   ?? Date.now();
    this.claimed            = 0;
  }

  /**
   * Total TEN unlocked as of `nowMs`.
   * @param {number} [nowMs]  timestamp in ms (default: now)
   * @returns {number}
   */
  unlockedAt(nowMs = Date.now()) {
    if (this.type === 'EMISSION')  return 0;
    if (this.type === 'IMMEDIATE') return this.totalAmount;

    const immediate = Math.floor(this.totalAmount * this.immediateUnlockPct);
    const vested    = this.totalAmount - immediate;
    const elapsed   = nowMs - this.genesisTs;
    const cliffMs   = this.cliffMonths * MS_PER_MONTH;

    if (elapsed < cliffMs) return immediate;

    const vestMs          = this.vestingMonths * MS_PER_MONTH;
    const postCliff       = Math.min(elapsed - cliffMs, vestMs);
    const vestedUnlocked  = vestMs > 0 ? Math.floor(vested * (postCliff / vestMs)) : vested;

    return immediate + vestedUnlocked;
  }

  /**
   * Tokens available to claim now (unlocked minus already claimed).
   * @param {number} [nowMs]
   * @returns {number}
   */
  claimable(nowMs = Date.now()) {
    return Math.max(0, this.unlockedAt(nowMs) - this.claimed);
  }

  /**
   * Claim available tokens. Returns amount claimed.
   * In production: triggers a state mutation / contract call.
   * @param {number} [nowMs]
   * @returns {number} amount claimed
   */
  claim(nowMs = Date.now()) {
    const amount = this.claimable(nowMs);
    if (amount <= 0) return 0;
    this.claimed += amount;
    return amount;
  }

  /**
   * Next unlock event: cliff unlock or next linear tick.
   * @returns {{ timestamp: number, amount: number } | null}
   */
  nextUnlock(nowMs = Date.now()) {
    if (this.type === 'EMISSION' || this.type === 'IMMEDIATE') return null;

    const cliffTs = this.genesisTs + this.cliffMonths * MS_PER_MONTH;
    if (nowMs < cliffTs) {
      const immediate = Math.floor(this.totalAmount * this.immediateUnlockPct);
      return { timestamp: cliffTs, amount: immediate };
    }

    const vestEnd = cliffTs + this.vestingMonths * MS_PER_MONTH;
    if (nowMs >= vestEnd) return null;

    // next daily tick
    const nextTick = nowMs + MS_PER_DAY;
    const amount   = this.unlockedAt(nextTick) - this.unlockedAt(nowMs);
    return { timestamp: nextTick, amount };
  }

  /** Human-readable summary snapshot. */
  summary(nowMs = Date.now()) {
    return {
      name:         this.name,
      address:      this.address,
      totalAmount:  this.totalAmount,
      type:         this.type,
      cliffMonths:  this.cliffMonths,
      vestingMonths:this.vestingMonths,
      immediateUnlockPct: this.immediateUnlockPct,
      unlocked:     this.unlockedAt(nowMs),
      claimed:      this.claimed,
      claimable:    this.claimable(nowMs),
      locked:       this.totalAmount - this.unlockedAt(nowMs),
      pctVested:    ((this.unlockedAt(nowMs) / this.totalAmount) * 100).toFixed(2) + '%',
    };
  }

  /** Serialise for persistence. */
  toJSON() {
    return {
      name:               this.name,
      address:            this.address,
      totalAmount:        this.totalAmount,
      type:               this.type,
      cliffMonths:        this.cliffMonths,
      vestingMonths:      this.vestingMonths,
      immediateUnlockPct: this.immediateUnlockPct,
      genesisTimestamp:   this.genesisTs,
      claimed:            this.claimed,
    };
  }

  static fromJSON(data) {
    const s = new VestingSchedule(data);
    s.claimed = data.claimed ?? 0;
    return s;
  }
}

/**
 * Load all non-emission vesting schedules from a parsed genesis.json object.
 * @param {object} genesis  Parsed genesis.json
 * @returns {VestingSchedule[]}
 */
function loadFromGenesis(genesis) {
  const genesisTs = new Date(genesis.genesisTimestamp).getTime();
  return genesis.allocations
    .filter(a => a.vesting.type !== 'EMISSION')
    .map(a => new VestingSchedule({
      name:               a.name,
      address:            a.address,
      totalAmount:        a.amount,
      type:               a.vesting.type,
      cliffMonths:        a.vesting.cliffMonths        ?? 0,
      vestingMonths:      a.vesting.vestingMonths      ?? 0,
      immediateUnlockPct: a.vesting.immediateUnlockPct ?? 0,
      genesisTimestamp:   genesisTs,
    }));
}

module.exports = { VestingSchedule, loadFromGenesis };
