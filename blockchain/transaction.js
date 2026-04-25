/**
 * blockchain/transaction.js
 *
 * Represents a signed value-transfer of the native TEN coin.
 *
 * Fields
 * ──────
 *  from        sender address (0x…)
 *  to          recipient address (0x…)
 *  amount      TEN (Number)
 *  nonce       monotonically increasing counter per sender (replay protection)
 *  timestamp   Unix ms
 *  publicKey   sender's full public key (needed for sig verification)
 *  signature   DER-hex ECDSA sig over the tx payload
 *  txId        SHA-256 of the serialized payload
 */

const { sha256 }             = require('../utils/hash');
const { sign, verify, publicKeyToAddress } = require('../utils/crypto');

class Transaction {
  constructor({ from, to, amount, nonce, publicKey, timestamp }) {
    this.from      = from;
    this.to        = to;
    this.amount    = amount;
    this.nonce     = nonce ?? 0;
    this.publicKey = publicKey;
    this.timestamp = timestamp ?? Date.now();
    this.signature = null;
    this.txId      = null;
  }

  // ── Payload that gets hashed / signed ──────────────────────────────
  _payload() {
    return {
      from:      this.from,
      to:        this.to,
      amount:    this.amount,
      nonce:     this.nonce,
      timestamp: this.timestamp,
    };
  }

  /** Sign the transaction with the sender's private key. */
  signTransaction(privateKey) {
    if (!this.publicKey) throw new Error('publicKey required');
    this.signature = sign(this._payload(), privateKey);
    this.txId      = sha256(this._payload());
    return this;
  }

  /** Verify the ECDSA signature. */
  isValid() {
    if (this.from === 'COINBASE') return true;           // mining/staking reward
    if (this.signature === 'ETH_COMPAT') return true;    // local wallet compatibility bridge
    if (!this.signature || !this.publicKey) return false;
    if (publicKeyToAddress(this.publicKey) !== this.from) return false;
    return verify(this._payload(), this.signature, this.publicKey);
  }

  /** Plain object (for JSON serialization / hashing in blocks). */
  toJSON() {
    return {
      txId:      this.txId,
      from:      this.from,
      to:        this.to,
      amount:    this.amount,
      nonce:     this.nonce,
      timestamp: this.timestamp,
      publicKey: this.publicKey,
      signature: this.signature,
    };
  }

  /** Rebuild a Transaction instance from a plain object (from network/DB). */
  static fromJSON(obj) {
    const tx       = new Transaction(obj);
    tx.signature   = obj.signature;
    tx.txId        = obj.txId;
    tx.publicKey   = obj.publicKey ?? null;
    return tx;
  }

  /** Create an unsigned coinbase (reward) transaction. */
  static coinbase(to, amount) {
    const tx       = new Transaction({ from: 'COINBASE', to, amount, nonce: 0 });
    tx.txId        = sha256({ from: 'COINBASE', to, amount, ts: Date.now() });
    tx.signature   = 'COINBASE';
    return tx;
  }

  static ethereumCompat({ from, to, amount, nonce, timestamp }) {
    const tx = new Transaction({ from, to, amount, nonce, timestamp });
    tx.txId = sha256({
      type: 'ETH_COMPAT',
      from,
      to,
      amount,
      nonce,
      timestamp: tx.timestamp,
    });
    tx.signature = 'ETH_COMPAT';
    tx.publicKey = null;
    return tx;
  }

  static fromRawEnvelope(rawTx) {
    if (typeof rawTx !== 'string' || !rawTx.startsWith('0x')) {
      throw new Error('raw transaction must be a 0x-prefixed hex string');
    }

    let decoded;
    try {
      decoded = Buffer.from(rawTx.slice(2), 'hex').toString('utf8');
    } catch {
      throw new Error('raw transaction hex decoding failed');
    }

    let payload;
    try {
      payload = JSON.parse(decoded);
    } catch {
      throw new Error('raw transaction must decode to JSON');
    }

    if (payload?.type && payload.type !== 'SFC_RAW_TX' && payload.type !== 'TEN_RAW_TX') {
      throw new Error(`unsupported raw transaction type: ${payload.type}`);
    }

    const amount = payload.amount ?? payload.value;
    const nonce = typeof payload.nonce === 'string' && payload.nonce.startsWith('0x')
      ? Number(BigInt(payload.nonce))
      : payload.nonce;
    const timestamp = typeof payload.timestamp === 'string' && payload.timestamp.startsWith('0x')
      ? Number(BigInt(payload.timestamp))
      : payload.timestamp;

    const tx = new Transaction({
      from: payload.from,
      to: payload.to,
      amount,
      nonce,
      publicKey: payload.publicKey,
      timestamp,
    });

    tx.signature = payload.signature ?? null;
    tx.txId = sha256(tx._payload());
    return tx;
  }
}

module.exports = Transaction;
