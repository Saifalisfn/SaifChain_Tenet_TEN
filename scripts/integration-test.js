#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const assert = require('assert/strict');
const { Wallet, parseUnits } = require('ethers');
const { ec: EC } = require('elliptic');
const WebSocket = require('ws');
const Block = require('../blockchain/block');
const { SLOTS_PER_EPOCH } = require('../config/constants');
const { publicKeyToAddress, sign } = require('../utils/crypto');

const PROJECT_ROOT = path.join(__dirname, '..');
const TEST_ROOT = path.join(PROJECT_ROOT, 'data', 'integration-test');
const STARTUP_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 750;
const POLL_TIMEOUT_MS = 30_000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function deterministicValidatorAddress(id) {
  const ec = new EC('secp256k1');
  const privateKey = crypto
    .createHash('sha256')
    .update(`saifchain_validator_seed_${id}`)
    .digest('hex');
  const keyPair = ec.keyFromPrivate(privateKey, 'hex');
  return publicKeyToAddress(keyPair.getPublic('hex'));
}

function deterministicValidatorKeyPair(id) {
  const ec = new EC('secp256k1');
  const privateKey = crypto
    .createHash('sha256')
    .update(`saifchain_validator_seed_${id}`)
    .digest('hex');
  const keyPair = ec.keyFromPrivate(privateKey, 'hex');
  const publicKey = keyPair.getPublic('hex');
  return {
    privateKey,
    publicKey,
    address: publicKeyToAddress(publicKey),
  };
}

async function waitFor(fn, description, timeoutMs = POLL_TIMEOUT_MS) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await fn();
      if (result) {
        return result;
      }
    } catch {
      // Keep polling until timeout.
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for ${description}`);
}

async function rpc(port, method, params = []) {
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id: `${method}-${Date.now()}`,
    }),
  });

  const json = await response.json();
  if (json.error) {
    throw new Error(`${method} failed: ${json.error.message}`);
  }

  return json.result;
}

async function waitForRpc(port) {
  await waitFor(
    async () => {
      const result = await rpc(port, 'eth_blockNumber');
      return typeof result === 'string' ? result : null;
    },
    `RPC on port ${port}`,
    STARTUP_TIMEOUT_MS,
  );
}

function startNode({ id, p2pPort, rpcPort, peers, dataDir }) {
  const child = spawn(process.execPath, ['index.js'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      VALIDATOR_ID: String(id),
      P2P_PORT: String(p2pPort),
      RPC_PORT: String(rpcPort),
      PEERS: peers.join(','),
      DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });

  return {
    id,
    p2pPort,
    rpcPort,
    peers,
    dataDir,
    child,
    getOutput() {
      return output;
    },
    async stop() {
      if (child.exitCode !== null) {
        return;
      }

      child.kill('SIGTERM');
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        sleep(5_000).then(() => {
          if (child.exitCode === null) {
            child.kill('SIGKILL');
          }
        }),
      ]);
    },
  };
}

async function launchNode(config, nodes) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const node = startNode(config);
  nodes.push(node);
  await waitForRpc(config.rpcPort);
  return node;
}

async function waitForValidatorCount(nodes, expectedCount) {
  return waitFor(async () => {
    const infos = await Promise.all(nodes.map(node => rpc(node.rpcPort, 'sfc_getChainInfo')));
    return infos.every(info => info.validators === expectedCount) ? infos : null;
  }, `${nodes.length} nodes to report ${expectedCount} validators`);
}

async function waitForAuthenticatedPeer(node, address) {
  return waitFor(
    async () => node.getOutput().includes(`Authenticated peer ${address.slice(0,10)}...`) ? true : null,
    `peer ${address} to authenticate on node ${node.rpcPort}`,
  );
}

async function submitTransfer(port, senderAddress, recipientAddress, amountSfc, nonce) {
  return rpc(port, 'eth_sendTransaction', [{
    from: senderAddress,
    to: recipientAddress,
    value: `0x${parseUnits(String(amountSfc), 18).toString(16)}`,
    nonce: `0x${nonce.toString(16)}`,
    gas: '0x5208',
    gasPrice: '0x0',
  }]);
}

async function waitForReceiptOnNodes(nodes, txHash) {
  return waitFor(async () => {
    const receipts = await Promise.all(nodes.map(node => rpc(node.rpcPort, 'eth_getTransactionReceipt', [txHash])));
    return receipts.every(Boolean) ? receipts : null;
  }, `all nodes to observe receipt ${txHash}`);
}

async function expectPeerDisconnectedAfterStrikes({ port, sendMessages }) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let settled = false;

    const finish = (fn) => (value) => {
      if (!settled) {
        settled = true;
        fn(value);
      }
    };

    const timer = setTimeout(() => finish(reject)(new Error(`Expected peer disconnect on ${port}`)), 5_000);

    ws.on('open', async () => {
      try {
        await sendMessages(ws);
      } catch (error) {
        clearTimeout(timer);
        finish(reject)(error);
      }
    });

    ws.on('close', () => {
      clearTimeout(timer);
      finish(resolve)();
    });

    ws.on('error', () => {
      clearTimeout(timer);
      finish(resolve)();
    });
  });
}

async function expectPeerBanned(port) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Expected banned peer rejection on ${port}`));
    }, 5_000);

    ws.on('open', () => {
      // Ban may close immediately after open; wait for close.
    });

    ws.on('close', () => {
      clearTimeout(timer);
      resolve();
    });

    ws.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function assertClusterAgreement(nodes, { expectedValidators, expectedStake, expectedBalanceHex, txHash }) {
  const [infos, validatorLists, receipts, balances, txRecords] = await Promise.all([
    Promise.all(nodes.map(node => rpc(node.rpcPort, 'sfc_getChainInfo'))),
    Promise.all(nodes.map(node => rpc(node.rpcPort, 'sfc_getValidators'))),
    Promise.all(nodes.map(node => rpc(node.rpcPort, 'eth_getTransactionReceipt', [txHash]))),
    Promise.all(nodes.map(node => rpc(node.rpcPort, 'eth_getBalance', [expectedBalanceHex.address]))),
    Promise.all(nodes.map(node => rpc(node.rpcPort, 'eth_getTransactionByHash', [txHash]))),
  ]);

  for (const info of infos) {
    assert.equal(info.validators, expectedValidators, `expected ${expectedValidators} validators`);
    assert.equal(info.totalStake, expectedStake, `expected total stake ${expectedStake}`);
    assert.ok(info.height >= 1, 'chain should progress past genesis');
  }

  for (const validators of validatorLists) {
    assert.equal(validators.length, expectedValidators, 'validator list length should match');
    assert.deepEqual(
      validators.map(v => v.stake).sort((a, b) => a - b),
      new Array(expectedValidators).fill(50_000),
      'validator stakes should stay aligned',
    );
  }

  assert.equal(new Set(receipts.map(item => item?.blockHash)).size, 1, 'all nodes should agree on receipt block hash');
  assert.equal(new Set(receipts.map(item => item?.blockNumber)).size, 1, 'all nodes should agree on receipt block number');

  for (const balance of balances) {
    assert.equal(balance, expectedBalanceHex.value, 'recipient balance should match across nodes');
  }

  for (const tx of txRecords) {
    assert.equal(tx.hash, txHash, 'transaction hash should round-trip');
  }

  return {
    infos,
    receipts,
  };
}

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  const nodes = [];
  global.__integrationNodes = nodes;

  try {
    const configs = {
      node1: {
        id: 1,
        p2pPort: 6311,
        rpcPort: 3311,
        peers: [],
        dataDir: path.join(TEST_ROOT, 'node-1'),
      },
      node2: {
        id: 2,
        p2pPort: 6312,
        rpcPort: 3312,
        peers: ['ws://localhost:6311'],
        dataDir: path.join(TEST_ROOT, 'node-2'),
      },
      node3: {
        id: 3,
        p2pPort: 6313,
        rpcPort: 3313,
        peers: ['ws://localhost:6311', 'ws://localhost:6312'],
        dataDir: path.join(TEST_ROOT, 'node-3'),
      },
    };

    const node1 = await launchNode(configs.node1, nodes);
    const node2 = await launchNode(configs.node2, nodes);

    await waitForValidatorCount([node1, node2], 2);
    await waitForAuthenticatedPeer(node1, deterministicValidatorAddress(2));
    await waitForAuthenticatedPeer(node2, deterministicValidatorAddress(1));

    const slashLogBeforeAttack = await rpc(node1.rpcPort, 'sfc_getSlashLog');
    await expectPeerDisconnectedAfterStrikes({
      port: node1.p2pPort,
      sendMessages: async (ws) => {
        ws.send('{bad json');
        ws.send('{bad json again');
        ws.send('{bad json final');
      },
    });
    await expectPeerBanned(node1.p2pPort);
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${node1.p2pPort}`);
      const timer = setTimeout(() => {
        ws.close();
        resolve();
      }, 1_000);

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'ATTESTATION',
          id: 'rogue-attestation',
          payload: {
            validatorAddress: deterministicValidatorAddress(1),
            blockHash: 'f'.repeat(64),
            slot: 123,
            signature: 'deadbeef',
          },
        }));
      });

      ws.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      ws.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await expectPeerDisconnectedAfterStrikes({
      port: node1.p2pPort,
      sendMessages: async (ws) => {
        ws.send(JSON.stringify({
          type: 'BLOCK',
          id: 'rogue-block',
          payload: {
            index: 'oops',
          },
        }));
        ws.send(JSON.stringify({
          type: 'BLOCK',
          id: 'rogue-block-2',
          payload: {
            index: 'still-bad',
          },
        }));
        ws.send(JSON.stringify({
          type: 'BLOCK',
          id: 'rogue-block-3',
          payload: {
            index: 'last-bad',
          },
        }));
      },
    });
    await expectPeerBanned(node1.p2pPort);
    const slashLogAfterAttack = await rpc(node1.rpcPort, 'sfc_getSlashLog');
    assert.equal(slashLogAfterAttack.length, slashLogBeforeAttack.length, 'malformed adversarial messages must not slash honest validators');

    const latestBeforeRogue = await rpc(node1.rpcPort, 'sfc_getBlockByNumber', ['latest']);
    const rogueValidator = deterministicValidatorKeyPair(99);
    const rogueRecipient = rogueValidator.address;
    const rogueSlot = Number(latestBeforeRogue.slot ?? 0) + 1;
    const rogueEpoch = Math.floor(rogueSlot / SLOTS_PER_EPOCH);
    const rogueBlock = new Block({
      index: Number(latestBeforeRogue.index) + 1,
      previousHash: latestBeforeRogue.hash,
      validator: rogueRecipient,
      slot: rogueSlot,
      epoch: rogueEpoch,
      stateRoot: latestBeforeRogue.stateRoot,
      transactions: [],
    });
    rogueBlock.signBlock(rogueValidator.privateKey);

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${node1.p2pPort}`);
      const timer = setTimeout(() => {
        ws.close();
        resolve();
      }, 1_000);

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'BLOCK',
          id: `rogue-proposer-${Date.now()}`,
          payload: rogueBlock.toJSON(),
        }));
      });

      ws.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      ws.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    const senderAddress = deterministicValidatorAddress(1);
    const recipient = Wallet.createRandom();
    const expectedBalance = parseUnits('9', 18);

    const firstTxHash = await submitTransfer(node1.rpcPort, senderAddress, recipient.address, 9, 0);
    const firstReceipts = await waitForReceiptOnNodes([node1, node2], firstTxHash);
    assert.equal(firstReceipts[0].status, '0x1', 'initial transaction should finalize');
    assert.ok(firstReceipts.every(receipt => receipt.blockHash !== `0x${rogueBlock.hash}`), 'wrong-proposer block must not become the finalized transaction block');

    await assertClusterAgreement([node1, node2], {
      expectedValidators: 2,
      expectedStake: 100_000,
      expectedBalanceHex: { address: recipient.address, value: `0x${expectedBalance.toString(16)}` },
      txHash: firstTxHash,
    });

    const node3 = await launchNode(configs.node3, nodes);

    await waitForValidatorCount([node1, node2, node3], 3);
    await waitForReceiptOnNodes([node1, node2, node3], firstTxHash);

    const afterLateJoin = await assertClusterAgreement([node1, node2, node3], {
      expectedValidators: 3,
      expectedStake: 150_000,
      expectedBalanceHex: { address: recipient.address, value: `0x${expectedBalance.toString(16)}` },
      txHash: firstTxHash,
    });

    await node2.stop();
    const node2Index = nodes.indexOf(node2);
    if (node2Index >= 0) {
      nodes.splice(node2Index, 1);
    }

    const restartedNode2 = await launchNode(configs.node2, nodes);

    await waitForValidatorCount([node1, restartedNode2, node3], 3);
    await waitForReceiptOnNodes([node1, restartedNode2, node3], firstTxHash);

    const afterRestart = await assertClusterAgreement([node1, restartedNode2, node3], {
      expectedValidators: 3,
      expectedStake: 150_000,
      expectedBalanceHex: { address: recipient.address, value: `0x${expectedBalance.toString(16)}` },
      txHash: firstTxHash,
    });

    await node3.stop();
    const node3Index = nodes.indexOf(node3);
    if (node3Index >= 0) {
      nodes.splice(node3Index, 1);
    }

    const recipientWhileOffline = Wallet.createRandom();
    const offlineAdvanceHash = await submitTransfer(node1.rpcPort, senderAddress, recipientWhileOffline.address, 4, 1);
    const offlineAdvanceReceipts = await waitForReceiptOnNodes([node1, restartedNode2], offlineAdvanceHash);
    assert.equal(offlineAdvanceReceipts[0].status, '0x1', 'offline advance transaction should finalize');

    const restartedNode3 = await launchNode(configs.node3, nodes);

    await waitForValidatorCount([node1, restartedNode2, restartedNode3], 3);
    await waitForReceiptOnNodes([node1, restartedNode2, restartedNode3], offlineAdvanceHash);

    const afterOfflineCatchup = await assertClusterAgreement([node1, restartedNode2, restartedNode3], {
      expectedValidators: 3,
      expectedStake: 150_000,
      expectedBalanceHex: { address: recipientWhileOffline.address, value: `0x${parseUnits('4', 18).toString(16)}` },
      txHash: offlineAdvanceHash,
    });

    await Promise.all(nodes.map(node => node.stop().catch(() => {})));
    nodes.length = 0;

    const conflictConfigs = {
      node1: {
        id: 1,
        p2pPort: 6411,
        rpcPort: 3411,
        peers: [],
        dataDir: path.join(TEST_ROOT, 'conflict-node-1'),
      },
      node2: {
        id: 2,
        p2pPort: 6412,
        rpcPort: 3412,
        peers: ['ws://localhost:6411'],
        dataDir: path.join(TEST_ROOT, 'conflict-node-2'),
      },
    };

    const conflictNode1 = await launchNode(conflictConfigs.node1, nodes);
    const conflictNode2 = await launchNode(conflictConfigs.node2, nodes);
    await waitForValidatorCount([conflictNode1, conflictNode2], 2);
    const [conflictSlashLogBeforeNode1, conflictSlashLogBeforeNode2] = await Promise.all([
      rpc(conflictNode1.rpcPort, 'sfc_getSlashLog'),
      rpc(conflictNode2.rpcPort, 'sfc_getSlashLog'),
    ]);

    const validator2 = deterministicValidatorKeyPair(2);
    const targetBlock = await waitFor(async () => {
      const latest = await rpc(conflictNode1.rpcPort, 'sfc_getBlockByNumber', ['latest']);
      if (latest.index < 1) {
        return null;
      }

      const hasValidator2Vote = Array.isArray(latest.attestations)
        && latest.attestations.some(attestation => attestation.validatorAddress === validator2.address);

      return hasValidator2Vote ? latest : null;
    }, 'a finalized block with validator 2 attestation in the conflict cluster');

    const conflictingBlockHash = targetBlock.hash === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
    const conflictingAttestation = {
      validatorAddress: validator2.address,
      blockHash: conflictingBlockHash,
      slot: targetBlock.slot,
      signature: sign({
        validatorAddress: validator2.address,
        blockHash: conflictingBlockHash,
        slot: targetBlock.slot,
      }, validator2.privateKey),
    };

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${conflictNode1.p2pPort}`);
      const timer = setTimeout(() => {
        ws.close();
        resolve();
      }, 1_000);

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'ATTESTATION',
          id: `conflict-${Date.now()}`,
          payload: conflictingAttestation,
        }));
      });

      ws.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      ws.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    const conflictNode1Validators = await waitFor(
      async () => {
        const validators = await rpc(conflictNode1.rpcPort, 'sfc_getValidators');
        const validatorRecord = validators.find(item => item.address === validator2.address);
        return validatorRecord?.stake === 40_000 ? validators : null;
      },
      'double-vote penalty to reduce validator 2 stake on node 1',
    );

    const conflictValidators = await waitFor(
      async () => {
        const validators = await rpc(conflictNode2.rpcPort, 'sfc_getValidators');
        const validatorRecord = validators.find(item => item.address === validator2.address);
        return validatorRecord?.stake === 40_000 ? validators : null;
      },
      'slashed validator stake to propagate across peers',
    );

    const conflictSlashLogs = await waitFor(
      async () => {
        const [node1Log, node2Log] = await Promise.all([
          rpc(conflictNode1.rpcPort, 'sfc_getSlashLog'),
          rpc(conflictNode2.rpcPort, 'sfc_getSlashLog'),
        ]);

        return node1Log.length > conflictSlashLogBeforeNode1.length || node2Log.length > conflictSlashLogBeforeNode2.length
          ? { node1Log, node2Log }
          : null;
      },
      'slash log growth after valid conflicting attestation on at least one node',
    );

    const proposerId = targetBlock.validator === deterministicValidatorAddress(1) ? 1 : 2;
    const proposerKeyPair = deterministicValidatorKeyPair(proposerId);
    // proposerId===2: double-voted first (40,000) then double-proposed (40,000×0.85=34,000)
    // proposerId===1: double-proposed only (50,000×0.85=42,500)
    const expectedDoubleProposalStake = proposerId === 2 ? 34_000 : 42_500;
    const proposalSlashLogBaseline = Math.max(
      conflictSlashLogs.node1Log.length,
      conflictSlashLogs.node2Log.length,
    );
    const conflictingProposal = new Block({
      index: targetBlock.index,
      timestamp: targetBlock.timestamp + 1,
      transactions: targetBlock.transactions,
      previousHash: targetBlock.previousHash,
      validator: targetBlock.validator,
      slot: targetBlock.slot,
      epoch: targetBlock.epoch,
      stateRoot: targetBlock.stateRoot,
    });
    conflictingProposal.signBlock(proposerKeyPair.privateKey);

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${conflictNode1.p2pPort}`);
      const timer = setTimeout(() => {
        ws.close();
        resolve();
      }, 1_000);

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'BLOCK',
          id: `double-proposal-${Date.now()}`,
          payload: conflictingProposal.toJSON(),
        }));
      });

      ws.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      ws.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    const proposalSlashLogs = await waitFor(
      async () => {
        const [node1Log, node2Log] = await Promise.all([
          rpc(conflictNode1.rpcPort, 'sfc_getSlashLog'),
          rpc(conflictNode2.rpcPort, 'sfc_getSlashLog'),
        ]);
        const combined = [...node1Log, ...node2Log];
        const proposalEntries = combined.filter(entry => entry.offence === 'DOUBLE_PROPOSAL');

        return Math.max(node1Log.length, node2Log.length) > proposalSlashLogBaseline && proposalEntries.length > 0
          ? { node1Log, node2Log, proposalEntries }
          : null;
      },
      'double-proposal slash log entry',
    );

    const doubleProposalStake = await waitFor(
      async () => {
        const [node1Validators, node2Validators] = await Promise.all([
          rpc(conflictNode1.rpcPort, 'sfc_getValidators'),
          rpc(conflictNode2.rpcPort, 'sfc_getValidators'),
        ]);
        const node1Record = node1Validators.find(item => item.address === targetBlock.validator);
        const node2Record = node2Validators.find(item => item.address === targetBlock.validator);

        return node1Record?.stake === expectedDoubleProposalStake && node2Record?.stake === expectedDoubleProposalStake
          ? { node1Record, node2Record }
          : null;
      },
      'double-proposal penalty to propagate across peers',
    );

    console.log(JSON.stringify({
      ok: true,
      scenarios: {
        signedPeerIdentity: true,
        adversarialP2P: true,
        wrongProposerBlockRejected: true,
        twoNodeSync: true,
        lateJoinSync: true,
        restartRecovery: true,
        offlineCatchup: true,
        conflictingAttestationSlash: true,
        conflictingProposerSlash: true,
      },
      txHash: firstTxHash,
      recipient: recipient.address,
      recipientBalance: `0x${expectedBalance.toString(16)}`,
      offlineCatchupTxHash: offlineAdvanceHash,
      lateJoinReceiptBlockHash: afterLateJoin.receipts[0].blockHash,
      restartReceiptBlockHash: afterRestart.receipts[0].blockHash,
      offlineCatchupReceiptBlockHash: afterOfflineCatchup.receipts[0].blockHash,
      conflictSlashCount: Math.max(conflictSlashLogs.node1Log.length, conflictSlashLogs.node2Log.length),
      conflictNode1Validator2Stake: conflictNode1Validators.find(item => item.address === validator2.address)?.stake,
      conflictValidator2Stake: conflictValidators.find(item => item.address === validator2.address)?.stake,
      doubleProposalSlashCount: proposalSlashLogs.proposalEntries.length,
      doubleProposalValidator: targetBlock.validator,
      doubleProposalNode1Stake: doubleProposalStake.node1Record.stake,
      doubleProposalNode2Stake: doubleProposalStake.node2Record.stake,
      finalHeights: afterOfflineCatchup.infos.map(info => info.height),
    }, null, 2));
  } finally {
    await Promise.all(nodes.map(node => node.stop().catch(() => {})));
  }
}

main().catch(error => {
  console.error('[integration-test] FAILED');
  console.error(error.stack || error.message);
  if (global.__integrationNodes) {
    for (const node of global.__integrationNodes) {
      console.error(`\n--- node:${node.rpcPort} tail ---`);
      const tail = node.getOutput().split(/\r?\n/).slice(-40).join('\n');
      console.error(tail);
    }
  }
  process.exitCode = 1;
});
