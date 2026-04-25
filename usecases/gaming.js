'use strict';

/**
 * usecases/gaming.js
 * On-chain game result anchoring for Tenet (TEN).
 *
 * Use case: "Loot" or any provably-fair game
 *
 * Flow:
 *   1. Game session ends → backend computes result
 *   2. Call anchorResult() → stores hash on-chain via a zero-value tx
 *   3. Anyone can verify result integrity using verifyResult()
 *
 * On-chain data (packed into tx memo via a special address):
 *   { gameId, resultHash, playerId, timestamp, reward }
 *
 * The GAMING_REGISTRY_ADDRESS receives zero-value txs whose txId encodes
 * the game result hash. This gives:
 *   - Immutable timestamp proof
 *   - Public verifiability
 *   - No smart contract required
 *
 * RPC entry point:
 *   POST /rpc  { "method": "ten_anchorGameResult", "params": [sessionData] }
 *   POST /rpc  { "method": "ten_verifyGameResult", "params": [gameId, resultHash] }
 */

const crypto = require('crypto');
const Transaction = require('../blockchain/transaction');
const { sha256 }  = require('../utils/hash');

const GAMING_REGISTRY_ADDRESS = '0x0000000000000000000000000000000000001337';

/**
 * Compute a deterministic result hash for a game session.
 * @param {object} session
 * @param {string}  session.gameId       unique game instance ID
 * @param {string}  session.playerId     player address or ID
 * @param {any}     session.result       game outcome (score, loot, etc.)
 * @param {number}  [session.timestamp]  Unix ms (default: now)
 * @returns {string} hex hash
 */
function computeResultHash(session) {
  const payload = {
    gameId:    session.gameId,
    playerId:  session.playerId,
    result:    session.result,
    timestamp: session.timestamp ?? Date.now(),
  };
  return sha256(payload);
}

/**
 * Build an on-chain anchor transaction for a game result.
 * The tx is a zero-value transfer to GAMING_REGISTRY_ADDRESS.
 * The txId encodes the result hash (deterministic, verifiable).
 *
 * @param {object} session
 * @param {string} privateKey   signer's private key
 * @param {string} publicKey    signer's public key
 * @param {string} fromAddress  signer's address
 * @param {number} nonce        account nonce
 * @returns {Transaction}
 */
function buildAnchorTx(session, { privateKey, publicKey, fromAddress, nonce }) {
  const resultHash = computeResultHash(session);

  // Encode session metadata as amount=0 with resultHash as part of payload
  // (This is a convention; full smart-contract encoding is future work)
  const tx = new Transaction({
    from:      fromAddress,
    to:        GAMING_REGISTRY_ADDRESS,
    amount:    0,          // zero-value anchor
    nonce,
    publicKey,
    timestamp: session.timestamp ?? Date.now(),
  });

  // Override txId to encode the result hash for direct lookup
  tx.txId    = resultHash;
  tx.meta    = { type: 'GAME_ANCHOR', gameId: session.gameId, resultHash, playerId: session.playerId };
  tx.signature = 'GAME_ANCHOR';  // placeholder; real impl signs the result hash
  return tx;
}

/**
 * Verify a game result against on-chain records.
 * @param {import('../blockchain/blockchain')} blockchain
 * @param {string} gameId
 * @param {object} claimedResult  the result to verify
 * @returns {{ valid: boolean, anchoredHash: string | null, blockNumber: number | null }}
 */
function verifyResult(blockchain, gameId, playerId, claimedResult, timestamp) {
  const expectedHash = computeResultHash({ gameId, playerId, result: claimedResult, timestamp });
  const record       = blockchain.getTransactionById(expectedHash);

  if (!record) {
    return { valid: false, anchoredHash: null, blockNumber: null, message: 'Not anchored on-chain' };
  }

  return {
    valid:        true,
    anchoredHash: expectedHash,
    blockNumber:  record.blockIndex,
    blockHash:    record.blockHash,
    message:      'Result verified on-chain',
  };
}

/**
 * Build RPC method handlers for gaming integration.
 * Inject into buildMethods() in rpc/methods.js.
 */
function buildGamingMethods(blockchain, staking, options = {}) {
  const { broadcastTransaction = () => {} } = options;

  return {
    ten_anchorGameResult([sessionData]) {
      const { gameId, playerId, result, timestamp, signerAddress, nonce } = sessionData ?? {};
      if (!gameId || !playerId || result === undefined) {
        throw new Error('gameId, playerId, result required');
      }

      const resultHash = computeResultHash({ gameId, playerId, result, timestamp });

      // Record without actual transaction signing (backend-only mode)
      // In production: client signs and submits via eth_sendRawTransaction
      return {
        gameId,
        resultHash,
        anchoredAt: timestamp ?? Date.now(),
        instruction: `Submit tx to ${GAMING_REGISTRY_ADDRESS} with value=0 and nonce=${nonce ?? 0} to anchor on-chain`,
        registryAddress: GAMING_REGISTRY_ADDRESS,
      };
    },

    ten_verifyGameResult([gameId, playerId, claimedResult, timestamp]) {
      return verifyResult(blockchain, gameId, playerId, claimedResult, timestamp);
    },

    ten_getGameRegistry() {
      return {
        registryAddress: GAMING_REGISTRY_ADDRESS,
        description:     'Send zero-value tx to this address with resultHash as txId to anchor game results',
      };
    },
  };
}

module.exports = { computeResultHash, buildAnchorTx, verifyResult, buildGamingMethods, GAMING_REGISTRY_ADDRESS };
