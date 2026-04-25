/**
 * blockchain/block.js
 *
 * Ethereum-inspired block structure for SaifChain.
 *
 * Fields
 * ──────
 *  index         block number (height)
 *  timestamp     Unix ms
 *  transactions  array of Transaction plain-objects
 *  previousHash  parent block hash
 *  validator     address of the proposing validator
 *  slot          slot number in which this block was proposed
 *  epoch         epoch number
 *  stateRoot     SHA-256 of the world-state snapshot
 *  hash          SHA-256 of everything above
 *  finalized     true once ≥ 2/3 stake attests
 *  attestations  array of { validatorAddress, signature }
 */

const { sha256 } = require('../utils/hash');
const { sign, verify } = require('../utils/crypto');

class Block {
  constructor({
    index,
    timestamp,
    transactions = [],
    previousHash,
    validator,
    slot  = 0,
    epoch = 0,
    stateRoot = '',
  }) {
    this.index        = index;
    this.timestamp    = timestamp ?? Date.now();
    this.transactions = transactions;
    this.previousHash = previousHash;
    this.validator    = validator;
    this.slot         = slot;
    this.epoch        = epoch;
    this.stateRoot    = stateRoot;
    this.finalized    = false;
    this.attestations = [];
    this.hash         = this.calculateHash();
    this.signature    = null;
  }

  calculateHash() {
    return sha256({
      index:        this.index,
      timestamp:    this.timestamp,
      transactions: this.transactions,
      previousHash: this.previousHash,
      validator:    this.validator,
      slot:         this.slot,
      epoch:        this.epoch,
      stateRoot:    this.stateRoot,
    });
  }

  signingPayload() {
    return {
      hash: this.hash,
      index: this.index,
      validator: this.validator,
      slot: this.slot,
      epoch: this.epoch,
    };
  }

  signBlock(privateKey) {
    this.signature = sign(this.signingPayload(), privateKey);
    return this;
  }

  hasValidSignature(publicKey) {
    if (!this.signature || !publicKey) return false;
    return verify(this.signingPayload(), this.signature, publicKey);
  }

  /** Add an attestation object { validatorAddress, signature }. */
  addAttestation(attestation) {
    // deduplicate per validator
    const exists = this.attestations.some(
      a => a.validatorAddress === attestation.validatorAddress
    );
    if (!exists) this.attestations.push(attestation);
  }

  /** Plain-object representation for network broadcast / storage. */
  toJSON() {
    return {
      index:        this.index,
      timestamp:    this.timestamp,
      transactions: this.transactions,
      previousHash: this.previousHash,
      validator:    this.validator,
      slot:         this.slot,
      epoch:        this.epoch,
      stateRoot:    this.stateRoot,
      hash:         this.hash,
      signature:    this.signature,
      finalized:    this.finalized,
      attestations: this.attestations,
    };
  }

  static fromJSON(obj) {
    const b          = new Block(obj);
    b.hash           = obj.hash;           // preserve original hash
    b.signature      = obj.signature ?? null;
    b.finalized      = obj.finalized;
    b.attestations   = obj.attestations ?? [];
    return b;
  }

  // ── Genesis factory ─────────────────────────────────────────────────
  static genesis() {
    return new Block({
      index:        0,
      timestamp:    0,
      transactions: [],
      previousHash: '0'.repeat(64),
      validator:    'GENESIS',
      slot:         0,
      epoch:        0,
      stateRoot:    sha256('genesis'),
    });
  }
}

module.exports = Block;
