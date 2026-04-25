/**
 * p2p/messageTypes.js
 * Protocol message type identifiers for the gossip network.
 *
 * Every P2P message is a JSON envelope:
 * {
 *   type:    MESSAGE_TYPE,
 *   payload: <type-specific object>,
 *   sender:  <originating node address>,
 *   id:      <SHA-256 of payload — for deduplication>
 * }
 */

const MESSAGE_TYPES = {
  // Sent when a block is proposed or finalized
  BLOCK:         'BLOCK',
  // A single pending transaction
  TRANSACTION:   'TRANSACTION',
  // An attestation vote from a validator
  ATTESTATION:   'ATTESTATION',
  // Full chain sent for sync
  CHAIN_SYNC:    'CHAIN_SYNC',
  // Peer requests our chain
  REQUEST_CHAIN: 'REQUEST_CHAIN',
  // Share validator records across peers
  VALIDATOR_SYNC: 'VALIDATOR_SYNC',
  // Peer requests validator set
  REQUEST_VALIDATORS: 'REQUEST_VALIDATORS',
  // Peer announces its listening port (for discovery)
  HELLO:         'HELLO',
};

module.exports = MESSAGE_TYPES;
