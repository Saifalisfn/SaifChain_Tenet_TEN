/**
 * blockchain/blockchain.js
 * The Chain – SaifChain's canonical ledger
 *
 * Responsibilities
 * ────────────────
 *  - Stores the ordered list of blocks (the chain)
 *  - Validates incoming blocks before appending
 *  - Manages the mempool (pending transactions)
 *  - Maintains world state (balances, nonces, stakes)
 *  - Handles chain replacement on longer/heavier forks
 *  - Tracks total stake weight for fork choice
 */

const Block          = require('./block');
const State          = require('./state');
const Transaction    = require('./transaction');
const { sha256 }     = require('../utils/hash');
const constants      = require('../config/constants');
const rewardSchedule = require('../tokenomics/rewardSchedule');

class Blockchain {
  constructor(options = {}) {
    /** @type {Block[]} */
    this.chain    = [];
    /** @type {Transaction[]} */
    this.mempool  = [];
    this.state    = new State();
    this.txIndex  = new Map();
    this.receipts = new Map();
    this._onChange = options.onChange ?? (() => {});

    if (options.snapshot) {
      this.loadSnapshot(options.snapshot);
    } else {
      this._initGenesis();
    }
  }

  // ── Genesis ──────────────────────────────────────────────────────
  _initGenesis() {
    if (this.chain.length > 0) {
      throw new Error('[Blockchain] Genesis already initialized — re-init blocked');
    }
    const genesis = Block.genesis();
    genesis.finalized = true;
    this.chain.push(genesis);
    this._genesisLocked = true;
    console.log('[Blockchain] Genesis block created:', genesis.hash.slice(0, 12) + '…');
  }

  // ── Accessors ─────────────────────────────────────────────────────
  get latestBlock() {
    return this.chain[this.chain.length - 1];
  }

  getBlockByIndex(index) {
    return this.chain[index] ?? null;
  }

  getBlockByHash(hash) {
    return this.chain.find(b => b.hash === hash) ?? null;
  }

  getHeight() {
    return this.chain.length - 1;
  }

  getTransactionById(txId) {
    return this.txIndex.get(txId) ?? null;
  }

  getReceiptByTxId(txId) {
    return this.receipts.get(txId) ?? null;
  }

  // ── Mempool ───────────────────────────────────────────────────────

  /** Add a transaction to the mempool after basic validation. */
  addTransaction(tx) {
    if (!(tx instanceof Transaction)) tx = Transaction.fromJSON(tx);
    if (!tx.isValid()) {
      console.warn('[Mempool] Invalid signature — rejected');
      return false;
    }
    // deduplicate
    if (this.mempool.some(t => t.txId === tx.txId)) return false;

    this.mempool.push(tx);
    this.txIndex.set(tx.txId, {
      tx: tx.toJSON(),
      blockIndex: null,
      blockHash: null,
      transactionIndex: null,
      status: 'pending',
    });
    this._onChange();
    console.log(`[Mempool] +1 tx (${this.mempool.length} pending)`);
    return true;
  }

  /** Pop up to `limit` transactions for block inclusion. */
  drainMempool(limit = 100) {
    return this.mempool.splice(0, limit);
  }

  // ── Block creation ────────────────────────────────────────────────

  /**
   * Build a new candidate block from the current mempool.
   * Called by the validator node that wins proposer selection.
   */
  createBlock(validatorAddress, slot, epoch) {
    const txs = this.drainMempool();

    // prepend coinbase reward for the proposer (dynamic halving schedule)
    const reward = Transaction.coinbase(
      validatorAddress,
      rewardSchedule.getCurrentReward(this.getHeight()),
    );
    txs.unshift(reward);

    const block = new Block({
      index:        this.latestBlock.index + 1,
      transactions: txs.map(t => t.toJSON()),
      previousHash: this.latestBlock.hash,
      validator:    validatorAddress,
      slot,
      epoch,
      stateRoot:    this.state.computeStateRoot(),
    });

    return block;
  }

  // ── Block validation ──────────────────────────────────────────────

  isValidBlock(block, parentBlock) {
    // 1. Index continuity
    if (block.index !== parentBlock.index + 1) return false;
    // 2. Parent hash linkage
    if (block.previousHash !== parentBlock.hash) return false;
    // 3. Hash integrity
    const b = Block.fromJSON(block.toJSON());
    b.hash  = b.calculateHash();
    if (b.hash !== block.hash) return false;
    return true;
  }

  // ── Append finalized block ────────────────────────────────────────

  /**
   * Append a block that has passed finality (≥ 2/3 stake attested).
   * Applies state transitions and removes included txs from mempool.
   */
  appendBlock(block) {
    if (!this.isValidBlock(block, this.latestBlock)) {
      console.warn(`[Chain] Block #${block.index} invalid — rejected`);
      return false;
    }

    const ok = this.state.applyBlock(block);
    if (!ok) {
      console.warn(`[Chain] Block #${block.index} state application failed`);
      return false;
    }

    this.chain.push(block);

    block.transactions.forEach((tx, transactionIndex) => {
      if (!tx.txId) return;

      this.txIndex.set(tx.txId, {
        tx,
        blockIndex: block.index,
        blockHash: block.hash,
        transactionIndex,
        status: 'finalized',
      });

      this.receipts.set(tx.txId, {
        transactionHash: `0x${tx.txId}`,
        transactionIndex,
        blockHash: `0x${block.hash}`,
        blockNumber: block.index,
        from: tx.from,
        to: tx.to,
        cumulativeGasUsed: '0x5208',
        gasUsed: '0x5208',
        contractAddress: null,
        logs: [],
        status: '0x1',
      });
    });

    // Remove included txs from mempool
    const includedIds = new Set(block.transactions.map(t => t.txId));
    this.mempool = this.mempool.filter(t => !includedIds.has(t.txId));
    this._onChange();

    console.log(`[Chain] ✅ Block #${block.index} appended (slot ${block.slot}) hash=${block.hash.slice(0, 12)}…`);
    return true;
  }

  // ── Fork choice / chain replacement ──────────────────────────────

  /**
   * Replace our chain with a heavier/longer one received from a peer.
   * Uses stake-weight or length depending on FORK_CHOICE config.
   */
  replaceChain(newChain) {
    if (!this._isValidChain(newChain)) {
      console.warn('[ForkChoice] Incoming chain invalid — ignored');
      return false;
    }

    const shouldReplace = constants.FORK_CHOICE === 'STAKE_WEIGHT'
      ? this._chainStakeWeight(newChain) > this._chainStakeWeight(this.chain)
      : newChain.length > this.chain.length;

    if (!shouldReplace) {
      console.log('[ForkChoice] Our chain is heavier — keeping');
      return false;
    }

    console.log('[ForkChoice] Replacing chain (new length:', newChain.length, ')');
    this.chain = newChain.map(b => Block.fromJSON(b));
    this._replayState();
    this._onChange();
    return true;
  }

  /** Validate every block in an array. */
  _isValidChain(chain) {
    if (chain[0].hash !== Block.genesis().hash) return false;
    for (let i = 1; i < chain.length; i++) {
      const cur  = Block.fromJSON(chain[i]);
      const prev = Block.fromJSON(chain[i - 1]);
      if (!this.isValidBlock(cur, prev)) return false;
    }
    return true;
  }

  /** Sum of attestation-count * block-index as a rough stake-weight proxy. */
  _chainStakeWeight(chain) {
    return chain.reduce((sum, b) => sum + (b.attestations?.length ?? 0) * (b.index + 1), 0);
  }

  /** Rebuild state from scratch by replaying all blocks. */
  _replayState() {
    this.state = new State();
    this.txIndex = new Map();
    this.receipts = new Map();
    for (const block of this.chain.slice(1)) {
      this.state.applyBlock(block);
      block.transactions.forEach((tx, transactionIndex) => {
        if (!tx.txId) return;

        this.txIndex.set(tx.txId, {
          tx,
          blockIndex: block.index,
          blockHash: block.hash,
          transactionIndex,
          status: 'finalized',
        });

        this.receipts.set(tx.txId, {
          transactionHash: `0x${tx.txId}`,
          transactionIndex,
          blockHash: `0x${block.hash}`,
          blockNumber: block.index,
          from: tx.from,
          to: tx.to,
          cumulativeGasUsed: '0x5208',
          gasUsed: '0x5208',
          contractAddress: null,
          logs: [],
          status: '0x1',
        });
      });
    }
    console.log('[Chain] State replayed from genesis');
  }

  // ── Serialization ─────────────────────────────────────────────────
  toJSON() {
    return this.chain.map(b => b.toJSON());
  }

  snapshot() {
    return {
      chain: this.chain.map(b => b.toJSON()),
      mempool: this.mempool.map(t => t.toJSON()),
      state: this.state.snapshot(),
      txIndex: [...this.txIndex.entries()],
      receipts: [...this.receipts.entries()],
    };
  }

  loadSnapshot(snapshot) {
    this.chain = (snapshot.chain ?? []).map(b => Block.fromJSON(b));
    this.mempool = (snapshot.mempool ?? []).map(t => Transaction.fromJSON(t));
    this.state.loadSnapshot(snapshot.state ?? { balances: {}, nonces: {}, stakes: {} });
    this.txIndex = new Map(snapshot.txIndex ?? []);
    this.receipts = new Map(snapshot.receipts ?? []);

    if (this.chain.length === 0) {
      this._initGenesis();
    }
  }
}

module.exports = Blockchain;
