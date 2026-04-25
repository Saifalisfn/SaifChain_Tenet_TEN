/**
 * rpc/server.js
 * JSON-RPC HTTP Server (Express)
 *
 * POST /rpc  – standard JSON-RPC 2.0 envelope
 * GET  /     – health check
 *
 * Request format
 * ──────────────
 * {
 *   "jsonrpc": "2.0",
 *   "method":  "sfc_getBalance",
 *   "params":  ["0xabc123…"],
 *   "id":      1
 * }
 */

const path         = require('path');
const express      = require('express');
const buildMethods = require('./methods');
const SupplyTracker = require('../blockchain/supplyTracker');
const {
  RPC_RATE_LIMIT_WINDOW_MS,
  RPC_RATE_LIMIT_MAX_REQUESTS,
  COIN_SYMBOL,
  CHAIN_ID,
} = require('../config/constants');

class RPCServer {
  /**
   * @param {import('../blockchain/blockchain')} blockchain
   * @param {import('../staking/staking')}       staking
   * @param {import('../staking/slashing').Slashing} slashing
   * @param {number} port
   */
  constructor(blockchain, staking, slashing, port, options = {}) {
    this.blockchain    = blockchain;
    this.staking       = staking;
    this.slashing      = slashing;
    this.port          = port;
    this.app           = express();
    this.supplyTracker = new SupplyTracker(blockchain.state.coin, blockchain.state, staking);
    this.methods       = buildMethods(blockchain, staking, slashing, options, this.supplyTracker);
    this.allowedMethods = new Set(Object.keys(this.methods));
    this._rateLimit    = new Map();
    this._setup();
  }

  _setup() {
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

      if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
      }

      next();
    });

    this.app.disable('x-powered-by');
    this.app.use(express.json({ limit: '32kb' }));
    this.app.use((err, _req, res, next) => {
      if (err instanceof SyntaxError && 'body' in err) {
        return res.json(this._error(null, -32700, 'Parse error'));
      }
      return next(err);
    });
    this.app.use(express.static(path.join(__dirname, '..', 'public')));

    // ── Health ──────────────────────────────────────────────────────
    this.app.get('/health', (_req, res) => res.json({
      node:    'Tenet',
      symbol:  COIN_SYMBOL,
      chainId: CHAIN_ID,
      status:  'ok',
      height:  this.blockchain.getHeight(),
    }));

    // ── REST Explorer API ────────────────────────────────────────────
    const api = express.Router();

    api.get('/blocks', (req, res) => {
      const limit  = Math.min(parseInt(req.query.limit  ?? '20'), 100);
      const offset = Math.max(parseInt(req.query.offset ?? '0'),   0);
      const chain  = this.blockchain.chain;
      const total  = chain.length;
      const blocks = chain
        .slice(Math.max(0, total - offset - limit), total - offset)
        .reverse()
        .map(b => b.toJSON());
      res.json({ total, offset, limit, blocks });
    });

    api.get('/blocks/:hashOrNumber', (req, res) => {
      const param = req.params.hashOrNumber;
      const block = /^\d+$/.test(param)
        ? this.blockchain.getBlockByIndex(parseInt(param))
        : this.blockchain.getBlockByHash(param.replace(/^0x/, ''));
      if (!block) return res.status(404).json({ error: 'Block not found' });
      res.json(block.toJSON());
    });

    api.get('/tx/:hash', (req, res) => {
      const hash   = req.params.hash.replace(/^0x/, '');
      const record = this.blockchain.getTransactionById(hash);
      if (!record) return res.status(404).json({ error: 'Transaction not found' });
      res.json(record);
    });

    api.get('/validators', (_req, res) => {
      const validators = this.staking.getValidatorList().map(v => ({
        address:        v.address,
        stake:          v.stake,
        active:         v.active,
        slashed:        v.slashed,
        joinedEpoch:    v.joinedEpoch,
        slashHistory:   this.slashing.getSlashLog().filter(s => s.address === v.address),
      }));
      res.json({ count: validators.length, validators });
    });

    api.get('/supply', (_req, res) => {
      res.json(this.supplyTracker.snapshot());
    });

    api.get('/address/:address', (req, res) => {
      const addr = req.params.address;
      res.json({
        address:        addr,
        balance:        this.blockchain.state.getBalance(addr),
        spendable:      this.blockchain.state.getSpendableBalance(addr),
        locked:         this.blockchain.state.getLockedBalance(addr),
        staked:         this.staking.getValidatorStake(addr),
        nonce:          this.blockchain.state.getNonce(addr),
      });
    });

    api.get('/slash-log', (_req, res) => {
      res.json(this.slashing.getSlashLog());
    });

    api.get('/mempool', (_req, res) => {
      res.json({
        size:    this.blockchain.mempool.length,
        pending: this.blockchain.mempool.map(t => t.toJSON()),
      });
    });

    this.app.use('/api', api);

    // JSON-RPC endpoint
    this.app.post('/rpc', (req, res) => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return res.json(this._error(null, -32600, 'Invalid Request'));
      }

      const { jsonrpc, method, params, id } = req.body;

      if (jsonrpc !== '2.0') {
        return res.json(this._error(id, -32600, 'Invalid Request'));
      }

      if (typeof method !== 'string' || method.length === 0 || method.length > 100) {
        return res.json(this._error(id, -32600, 'Invalid Request'));
      }

      if (params !== undefined && !Array.isArray(params) && (typeof params !== 'object' || params === null)) {
        return res.json(this._error(id, -32602, 'Invalid params'));
      }

      if (id !== undefined && id !== null && !['string', 'number'].includes(typeof id)) {
        return res.json(this._error(null, -32600, 'Invalid Request'));
      }

      const rateLimitError = this._consumeRateLimit(req);
      if (rateLimitError) {
        res.set('Retry-After', String(rateLimitError.retryAfterSeconds));
        return res.status(429).json(this._error(id, -32005, rateLimitError.message));
      }

      if (!this.allowedMethods.has(method)) {
        return res.json(this._error(id, -32601, `Method not found: ${method}`));
      }

      const handler = this.methods[method];

      try {
        const result = handler(params ?? []);
        return res.json({ jsonrpc: '2.0', result, id });
      } catch (err) {
        console.error(`[RPC] Error in ${method}:`, err.message);
        return res.json(this._error(id, -32000, err.message));
      }
    });
  }

  _error(id, code, message) {
    return { jsonrpc: '2.0', error: { code, message }, id };
  }

  _consumeRateLimit(req) {
    const now = Date.now();
    const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const entry = this._rateLimit.get(ip) ?? { count: 0, resetAt: now + RPC_RATE_LIMIT_WINDOW_MS };

    if (now >= entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + RPC_RATE_LIMIT_WINDOW_MS;
    }

    entry.count += 1;
    this._rateLimit.set(ip, entry);

    if (entry.count <= RPC_RATE_LIMIT_MAX_REQUESTS) {
      return null;
    }

    return {
      message: `Rate limit exceeded. Try again in ${Math.max(1, Math.ceil((entry.resetAt - now) / 1000))}s`,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }

  start() {
    return new Promise(resolve => {
      this.app.listen(this.port, () => {
        console.log(`[RPC] Server listening on http://localhost:${this.port}/rpc`);
        resolve();
      });
    });
  }
}

module.exports = RPCServer;
