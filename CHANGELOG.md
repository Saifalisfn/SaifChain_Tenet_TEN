# Changelog

All notable changes to SaifChain (Tenet / TEN) are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.1.0] — 2026-04-26

### Added
- **Core blockchain** — block structure, SHA-256 hashing, chain management, fork choice
- **Proof-of-Stake consensus** — slot engine, epoch manager, VRF-lite proposer selection
- **Attestation & finality** — 2/3 stake threshold finality with committee voting
- **TEN coin** — mint, burn, transfer, per-account nonces, genesis supply (1B TEN)
- **Staking module** — validator registry, stake locking, epoch rewards, delegation
- **Slashing** — double-vote (20%), double-proposal (15%), offline (2%/epoch)
- **P2P network** — WebSocket gossip, peer discovery from env, message validation
- **JSON-RPC 2.0 API** — 10+ methods: `sfc_blockNumber`, `sfc_getBalance`, `sfc_sendTransaction`, etc.
- **Tokenomics** — halving schedule, vesting, airdrop, fee burn (20%), treasury allocation
- **Persistent storage** — JSON-file chain state per node with graceful shutdown flush
- **Browser UI**
  - Node Console dashboard (`/`)
  - Block Explorer (`/explorer.html`) — React, live-updating, searchable
  - Browser Wallet (`/wallet.html`) — in-browser keygen, signing, faucet
- **Multi-node scripts** — `npm run node1/node2/node3` for a 3-validator testnet
- **Genesis deploy script** — `scripts/genesis-deploy.js`
- **Integration test** — `scripts/integration-test.js`
- `.gitignore` — excludes `node_modules/`, `.env`, `data/`
- `.env.example` — safe contributor template
- `CONTRIBUTING.md` — developer guide
- `CHANGELOG.md` — this file

### Protocol Parameters (v0.1.0 defaults)
| Parameter | Value |
|-----------|-------|
| Chain ID | 2049 (Amoy Testnet) |
| Total Supply | 1,000,000,000 TEN |
| Slot Duration | 5,000 ms |
| Slots per Epoch | 8 |
| Min Validator Stake | 10,000 TEN |
| Initial Block Reward | 10 TEN |
| Halving Interval | 12,623,040 blocks (~2 years) |
| Finality Threshold | 2/3 stake |
| Slash (double-vote) | 20% |

---

_SaifChain is built for educational purposes. Not production-ready._
