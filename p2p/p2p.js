/**
 * p2p/p2p.js
 * WebSocket-based Peer-to-Peer Network Layer
 *
 * Each node:
 *  - Runs a WS server that accepts inbound connections
 *  - Maintains a list of outbound WS connections (peers)
 *  - Gossips BLOCK / TRANSACTION / ATTESTATION messages
 *  - Deduplicates messages via a seen-IDs cache
 *  - Handles chain sync requests
 *
 * Usage
 * ─────
 *  const p2p = new P2PNetwork(blockchain, port);
 *  await p2p.start();
 *  p2p.connect('ws://localhost:6002');
 */

const WebSocket  = require('ws');
const { sha256 } = require('../utils/hash');
const MSG        = require('./messageTypes');
const { P2P_MAX_MESSAGE_BYTES, P2P_MAX_STRIKES, P2P_BAN_WINDOW_MS } = require('../config/constants');
const { sign, verify, publicKeyToAddress } = require('../utils/crypto');

// How many message IDs to remember (simple ring-buffer dedup)
const SEEN_CACHE_SIZE = 1000;

class P2PNetwork {
  /**
   * @param {import('../blockchain/blockchain')} blockchain
   * @param {number} port  – WebSocket server port
   */
  constructor(blockchain, port) {
    this.blockchain  = blockchain;
    this.port        = port;
    /** @type {WebSocket[]} */
    this.peers       = [];
    this._server     = null;
    this._seen       = [];      // ring-buffer of recently seen message IDs
    this._handlers   = {};      // type → callback registered by ValidatorNode
    this._peerStrikes = new Map();
    this._localIdentity = null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  start() {
    return new Promise(resolve => {
      this._server = new WebSocket.Server({ port: this.port }, () => {
        console.log(`[P2P] Listening on ws://localhost:${this.port}`);
        resolve();
      });

      this._server.on('connection', ws => {
        const peerKey = `host:${this._peerKey(ws)}`;
        const peerStatus = this._peerStrikes.get(peerKey);
        if (peerStatus?.bannedUntil && peerStatus.bannedUntil > Date.now()) {
          console.warn(`[P2P] Rejecting banned peer ${peerKey}`);
          ws.close(1008, 'peer temporarily banned');
          return;
        }

        console.log('[P2P] Inbound peer connected');
        this._initPeer(ws);
      });
    });
  }

  /** Connect to a remote peer by URL (e.g. 'ws://localhost:6002'). */
  connect(url) {
    const ws = new WebSocket(url);
    ws.on('open', () => {
      console.log(`[P2P] Connected to ${url}`);
      this._initPeer(ws);
    });
    ws.on('error', err => console.warn(`[P2P] Connection error to ${url}:`, err.message));
  }

  // ── Peer setup ─────────────────────────────────────────────────────

  _initPeer(ws) {
    ws._peerKey = this._peerKey(ws);
    this.peers.push(ws);

    setTimeout(() => {
      this._sendHello(ws);
      this.sendTo(ws, MSG.REQUEST_CHAIN, {});
      this.sendTo(ws, MSG.REQUEST_VALIDATORS, {});
    }, 0);

    ws.on('message', raw => {
      if (raw.length > P2P_MAX_MESSAGE_BYTES) {
        this._strikePeer(ws, `message too large (${raw.length} bytes)`);
        return;
      }

      try {
        const msg = JSON.parse(raw);
        if (!this._isValidMessage(msg)) {
          this._strikePeer(ws, 'invalid message envelope');
          return;
        }
        this._handleMessage(msg, ws);
      } catch (e) {
        this._strikePeer(ws, `bad message: ${e.message}`);
      }
    });

    ws.on('close', () => {
      this.peers = this.peers.filter(p => p !== ws);
      console.log(`[P2P] Peer disconnected (${this.peers.length} remaining)`);
    });
  }

  // ── Message handling ───────────────────────────────────────────────

  _handleMessage(msg, sender) {
    // Dedup
    if (this._seen.includes(msg.id)) return;
    this._seen.push(msg.id);
    if (this._seen.length > SEEN_CACHE_SIZE) this._seen.shift();

    // Gossip forward (exclude origin)
    if (msg.type !== MSG.HELLO) {
      this._gossip(msg, sender);
    }

    switch (msg.type) {
      case MSG.HELLO:
        this._onHello(msg.payload, sender);
        break;
      case MSG.BLOCK:
        this._onBlock(msg.payload);
        break;
      case MSG.TRANSACTION:
        this._onTransaction(msg.payload);
        break;
      case MSG.ATTESTATION:
        this._onAttestation(msg.payload);
        break;
      case MSG.CHAIN_SYNC:
        this._onChainSync(msg.payload);
        break;
      case MSG.REQUEST_CHAIN:
        this.sendTo(sender, MSG.CHAIN_SYNC, this.blockchain.toJSON());
        break;
      case MSG.VALIDATOR_SYNC:
      case MSG.REQUEST_VALIDATORS:
        break;
      default:
        console.warn('[P2P] Unknown message type:', msg.type);
    }

    // Fire any external handlers registered by ValidatorNode
    if (this._handlers[msg.type]) {
      this._handlers[msg.type](msg.payload);
    }
  }

  _isValidMessage(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
    if (typeof msg.type !== 'string' || typeof msg.id !== 'string') return false;
    if (!Object.values(MSG).includes(msg.type)) return false;

    switch (msg.type) {
      case MSG.BLOCK:
        return this._isValidBlockPayload(msg.payload);
      case MSG.TRANSACTION:
        return this._isValidTransactionPayload(msg.payload);
      case MSG.ATTESTATION:
        return this._isValidAttestationPayload(msg.payload);
      case MSG.CHAIN_SYNC:
        return Array.isArray(msg.payload);
      case MSG.REQUEST_CHAIN:
      case MSG.REQUEST_VALIDATORS:
        return msg.payload && typeof msg.payload === 'object' && !Array.isArray(msg.payload);
      case MSG.VALIDATOR_SYNC:
        return this._isValidValidatorSyncPayload(msg.payload);
      case MSG.HELLO:
        return this._isValidHelloPayload(msg.payload);
      default:
        return false;
    }
  }

  _isValidHelloPayload(payload) {
    return payload
      && typeof payload === 'object'
      && !Array.isArray(payload)
      && typeof payload.address === 'string'
      && typeof payload.publicKey === 'string'
      && Number.isInteger(payload.listeningPort)
      && Number.isInteger(payload.announcedAt)
      && typeof payload.signature === 'string';
  }

  _isValidBlockPayload(payload) {
    return payload
      && typeof payload === 'object'
      && !Array.isArray(payload)
      && Number.isInteger(payload.index)
      && typeof payload.previousHash === 'string'
      && typeof payload.validator === 'string'
      && Number.isInteger(payload.slot)
      && Number.isInteger(payload.epoch)
      && typeof payload.stateRoot === 'string'
      && typeof payload.hash === 'string'
      && typeof payload.signature === 'string'
      && typeof payload.finalized === 'boolean'
      && Array.isArray(payload.transactions)
      && Array.isArray(payload.attestations);
  }

  _isValidTransactionPayload(payload) {
    return payload
      && typeof payload === 'object'
      && !Array.isArray(payload)
      && typeof payload.from === 'string'
      && typeof payload.to === 'string'
      && Number.isFinite(payload.amount)
      && Number.isInteger(payload.nonce)
      && typeof payload.signature === 'string';
  }

  _isValidAttestationPayload(payload) {
    return payload
      && typeof payload === 'object'
      && !Array.isArray(payload)
      && typeof payload.validatorAddress === 'string'
      && typeof payload.blockHash === 'string'
      && Number.isInteger(payload.slot)
      && typeof payload.signature === 'string';
  }

  _isValidValidatorSyncPayload(payload) {
    return payload
      && typeof payload === 'object'
      && !Array.isArray(payload)
      && Array.isArray(payload.validators);
  }

  _strikePeer(ws, reason) {
    const peerKey = this._reputationKey(ws);
    const peerStatus = this._peerStrikes.get(peerKey) ?? { strikes: 0, bannedUntil: 0 };
    peerStatus.strikes += 1;
    this._peerStrikes.set(peerKey, peerStatus);

    console.warn(`[P2P] Peer strike ${peerStatus.strikes}/${P2P_MAX_STRIKES} for ${peerKey}: ${reason}`);

    if (peerStatus.strikes < P2P_MAX_STRIKES) {
      return;
    }

    peerStatus.strikes = 0;
    peerStatus.bannedUntil = Date.now() + P2P_BAN_WINDOW_MS;
    this._peerStrikes.set(peerKey, peerStatus);

    console.warn(`[P2P] Disconnecting and banning peer ${peerKey} for ${P2P_BAN_WINDOW_MS}ms`);
    try {
      ws.close(1008, reason.slice(0, 123));
    } catch {
      // Ignore close errors for already-closed sockets.
    }
  }

  _peerKey(ws) {
    return String(ws._socket?.remoteAddress || 'unknown');
  }

  _reputationKey(ws) {
    return ws._peerIdentity?.address
      ? `identity:${ws._peerIdentity.address}`
      : `host:${ws._peerKey ?? this._peerKey(ws)}`;
  }

  _onHello(payload, ws) {
    const peerIdentity = this._verifyHello(payload);
    if (!peerIdentity) {
      this._strikePeer(ws, 'invalid peer identity');
      return;
    }

    const identityKey = `identity:${peerIdentity.address}`;
    const peerStatus = this._peerStrikes.get(identityKey);
    if (peerStatus?.bannedUntil && peerStatus.bannedUntil > Date.now()) {
      console.warn(`[P2P] Rejecting banned peer identity ${peerIdentity.address}`);
      try {
        ws.close(1008, 'peer identity temporarily banned');
      } catch {
        // Ignore close errors.
      }
      return;
    }

    ws._peerIdentity = peerIdentity;
    console.log(`[P2P] Authenticated peer ${peerIdentity.address.slice(0,10)}... on ws://localhost:${peerIdentity.listeningPort}`);
  }

  _verifyHello(payload) {
    const { address, publicKey, listeningPort, announcedAt, signature } = payload;
    if (publicKeyToAddress(publicKey) !== address) {
      return null;
    }

    const signedPayload = { address, publicKey, listeningPort, announcedAt };
    if (!verify(signedPayload, signature, publicKey)) {
      return null;
    }

    return { address, publicKey, listeningPort, announcedAt };
  }

  setLocalIdentity(identity) {
    this._localIdentity = identity;
    for (const peer of this.peers) {
      this._sendHello(peer);
    }
  }

  _sendHello(ws) {
    if (!this._localIdentity) {
      return;
    }

    const payload = {
      address: this._localIdentity.address,
      publicKey: this._localIdentity.publicKey,
      listeningPort: this.port,
      announcedAt: Date.now(),
    };
    payload.signature = sign(payload, this._localIdentity.privateKey);
    this.sendTo(ws, MSG.HELLO, payload);
  }

  _onBlock(blockData) {
    const Block = require('../blockchain/block');
    const block = Block.fromJSON(blockData);
    console.log(`[P2P] Block #${block.index} received from network (finalized=${block.finalized})`);
  }

  _onTransaction(txData) {
    const added = this.blockchain.addTransaction(txData);
    if (added) console.log('[P2P] Transaction accepted from network');
  }

  _onAttestation(attestData) {
    // Delegate to external handler if registered
    console.log(`[P2P] Attestation received from ${attestData.validatorAddress?.slice(0,10)}…`);
  }

  _onChainSync(chainData) {
    this.blockchain.replaceChain(chainData);
  }

  // ── Broadcasting ───────────────────────────────────────────────────

  /** Broadcast to all connected peers. */
  broadcast(type, payload) {
    const msg = this._buildMessage(type, payload);
    const raw = JSON.stringify(msg);
    for (const peer of this.peers) {
      if (peer.readyState === WebSocket.OPEN) {
        peer.send(raw);
      }
    }
  }

  /** Send a message to one specific peer. */
  sendTo(ws, type, payload) {
    const msg = this._buildMessage(type, payload);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  /** Forward a message to all peers except the origin. */
  _gossip(msg, exclude) {
    const raw = JSON.stringify(msg);
    for (const peer of this.peers) {
      if (peer !== exclude && peer.readyState === WebSocket.OPEN) {
        peer.send(raw);
      }
    }
  }

  _buildMessage(type, payload) {
    const id = sha256({ type, payload, ts: Date.now() });
    return { type, payload, id };
  }

  // ── Handler registration ───────────────────────────────────────────

  /** Register a callback for a specific message type. */
  on(type, handler) {
    // Don't override EventEmitter 'close' / 'error' etc.
    if (typeof type === 'string' && typeof handler === 'function') {
      this._handlers[type] = handler;
    }
  }
}

module.exports = P2PNetwork;
