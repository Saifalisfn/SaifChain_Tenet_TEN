/**
 * Tenet (TEN) - Global Protocol Constants
 * Central configuration for all protocol parameters.
 * Chain IDs: 2048 = Mainnet, 2049 = Amoy Testnet (default)
 */

module.exports = {
  // ─── Coin ───────────────────────────────────────────────
  COIN_NAME: 'Tenet',
  COIN_SYMBOL: 'TEN',
  CHAIN_ID: parseInt(process.env.CHAIN_ID ?? '2049'),
  DECIMALS: 18,
  DEFAULT_GAS_LIMIT: 21_000,
  BLOCK_GAS_LIMIT: 30_000_000,
  DEFAULT_GAS_PRICE_WEI: 1_000_000_000,  // 1 gwei base (EVM-ready)
  DEFAULT_BASE_FEE_WEI: 0,
  FAUCET_AMOUNT: 10_000,
  FAUCET_COOLDOWN_MS: 60_000,
  GENESIS_SUPPLY: 1_000_000_000,          // 1B TEN total supply

  // ─── Block Rewards (dynamic emission via rewardSchedule.js) ──
  INITIAL_BLOCK_REWARD: 10,               // TEN/block at genesis
  BLOCKS_PER_HALVING: 12_623_040,         // ~2 years at 5 s/block
  MIN_BLOCK_REWARD: 0.1,                  // floor: never drop below
  ATTESTATION_REWARD: 1,                  // TEN per valid attestation per epoch

  // ─── Staking ────────────────────────────────────────────
  MIN_STAKE: 10_000,                      // minimum TEN to become a validator

  // ─── Slashing (per-offence rates) ──────────────────────
  SLASH_DOUBLE_VOTE: 0.20,               // equivocation vote → 20%
  SLASH_DOUBLE_PROPOSAL: 0.15,           // equivocation proposal → 15%
  SLASH_OFFLINE: 0.02,                   // offline per epoch → 2%

  // ─── Slot / Epoch ───────────────────────────────────────
  SLOT_DURATION_MS: 5_000,
  SLOTS_PER_EPOCH: 8,

  // ─── Finality ───────────────────────────────────────────
  FINALITY_THRESHOLD: 2 / 3,

  // ─── P2P ────────────────────────────────────────────────
  DEFAULT_P2P_PORT: 6001,
  DEFAULT_RPC_PORT: 3000,
  MAX_PEERS: 10,
  P2P_MAX_MESSAGE_BYTES: 65_536,
  P2P_MAX_STRIKES: 3,
  P2P_BAN_WINDOW_MS: 60_000,
  RPC_RATE_LIMIT_WINDOW_MS: 60_000,
  RPC_RATE_LIMIT_MAX_REQUESTS: 120,

  // ─── Chain selection ────────────────────────────────────
  FORK_CHOICE: 'STAKE_WEIGHT',

  // ─── Tokenomics allocation percentages ─────────────────
  ALLOC_STAKING_REWARDS_PCT: 0.30,        // 300,000,000 TEN
  ALLOC_COMMUNITY_PCT:       0.25,        // 250,000,000 TEN
  ALLOC_TREASURY_PCT:        0.20,        // 200,000,000 TEN
  ALLOC_TEAM_PCT:            0.15,        // 150,000,000 TEN
  ALLOC_PARTNERS_PCT:        0.10,        // 100,000,000 TEN

  // ─── Staking rewards pool address ───────────────────────
  STAKING_POOL_ADDRESS: '0x0000000000000000000000000000000000000001',

  // ─── Fee + Burn model ────────────────────────────────────
  TX_FEE:              1,                // 1 TEN per user transaction
  TX_FEE_BURN_PCT:     0.20,             // 20% of fee is burned
  // Remaining 80% goes to the block proposer

  // ─── Delegation / Anti-centralization ────────────────────
  MAX_VALIDATOR_STAKE_PCT: 0.33,         // no single validator > 33% total stake
  DELEGATION_MIN_AMOUNT:   100,          // minimum delegation 100 TEN

  // ─── Supply tracking addresses ───────────────────────────
  BURN_ADDRESS: '0x000000000000000000000000000000000000dEaD',
};
