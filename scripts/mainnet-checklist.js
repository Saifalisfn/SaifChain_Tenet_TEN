#!/usr/bin/env node
'use strict';

/**
 * scripts/mainnet-checklist.js
 * Tenet (TEN) — Pre-Launch Checklist
 *
 * Runs automated checks + prints a launch checklist.
 * Usage: node scripts/mainnet-checklist.js [--rpc http://localhost:3000]
 */

const https = require('https');
const http  = require('http');
const path  = require('path');

const RPC_URL = process.argv.find(a => a.startsWith('--rpc='))?.split('=')[1] ?? 'http://localhost:3000';

// ── Helpers ──────────────────────────────────────────────────────────────────
function rpc(method, params = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 });
    const url  = new URL(`${RPC_URL}/rpc`);
    const lib  = url.protocol === 'https:' ? https : http;

    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { const j = JSON.parse(data); j.error ? reject(new Error(j.error.message)) : resolve(j.result); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const C = { reset:'\x1b[0m', green:'\x1b[32m', red:'\x1b[31m', yellow:'\x1b[33m', cyan:'\x1b[36m', bold:'\x1b[1m' };
const OK   = `${C.green}✓${C.reset}`;
const FAIL = `${C.red}✗${C.reset}`;
const WARN = `${C.yellow}⚠${C.reset}`;
const NA   = `${C.yellow}—${C.reset}`;

let passed = 0, failed = 0, warned = 0;

function check(label, result, advice = '') {
  if (result === true)  { console.log(`  ${OK}  ${label}`); passed++; }
  else if (result === 'warn') { console.log(`  ${WARN}  ${label}${advice ? ` (${advice})` : ''}`); warned++; }
  else if (result === 'na')   { console.log(`  ${NA}  ${label} — ${advice}`); }
  else { console.log(`  ${FAIL}  ${label}${advice ? `\n       ${C.red}→ ${advice}${C.reset}` : ''}`); failed++; }
}

async function runChecks() {
  console.log('');
  console.log(`${C.bold}${C.cyan}╔══════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║     Tenet (TEN) — Mainnet Launch Checklist      ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚══════════════════════════════════════════════════╝${C.reset}`);
  console.log(`  RPC: ${RPC_URL}`);
  console.log('');

  // ── Phase 1: Node Health ────────────────────────────────────────────────
  console.log(`${C.bold}PHASE 1 — Node Health${C.reset}`);
  let chainInfo, supply, validators, slashLog;

  try {
    chainInfo = await rpc('ten_chainInfo');
    check('Node is responding',              true);
    check('Chain name is Tenet',             chainInfo.name === 'Tenet');
    check('Symbol is TEN',                   chainInfo.symbol === 'TEN');
    check('Chain ID configured',             chainInfo.chainId > 0, `chainId=${chainInfo.chainId}`);
    check('Chain progressing (height ≥ 1)', chainInfo.height >= 1, `height=${chainInfo.height}`);
    check('Validators online',               chainInfo.validators >= 1, `count=${chainInfo.validators}`);
    check('3+ validators (production-ready)', chainInfo.validators >= 3,
      chainInfo.validators < 3 ? `only ${chainInfo.validators} — need 3 for Byzantine fault tolerance` : '');
  } catch (e) {
    check('Node is responding', false, `Cannot connect to ${RPC_URL}: ${e.message}`);
    console.log(`\n  ${FAIL} Node not reachable — run remaining checks after node starts.\n`);
    printManualChecklist();
    return;
  }
  console.log('');

  // ── Phase 2: Tokenomics ─────────────────────────────────────────────────
  console.log(`${C.bold}PHASE 2 — Tokenomics & Supply${C.reset}`);
  try {
    supply = await rpc('ten_getSupply');
    check('Supply tracker running',             !!supply);
    check('Hard cap = 1,000,000,000 TEN',       supply.totalSupply === 1_000_000_000, `got ${supply.totalSupply}`);
    check('Minted ≤ hard cap',                  supply.mintedSupply <= 1_000_000_000, `minted=${supply.mintedSupply}`);
    check('Circulating supply > 0',             supply.circulatingSupply > 0, `circulating=${supply.circulatingSupply}`);
    const inflationPct = (supply.mintedSupply / supply.totalSupply) * 100;
    check('Initial inflation < 5% of total',    inflationPct < 5, `${inflationPct.toFixed(4)}%`);
  } catch (e) {
    check('Supply tracker', false, e.message);
  }
  console.log('');

  // ── Phase 3: Validators ─────────────────────────────────────────────────
  console.log(`${C.bold}PHASE 3 — Validators & Staking${C.reset}`);
  try {
    validators = await rpc('sfc_getValidators');
    const active  = validators.filter(v => v.active && !v.slashed);
    const slashed = validators.filter(v => v.slashed);
    check('Active validators found',            active.length >= 1);
    check('No genesis validators slashed',      slashed.length === 0, `${slashed.length} slashed`);
    check('All validators have stake > 0',      active.every(v => v.stake > 0), 'some have 0 stake');
    const totalStake = active.reduce((s, v) => s + v.stake, 0);
    const maxStakePct = active.reduce((m, v) => Math.max(m, v.stake / totalStake), 0);
    check('No validator >33% of stake (decentralized)', maxStakePct < 0.34,
      `max=${(maxStakePct * 100).toFixed(1)}% — consider adding more validators`);
  } catch (e) {
    check('Validators query', false, e.message);
  }
  console.log('');

  // ── Phase 4: Slashing ───────────────────────────────────────────────────
  console.log(`${C.bold}PHASE 4 — Slashing & Security${C.reset}`);
  try {
    slashLog = await rpc('sfc_getSlashLog');
    check('Slash log accessible',               true);
    check('No unexpected slashes at genesis',   slashLog.length === 0, `${slashLog.length} slash events`);
  } catch (e) {
    check('Slash log', false, e.message);
  }
  console.log('');

  // ── Phase 5: RPC Surface ────────────────────────────────────────────────
  console.log(`${C.bold}PHASE 5 — RPC & EVM Compatibility${C.reset}`);
  try {
    const chainIdHex = await rpc('eth_chainId');
    check('eth_chainId responds',               !!chainIdHex);
    check('Chain ID matches config',            parseInt(chainIdHex, 16) === chainInfo.chainId);
    const netVer = await rpc('net_version');
    check('net_version responds',               netVer === String(chainInfo.chainId));
    const gasPrice = await rpc('eth_gasPrice');
    check('eth_gasPrice responds',              !!gasPrice);
  } catch (e) {
    check('EVM RPC surface', false, e.message);
  }
  console.log('');

  // ── Phase 6: Block Production ───────────────────────────────────────────
  console.log(`${C.bold}PHASE 6 — Block Production${C.reset}`);
  try {
    const h1 = await rpc('sfc_blockNumber');
    await new Promise(r => setTimeout(r, 6000));  // wait 1 slot
    const h2 = await rpc('sfc_blockNumber');
    check('Chain is producing blocks', h2 > h1, `height went from ${h1} to ${h2} in 6s`);
    check('Block time ≈ 5s',           h2 - h1 <= 2, `produced ${h2 - h1} blocks in 6s`);
  } catch (e) {
    check('Block production', false, e.message);
  }
  console.log('');

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log('─'.repeat(52));
  const total = passed + failed + warned;
  console.log(`  Passed: ${C.green}${passed}${C.reset}  Failed: ${C.red}${failed}${C.reset}  Warnings: ${C.yellow}${warned}${C.reset}  Total: ${total}`);
  console.log('');

  if (failed === 0) {
    console.log(`${C.green}${C.bold}  ✅ ALL CHECKS PASSED — Ready for launch!${C.reset}`);
  } else {
    console.log(`${C.red}${C.bold}  ❌ ${failed} check(s) failed — Fix before launching mainnet.${C.reset}`);
  }

  console.log('');
  printManualChecklist();
}

function printManualChecklist() {
  console.log(`${C.bold}MANUAL LAUNCH CHECKLIST${C.reset}`);
  const items = [
    ['Genesis',           'Update config/genesis.json with real validator addresses'],
    ['Keys',              'Generate production validator keypairs (not deterministic seeds)'],
    ['Keys',              'Store private keys in hardware wallet or encrypted vault (not .env)'],
    ['Network',           'Deploy 3 VPS nodes (min: 2 vCPU, 4 GB RAM, 50 GB SSD each)'],
    ['Network',           'Configure firewall: port 6001 (P2P) open, 3000 behind nginx'],
    ['Network',           'Set PEERS in each .env to other validators\' ws://IP:6001'],
    ['DNS',               'Point tenet.yourdomain.com → load balancer / node 1'],
    ['SSL',               'Enable HTTPS via certbot for nginx (see deploy/nginx.conf)'],
    ['Monitoring',        'Set up log alerts: journalctl -u tenet | grep "[Slash]\\|[Fatal]"'],
    ['Monitoring',        'Monitor /api/supply every 10 min for unexpected inflation'],
    ['Token',             'Deploy airdrop: node scripts/genesis-deploy.js --apply'],
    ['Token',             'Verify BURN_ADDRESS balance = 0 at genesis'],
    ['Explorer',          'Test explorer at http://your-node:3000/explorer.html'],
    ['Wallet',            'Test wallet at http://your-node:3000/wallet.html'],
    ['RPC',               'Add to MetaMask: Network Name=Tenet, RPC=https://your-rpc, ChainID=2048'],
    ['Governance',        'Announce vesting schedule publicly before launch'],
    ['Post-launch',       'Monitor first epoch (40s) — verify rewards distributed'],
    ['Post-launch',       'Verify fee burns visible in /api/supply after first user tx'],
  ];

  items.forEach(([phase, task]) => {
    console.log(`  ${WARN} [${phase.padEnd(12)}] ${task}`);
  });
  console.log('');
}

runChecks().catch(err => { console.error('[Checklist Error]', err.message); process.exit(1); });
