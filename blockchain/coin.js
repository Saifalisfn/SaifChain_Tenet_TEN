/**
 * blockchain/coin.js
 * Tenet (TEN) – Native Layer-1 Coin
 *
 * Maintains a simple in-memory balance ledger.
 * All coin operations go through this module so we have
 * one source of truth (mirrors Ethereum's state trie concept).
 *
 * Methods
 * ───────
 *  getBalance(address)
 *  transfer(from, to, amount)
 *  mint(to, amount)                  – block/staking rewards
 *  burn(address, amount)             – slashing, fee burning
 *  initGenesis(treasuryAddress)      – single-address genesis mint
 *  initGenesisFromAllocations(allocs)– multi-address genesis from genesis.json
 *  snapshot()                        – returns { address: balance } copy
 *  loadSnapshot(snap)                – restore from snapshot
 */

const { GENESIS_SUPPLY, COIN_SYMBOL, BURN_ADDRESS } = require('../config/constants');

class Coin {
  constructor() {
    /** @type {Map<string, number>} address → balance */
    this.balances   = new Map();
    this._totalMinted = 0;   // tracks all mint() calls; enforces hard cap
    this._totalBurned = 0;   // tracks all burn() calls for supply reporting
  }

  get totalMinted() { return this._totalMinted; }
  get totalBurned()  { return this._totalBurned; }
  get netSupply()    { return this._totalMinted - this._totalBurned; }

  // ── Queries ──────────────────────────────────────────────────────
  getBalance(address) {
    return this.balances.get(address) ?? 0;
  }

  // ── Mutations ────────────────────────────────────────────────────

  /**
   * Mint new coins to an address.
   * Hard cap: total minted can never exceed GENESIS_SUPPLY.
   */
  mint(to, amount) {
    if (amount <= 0) throw new Error('mint: amount must be positive');
    if (this._totalMinted + amount > GENESIS_SUPPLY) {
      const remaining = GENESIS_SUPPLY - this._totalMinted;
      throw new Error(
        `mint: hard supply cap exceeded (cap=${GENESIS_SUPPLY}, minted=${this._totalMinted}, requested=${amount}, available=${remaining})`
      );
    }
    this.balances.set(to, this.getBalance(to) + amount);
    this._totalMinted += amount;
  }

  /**
   * Burn coins — sends to BURN_ADDRESS and deducts from circulating supply.
   * Used for: fee burns, slashing penalties.
   */
  burn(address, amount) {
    if (amount <= 0) return;  // no-op for zero burns
    const bal = this.getBalance(address);
    if (bal < amount) throw new Error(`burn: insufficient balance (${bal} < ${amount})`);
    this.balances.set(address, bal - amount);
    // Accumulate at burn address for transparent on-chain auditability
    this.balances.set(BURN_ADDRESS, this.getBalance(BURN_ADDRESS) + amount);
    this._totalBurned += amount;
  }

  /**
   * Transfer TEN between two addresses.
   * Sending to BURN_ADDRESS automatically increments _totalBurned.
   */
  transfer(from, to, amount) {
    if (amount <= 0) throw new Error('transfer: amount must be positive');
    const senderBal = this.getBalance(from);
    if (senderBal < amount) {
      throw new Error(`transfer: insufficient balance for ${from} (${senderBal} < ${amount})`);
    }
    this.balances.set(from, senderBal - amount);
    this.balances.set(to,   this.getBalance(to) + amount);
    if (to === BURN_ADDRESS) this._totalBurned += amount;
  }

  // ── State snapshots ───────────────────────────────────────────────

  /** Returns a plain { address: balance } object. */
  snapshot() {
    const snap = {};
    for (const [addr, bal] of this.balances) snap[addr] = bal;
    return snap;
  }

  /** Restore balances from a snapshot object. Recalculates supply counters. */
  loadSnapshot(snap) {
    this.balances = new Map(Object.entries(snap));
    // Recalculate _totalMinted as sum of all positive balances (conservative estimate)
    // _totalBurned is recovered from BURN_ADDRESS balance
    let total = 0;
    for (const [addr, bal] of this.balances) {
      if (addr !== BURN_ADDRESS) total += bal;
    }
    this._totalBurned  = this.balances.get(BURN_ADDRESS) ?? 0;
    this._totalMinted  = total + this._totalBurned;
  }

  // ── Genesis bootstrap ─────────────────────────────────────────────

  /** Mint the full supply to a single genesis treasury address. */
  initGenesis(treasuryAddress) {
    this.mint(treasuryAddress, GENESIS_SUPPLY);
    console.log(`[Coin] Minted ${GENESIS_SUPPLY.toLocaleString()} ${COIN_SYMBOL} to genesis treasury ${treasuryAddress}`);
  }

  /**
   * Mint genesis allocations to multiple addresses from genesis.json.
   * Only mints the immediately-unlocked portion; locked amounts stay in
   * genesis-state.json and are released by the vesting engine.
   *
   * @param {Array<{ address, amount, vesting: { immediateUnlockPct } }>} allocations
   */
  initGenesisFromAllocations(allocations) {
    let totalMinted = 0;
    for (const alloc of allocations) {
      const pct       = alloc.vesting?.immediateUnlockPct ?? (alloc.vesting?.type === 'EMISSION' ? 1 : 0);
      const immediate = Math.floor(alloc.amount * pct);
      if (immediate > 0) {
        this.mint(alloc.address, immediate);
        totalMinted += immediate;
        console.log(`[Coin] Genesis mint: ${immediate.toLocaleString()} ${COIN_SYMBOL} → ${alloc.name ?? alloc.address}`);
      }
    }
    console.log(`[Coin] Total genesis minted: ${totalMinted.toLocaleString()} ${COIN_SYMBOL}`);
  }
}

module.exports = Coin;
