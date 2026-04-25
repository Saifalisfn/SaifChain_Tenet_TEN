/**
 * index.js
 * SaifChain – Main Entry Point
 *
 * Wires all modules together and starts the node.
 *
 * Environment variables
 * ─────────────────────
 *   P2P_PORT     WebSocket server port          (default: 6001)
 *   RPC_PORT     JSON-RPC HTTP port             (default: 3000)
 *   PEERS        Comma-separated ws:// URLs     (default: none)
 *   VALIDATOR_ID Numeric ID for demo validators (default: 1)
 *
 * Quick start (3 nodes)
 * ─────────────────────
 *   node index.js
 *   P2P_PORT=6002 RPC_PORT=3001 PEERS=ws://localhost:6001 VALIDATOR_ID=2 node index.js
 *   P2P_PORT=6003 RPC_PORT=3002 PEERS=ws://localhost:6001,ws://localhost:6002 VALIDATOR_ID=3 node index.js
 */

'use strict';

const path = require('path');
const loadEnvFile = require('./config/loadEnv');
const loadedEnvPath = loadEnvFile(process.env.ENV_FILE || '.env');
const { publicKeyToAddress } = require('./utils/crypto');
const PersistentStore = require('./storage/persistentStore');

// ── Core modules ──────────────────────────────────────────────────────
const Blockchain        = require('./blockchain/blockchain');
const Staking           = require('./staking/staking');
const { Slashing }      = require('./staking/slashing');
const SlotEngine        = require('./consensus/slotEngine');
const EpochManager      = require('./consensus/epochManager');
const ValidatorSelection= require('./consensus/validatorSelection');
const Attestation       = require('./consensus/attestation');
const Finality          = require('./consensus/finality');
const P2PNetwork        = require('./p2p/p2p');
const PeerDiscovery     = require('./p2p/peerDiscovery');
const MSG               = require('./p2p/messageTypes');
const RPCServer         = require('./rpc/server');
const ValidatorNode     = require('./validator/validatorNode');
const constants         = require('./config/constants');

// ── Config from env ───────────────────────────────────────────────────
const P2P_PORT     = parseInt(process.env.P2P_PORT  ?? constants.DEFAULT_P2P_PORT);
const RPC_PORT     = parseInt(process.env.RPC_PORT  ?? constants.DEFAULT_RPC_PORT);
const VALIDATOR_ID = parseInt(process.env.VALIDATOR_ID ?? 1);
const DATA_DIR     = process.env.DATA_DIR ?? path.join(process.cwd(), 'data', `node-${VALIDATOR_ID}`);

// ── Demo: deterministic key derivation from validator ID ──────────────
// In production each node loads its key from a secure keystore.
const crypto = require('crypto');
function deterministicKeyPair(id) {
  // Create a seeded private key from the ID (DEMO ONLY — never do this in prod)
  const { ec: EC } = require('elliptic');
  const ec = new EC('secp256k1');
  const seed = crypto.createHash('sha256').update(`saifchain_validator_seed_${id}`).digest('hex');
  const keyPair = ec.keyFromPrivate(seed, 'hex');
  return {
    privateKey: keyPair.getPrivate('hex'),
    publicKey:  keyPair.getPublic('hex'),
  };
}

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║      Tenet (TEN) – Layer-1 PoL Node      ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`Validator ID : ${VALIDATOR_ID}`);
  console.log(`P2P port     : ${P2P_PORT}`);
  console.log(`RPC port     : ${RPC_PORT}`);
  console.log(`Env file     : ${loadedEnvPath}`);
  console.log(`Data dir     : ${DATA_DIR}`);
  console.log('');

  // 1. Key pair
  const { privateKey, publicKey } = deterministicKeyPair(VALIDATOR_ID);
  const address = publicKeyToAddress(publicKey);
  console.log(`[Init] Address : ${address}`);
  const store = new PersistentStore(DATA_DIR);
  const persisted = store.load();
  let persist = () => {};

  // 2. Blockchain + State
  const blockchain = new Blockchain({
    snapshot: persisted?.blockchain,
    onChange: () => persist(),
  });

  // 3. Staking + Slashing
  const staking  = new Staking(blockchain.state, { onChange: () => persist() });
  if (persisted?.staking) {
    staking.loadSnapshot(persisted.staking);
  }

  // Fund validator from genesis community allocation (testnet only).
  // In production, validators receive TEN via genesis distribution or faucet.
  if (!persisted) {
    blockchain.state.coin.mint(address, 100_000);
  }
  console.log(`[Init] Minted 100,000 TEN to validator ${address.slice(0,14)}…`);

  const slashing = new Slashing(staking, { onChange: () => persist() });
  if (persisted?.slashing) {
    slashing.loadSnapshot(persisted.slashing);
  }

  persist = () => {
    store.schedule(() => ({
      version: 1,
      validatorAddress: address,
      blockchain: blockchain.snapshot(),
      staking: staking.snapshot(),
      slashing: slashing.getSlashLog(),
    }));
  };
  persist();

  // 4. Consensus modules
  const slotEngine         = new SlotEngine();
  const validatorSelection = new ValidatorSelection(staking);
  const attestation        = new Attestation(staking);
  const finality           = new Finality(attestation, staking);
  const epochManager       = new EpochManager(staking, attestation, slashing);

  // 5. P2P Network
  const p2p = new P2PNetwork(blockchain, P2P_PORT);
  await p2p.start();

  // 6. Peer discovery
  const discovery = new PeerDiscovery(p2p);
  discovery.connectFromEnv();

  // 7. RPC Server
  const rpc = new RPCServer(blockchain, staking, slashing, RPC_PORT, {
    onMutation: () => persist(),
    broadcastTransaction: txData => p2p.broadcast(MSG.TRANSACTION, txData),
  });
  await rpc.start();

  // 8. Validator Node
  const validator = new ValidatorNode(
    { address, publicKey, privateKey, initialStake: 50_000 },
    blockchain, staking, slashing,
    slotEngine, epochManager,
    validatorSelection, attestation, finality,
    p2p
  );

  await validator.start();

  // ── Graceful shutdown ────────────────────────────────────────────
  const flushState = () => {
    store.flush(() => ({
      version: 1,
      validatorAddress: address,
      blockchain: blockchain.snapshot(),
      staking: staking.snapshot(),
      slashing: slashing.getSlashLog(),
    }));
  };

  process.prependListener('SIGINT', flushState);
  process.prependListener('SIGTERM', flushState);
  process.on('SIGINT', () => {
    console.log('\n[Node] Shutting down…');
    slotEngine.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    console.log('\n[Node] Shutting down...');
    slotEngine.stop();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[Fatal]', err);
  process.exit(1);
});
