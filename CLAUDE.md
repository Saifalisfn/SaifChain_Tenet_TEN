# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                    # install dependencies
npm start                      # single-node (P2P:6001, RPC:3000)
npm run node1                  # node 1 of 3-node cluster
npm run node2                  # node 2 of 3-node cluster
npm run node3                  # node 3 of 3-node cluster
npm run test:integration       # full E2E suite (~2 min, spawns 3 nodes)
```

Multi-node manual (3 terminals):
```bash
node index.js
P2P_PORT=6002 RPC_PORT=3001 PEERS=ws://localhost:6001 VALIDATOR_ID=2 node index.js
P2P_PORT=6003 RPC_PORT=3002 PEERS=ws://localhost:6001,ws://localhost:6002 VALIDATOR_ID=3 node index.js
```

No linter/formatter configured. No unit test framework — tests are integration-only (`scripts/integration-test.js`).

## Architecture

JavaScript (Node.js ≥18), no build step. Single binary runs all roles. SQLite persistence in `data/node-{ID}/node-state.db`.

### Module Map

| Dir | Responsibility |
|-----|---------------|
| `blockchain/` | Block/tx structure, chain state, mempool, fork choice |
| `consensus/` | Slot engine, epoch manager, proposer selection, attestation, finality |
| `staking/` | Validator registry, stake, rewards |
| `p2p/` | WebSocket gossip, peer discovery, ban logic |
| `rpc/` | Express JSON-RPC 2.0 HTTP server |
| `storage/` | SQLite persistence (blocks, balances, stakes, slash log) |
| `utils/` | secp256k1 ECDSA signing, SHA-256 hashing |
| `validator/` | Full validator node orchestrator (proposes + attests + finalizes) |
| `config/` | Protocol constants, `.env` loader |

### Consensus Flow

Slots are 5 s (`SLOT_DURATION_MS`). 8 slots per epoch = 40 s.

Each slot (`consensus/slotEngine.js` emits `slot` event):
1. `validatorSelection.js` picks weighted-random proposer
2. Proposer builds block, signs it, gossips `BLOCK` message
3. All validators verify and send `ATTESTATION` vote
4. `finality.js` checks 2/3 stake threshold → marks block finalized

Each epoch end (`epochManager.js`):
- Distribute `BLOCK_REWARD` (10 SFC) + `ATTESTATION_REWARD` (1 SFC)
- Slash offline validators 10%

### Security Invariants

- **Replay protection**: nonce per sender; reject if nonce ≤ stored nonce
- **Double-vote**: same validator attesting two different blocks in same slot → `slashing.js` slashes 10%
- **Double-proposal**: same validator proposing two blocks in same slot → slash 10%
- **P2P strikes**: malformed/invalid messages increment peer strike counter; 3 strikes = temporary ban (`P2P_MAX_STRIKES=3`)
- **Message dedup**: seen-ID ring buffer in `p2p/p2p.js` prevents gossip loops

### State Model

`blockchain/state.js` holds world state: balances, nonces, validator stakes. Applied atomically per finalized block. `coin.js` is the balance ledger (mint/burn/transfer); it does not handle consensus — it is called by `blockchain.js` state application.

### Key Constants (`config/constants.js`)

`MIN_STAKE=100 SFC`, `SLASH_PERCENTAGE=10`, `GENESIS_SUPPLY=1_000_000 SFC`, `CHAIN_ID=31337`, `FAUCET_AMOUNT=1000 SFC`, `MAX_PEERS=10`, `P2P_MAX_MESSAGE_BYTES=65536`.

### RPC API

JSON-RPC 2.0 on `RPC_PORT`. Key methods: `sfc_blockNumber`, `sfc_getBalance`, `sfc_sendTransaction`, `sfc_getBlockByNumber`, `sfc_getValidators`, `sfc_getTransactionPool`, `sfc_getSlashLog`, `sfc_getChainInfo`, `sfc_requestFaucet`. See `rpc/methods.js` for full implementations.

### Node Startup Flow

`index.js` → loads env → creates `ValidatorNode` (`validator/validatorNode.js`) → wires blockchain + consensus + staking + P2P + RPC + storage → starts slot engine → connects to bootstrap peers from `PEERS` env var.
