# Contributing to SaifChain

Thanks for your interest in contributing to SaifChain (Tenet / TEN)! 🎉

---

## Getting Started

### Prerequisites

- **Node.js** ≥ 18.0.0
- **npm** ≥ 9.0.0
- **Git**

### Setup

```bash
# 1. Fork the repo on GitHub, then clone your fork
git clone https://github.com/YOUR_USERNAME/SaifChain_Tenet_TEN.git
cd SaifChain_Tenet_TEN

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env

# 4. Start a single node
npm start
```

---

## Project Structure

See [README.md](./README.md) for the full architecture overview.

Key directories:
| Directory | Purpose |
|-----------|---------|
| `blockchain/` | Block, transaction, coin, state |
| `consensus/` | Slot engine, proposer selection, finality |
| `staking/` | Validator registry, slashing |
| `p2p/` | WebSocket gossip network |
| `rpc/` | JSON-RPC HTTP server |
| `tokenomics/` | Reward schedule, vesting, airdrop |
| `public/` | Browser dashboard, explorer, wallet |
| `scripts/` | Node launcher, genesis, integration tests |

---

## Running a Multi-Node Testnet

Open 3 terminals:

```bash
# Terminal 1 – Node 1 (genesis)
npm run node1

# Terminal 2 – Node 2
npm run node2

# Terminal 3 – Node 3
npm run node3
```

---

## Running Tests

```bash
npm run test:integration
```

---

## Coding Standards

- **Style**: 2-space indent, single quotes, semicolons
- **Comments**: Keep existing JSDoc and inline comments
- **Modules**: CommonJS (`require` / `module.exports`)
- **No breaking changes** to the JSON-RPC API surface without a version bump

---

## Submitting a Pull Request

1. Create a feature branch: `git checkout -b feat/my-feature`
2. Make your changes and commit with a clear message
3. Push to your fork and open a PR against `main`
4. Describe **what** you changed and **why**

---

## Reporting Issues

Open a GitHub Issue with:
- Node.js version
- Steps to reproduce
- Expected vs. actual behaviour

---

## License

By contributing, you agree that your contributions will be licensed under the **MIT License**.

Made with ❤️ by [Saif Ali](https://github.com/Saifalisfn)
