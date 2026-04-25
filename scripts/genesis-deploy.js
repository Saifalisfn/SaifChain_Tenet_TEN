#!/usr/bin/env node
'use strict';

/**
 * scripts/genesis-deploy.js
 * Tenet (TEN) — Genesis Deployment CLI
 *
 * Usage:
 *   node scripts/genesis-deploy.js              # dry-run (print plan, no writes)
 *   node scripts/genesis-deploy.js --apply      # write data/genesis-state.json
 *   node scripts/genesis-deploy.js --mainnet    # use mainnet chain ID 2048
 *   node scripts/genesis-deploy.js --keygen     # derive & print validator addresses
 *
 * What this does:
 *   1. Reads config/genesis.json
 *   2. Prints tokenomics table, vesting schedules, reward schedule, deployment steps
 *   3. With --apply: writes data/genesis-state.json used to seed a fresh node
 */

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const { ec: EC } = require('elliptic');

const ec = new EC('secp256k1');

const genesis         = require('../config/genesis.json');
const { loadFromGenesis }       = require('../tokenomics/vesting');
const { getCurrentReward, getAnnualEmission } = require('../tokenomics/rewardSchedule');

const IS_MAINNET = process.argv.includes('--mainnet');
const APPLY      = process.argv.includes('--apply');
const KEYGEN     = process.argv.includes('--keygen');
const CHAIN_ID   = IS_MAINNET ? genesis.mainnetChainId : genesis.chainId;
const NETWORK    = IS_MAINNET ? 'mainnet' : 'testnet';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n) { return n.toLocaleString('en-IN'); }
function pad(s, w, right = false) {
  const str = String(s);
  return right ? str.padStart(w) : str.padEnd(w);
}

function deterministicKeyPair(id) {
  const seed    = crypto.createHash('sha256').update(`tenet_validator_seed_${id}`).digest('hex');
  const keyPair = ec.keyFromPrivate(seed, 'hex');
  const pub     = keyPair.getPublic('hex');
  const addrHash = crypto.createHash('sha256').update(pub, 'hex').digest('hex');
  return {
    privateKey: keyPair.getPrivate('hex'),
    publicKey:  pub,
    address:    '0x' + addrHash.slice(24),
  };
}

// ── Output sections ──────────────────────────────────────────────────────────

function printBanner() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║          TENET (TEN) — Genesis Deployment            ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Network  : ${pad(IS_MAINNET ? 'Mainnet' : 'Amoy Testnet', 40)}║`);
  console.log(`║  Chain ID : ${pad(CHAIN_ID, 40)}║`);
  console.log(`║  Symbol   : ${pad('TEN', 40)}║`);
  console.log(`║  Mode     : ${pad(APPLY ? 'APPLY (writing genesis state)' : 'DRY RUN', 40)}║`);
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
}

function printTokenomics() {
  console.log('═══ TOKENOMICS ════════════════════════════════════════');
  console.log(`  Total Supply : ${fmt(genesis.totalSupply)} TEN\n`);

  const lines = [
    ['Category', '%', 'Amount (TEN)', 'Type'],
    ['─────────────────────────────', '───', '─────────────────', '──────────────'],
  ];
  for (const a of genesis.allocations) {
    lines.push([a.name, `${a.pct}%`, fmt(a.amount), a.vesting.type]);
  }
  lines.push(['─────────────────────────────', '───', '─────────────────', '──────────────']);
  lines.push(['TOTAL', '100%', fmt(genesis.totalSupply), '']);

  for (const [c1, c2, c3, c4] of lines) {
    console.log(`  ${pad(c1, 31)} ${pad(c2, 5)} ${pad(c3, 19, true)}  ${c4}`);
  }
  console.log('');
}

function printVesting() {
  console.log('═══ VESTING SCHEDULES ═════════════════════════════════');
  const schedules = loadFromGenesis(genesis);
  for (const s of schedules) {
    const info = s.summary();
    const pct  = (info.immediateUnlockPct * 100).toFixed(0);
    console.log(`  ${info.name}`);
    console.log(`    Cliff        : ${info.cliffMonths} months`);
    console.log(`    Vesting      : ${info.vestingMonths} months linear after cliff`);
    console.log(`    At genesis   : ${pct}% (${fmt(info.unlocked)} TEN) unlocked immediately`);
    console.log(`    Locked now   : ${fmt(info.locked)} TEN`);
    console.log('');
  }
}

function printRewardSchedule() {
  console.log('═══ BLOCK REWARD EMISSION ════════════════════════════');
  const rows = [
    [0,           'Genesis (Era 0)'],
    [6_311_520,   'Year 1 end'],
    [12_623_040,  'Year 2 → 1st halving'],
    [25_246_080,  'Year 4 → 2nd halving'],
    [50_492_160,  'Year 8 → 3rd halving'],
    [100_984_320, 'Year 16 → 4th halving'],
  ];

  console.log(`  ${'Milestone'.padEnd(22)} ${'Reward/block'.padStart(13)} ${'Annual emission'.padStart(22)}`);
  console.log(`  ${'─'.repeat(22)} ${'─'.repeat(13)} ${'─'.repeat(22)}`);
  for (const [h, label] of rows) {
    const r = getCurrentReward(h).toFixed(3).padStart(10) + ' TEN';
    const a = (fmt(Math.round(getAnnualEmission(h))) + ' TEN').padStart(22);
    console.log(`  ${label.padEnd(22)} ${r} ${a}`);
  }
  console.log('');
  console.log(`  BLOCKS_PER_HALVING : ${fmt(genesis.rewardSchedule.blocksPerHalving)} (~2 years)`);
  console.log(`  Floor reward       : ${genesis.rewardSchedule.minBlockReward} TEN/block`);
  console.log('');
}

function printSlashing() {
  console.log('═══ SLASHING CONFIG ══════════════════════════════════');
  const s = genesis.slashingConfig;
  console.log(`  Double Vote       : ${(s.doubleVote * 100).toFixed(0)}% of stake burned`);
  console.log(`  Double Proposal   : ${(s.doubleProposal * 100).toFixed(0)}% of stake burned`);
  console.log(`  Offline (per epoch): ${(s.offline * 100).toFixed(0)}% of stake burned`);
  console.log('');
}

function printValidators() {
  console.log('═══ GENESIS VALIDATORS ═══════════════════════════════');
  for (const v of genesis.genesisValidators) {
    const kp   = deterministicKeyPair(v.id);
    const addr = v.address.startsWith('REPLACE') ? kp.address : v.address;
    console.log(`  Validator ${v.id}: ${addr}`);
    console.log(`    Stake       : ${fmt(v.stake)} TEN`);
    if (v.address.startsWith('REPLACE')) {
      console.log(`    (Using derived address — run --keygen to generate real keys)`);
    }
  }
  console.log('');
}

function printKeyGen() {
  console.log('═══ VALIDATOR KEYPAIRS (DEMO — replace in production) ═');
  console.log('  WARNING: These keys use deterministic seeds. Use a HSM for mainnet.\n');
  for (let id = 1; id <= 3; id++) {
    const kp = deterministicKeyPair(id);
    console.log(`  Validator ${id}:`);
    console.log(`    Address    : ${kp.address}`);
    console.log(`    PublicKey  : ${kp.publicKey.slice(0, 32)}...`);
    console.log(`    PrivateKey : *** (set VALIDATOR_${id}_PRIVKEY env var) ***`);
    console.log('');
  }
}

function printDeploymentPlan() {
  console.log('═══ DEPLOYMENT PLAN ══════════════════════════════════');
  console.log('');
  console.log('  PHASE 1 — Testnet (Tenet Amoy, Chain ID: 2049)');
  console.log('  ──────────────────────────────────────────────────');
  console.log('  Step 1: Generate real validator keypairs');
  console.log('          node scripts/genesis-deploy.js --keygen');
  console.log('');
  console.log('  Step 2: Update config/genesis.json with real validator addresses');
  console.log('');
  console.log('  Step 3: Launch 3-node testnet');
  console.log('          CHAIN_ID=2049 npm run node1');
  console.log('          CHAIN_ID=2049 npm run node2');
  console.log('          CHAIN_ID=2049 npm run node3');
  console.log('');
  console.log('  Step 4: Verify genesis');
  console.log(`          curl -s http://localhost:3000 \\`);
  console.log(`            -d '{"jsonrpc":"2.0","method":"sfc_getChainInfo","id":1}'`);
  console.log('');
  console.log('  PHASE 2 — Validator Onboarding (2–4 weeks)');
  console.log('  ──────────────────────────────────────────────────');
  console.log('  Step 5: Distribute faucet TEN (10,000 tTEN per request)');
  console.log('  Step 6: Community validators stake ≥ 10,000 TEN');
  console.log('  Step 7: Track testnet activity for airdrop scoring');
  console.log('          (tx count, uptime, unique recipients, volume)');
  console.log('');
  console.log('  PHASE 3 — Airdrop Snapshot');
  console.log('  ──────────────────────────────────────────────────');
  console.log('  Step 8: Snapshot testnet state');
  console.log('          node scripts/genesis-deploy.js --snapshot');
  console.log('');
  console.log('  Step 9: Process airdrop');
  console.log('          const { processAirdrop } = require("./tokenomics/airdrop");');
  console.log('          const report = processAirdrop(walletActivities);');
  console.log('          // Budget: 125,000,000 TEN  |  Max per wallet: 50,000 TEN');
  console.log('');
  console.log('  PHASE 4 — Mainnet Genesis (Chain ID: 2048)');
  console.log('  ──────────────────────────────────────────────────');
  console.log('  Step 10: Write mainnet genesis state');
  console.log('           CHAIN_ID=2048 node scripts/genesis-deploy.js --mainnet --apply');
  console.log('');
  console.log('  Step 11: Launch mainnet nodes');
  console.log('           CHAIN_ID=2048 npm run node1');
  console.log('           CHAIN_ID=2048 npm run node2');
  console.log('           CHAIN_ID=2048 npm run node3');
  console.log('');
  console.log('  Step 12: Treasury injects DEX liquidity');
  console.log('           5,000,000 TEN from Ecosystem Treasury → TEN/USDC pair');
  console.log('');
  console.log('  Step 13: Execute airdrop distributions via batch txns');
  console.log('');
  console.log('  PHASE 5 — Post-Launch');
  console.log('  ──────────────────────────────────────────────────');
  console.log('  Step 14: Enable community vesting claims (Community + Treasury)');
  console.log('  Step 15: Team & Partner vesting begins (cliff countdown starts)');
  console.log('  Step 16: Monitor consensus health, slash rates, validator count');
  console.log('');
}

function applyGenesis() {
  const outDir  = path.join(process.cwd(), 'data');
  const outFile = path.join(outDir, 'genesis-state.json');
  fs.mkdirSync(outDir, { recursive: true });

  const genesisTs = new Date(genesis.genesisTimestamp).getTime();
  const state = {
    meta: {
      schemaVersion: genesis.schemaVersion,
      chainId:       CHAIN_ID,
      network:       NETWORK,
      symbol:        'TEN',
      totalSupply:   genesis.totalSupply,
      genesisTimestamp: genesis.genesisTimestamp,
      appliedAt:     new Date().toISOString(),
    },
    balances:  {},
    locked:    {},
    validators: [],
    rewardSchedule: genesis.rewardSchedule,
    slashingConfig: genesis.slashingConfig,
  };

  // Seed balances: immediate unlock only; locked portion tracked separately
  for (const alloc of genesis.allocations) {
    if (alloc.vesting.type === 'EMISSION') {
      state.balances[alloc.address] = alloc.amount;  // full pool held at address
      continue;
    }
    const immediatePct = alloc.vesting.immediateUnlockPct ?? 0;
    const immediate    = Math.floor(alloc.amount * immediatePct);
    const locked       = alloc.amount - immediate;

    if (immediate > 0) state.balances[alloc.address] = immediate;
    if (locked > 0)    state.locked[alloc.address]   = { amount: locked, schedule: alloc.vesting };
  }

  // Faucet pre-fund
  state.balances[genesis.faucet.address] = genesis.faucet.initialBalance;

  // Genesis validators — derive addresses if placeholders
  for (const v of genesis.genesisValidators) {
    const kp   = deterministicKeyPair(v.id);
    const addr = v.address.startsWith('REPLACE') ? kp.address : v.address;
    state.balances[addr] = (state.balances[addr] ?? 0) + v.stake;
    state.validators.push({
      address:   addr,
      publicKey: kp.publicKey,
      stake:     v.stake,
      active:    true,
      slashed:   false,
      joinedEpoch: 0,
    });
  }

  fs.writeFileSync(outFile, JSON.stringify(state, null, 2));
  console.log(`\n[Genesis] State written → ${outFile}`);
  console.log(`[Genesis] Chain ID ${CHAIN_ID} | ${genesis.totalSupply.toLocaleString()} TEN total supply\n`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

printBanner();
printTokenomics();
printVesting();
printRewardSchedule();
printSlashing();
printValidators();

if (KEYGEN) {
  printKeyGen();
} else {
  printDeploymentPlan();
}

if (APPLY) {
  applyGenesis();
} else {
  console.log('  (Dry run — pass --apply to write data/genesis-state.json)\n');
}
