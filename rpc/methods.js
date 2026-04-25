/**
 * rpc/methods.js
 * JSON-RPC Method Handlers – Ethereum-inspired API
 *
 * All methods receive `params` (array or object) and return a result value.
 * Errors should throw with a descriptive message.
 *
 * Supported methods
 * ─────────────────
 *   sfc_blockNumber         – current chain height
 *   sfc_getBalance          – liquid balance of address
 *   sfc_getStake            – staked amount of address
 *   sfc_sendTransaction     – inject signed tx into mempool
 *   sfc_getBlockByNumber    – block data by index
 *   sfc_getValidators       – list of active validators
 *   sfc_getTransactionPool  – pending mempool txs
 *   sfc_getSlashLog         – slashing history
 *   sfc_getChainInfo        – summary stats
 */

const Transaction = require('../blockchain/transaction');
const constants = require('../config/constants');
const { sha256 } = require('../utils/hash');
const { Transaction: EthereumTransaction } = require('ethers');

function toHexQuantity(value) {
  const bigintValue = typeof value === 'bigint' ? value : BigInt(value);
  return `0x${bigintValue.toString(16)}`;
}

function toBaseUnits(value) {
  return BigInt(value) * (10n ** BigInt(constants.DECIMALS));
}

function normalizeBlockTag(indexOrTag, blockchain) {
  if (indexOrTag === undefined || indexOrTag === null || indexOrTag === 'latest') {
    return blockchain.getHeight();
  }

  if (typeof indexOrTag === 'string' && indexOrTag.startsWith('0x')) {
    return Number(BigInt(indexOrTag));
  }

  return Number(indexOrTag);
}

function toEthereumBlock(block) {
  return {
    number: toHexQuantity(block.index),
    hash: block.hash.startsWith('0x') ? block.hash : `0x${block.hash}`,
    parentHash: block.previousHash.startsWith('0x') ? block.previousHash : `0x${block.previousHash}`,
    nonce: '0x0000000000000000',
    sha3Uncles: `0x${'0'.repeat(64)}`,
    logsBloom: `0x${'0'.repeat(512)}`,
    transactionsRoot: block.stateRoot.startsWith('0x') ? block.stateRoot : `0x${block.stateRoot}`,
    stateRoot: block.stateRoot.startsWith('0x') ? block.stateRoot : `0x${block.stateRoot}`,
    receiptsRoot: `0x${'0'.repeat(64)}`,
    miner: block.validator,
    difficulty: '0x0',
    totalDifficulty: toHexQuantity(block.index),
    extraData: '0x53616966436861696e',
    size: toHexQuantity(JSON.stringify(block).length),
    gasLimit: toHexQuantity(constants.BLOCK_GAS_LIMIT),
    gasUsed: toHexQuantity(
      block.transactions.reduce((sum, tx) => (
        tx.from === 'COINBASE' ? sum : sum + constants.DEFAULT_GAS_LIMIT
      ), 0)
    ),
    baseFeePerGas: toHexQuantity(constants.DEFAULT_BASE_FEE_WEI),
    timestamp: toHexQuantity(Math.floor(block.timestamp / 1000)),
    transactions: block.transactions.map((tx) => tx.txId ? `0x${tx.txId}` : '0x'),
    uncles: [],
  };
}

function toEthereumTransaction(record) {
  const tx = record.tx;
  return {
    hash: `0x${tx.txId}`,
    nonce: toHexQuantity(tx.nonce ?? 0),
    blockHash: record.blockHash ? `0x${record.blockHash}` : null,
    blockNumber: record.blockIndex === null ? null : toHexQuantity(record.blockIndex),
    transactionIndex: record.transactionIndex === null ? null : toHexQuantity(record.transactionIndex),
    from: tx.from,
    to: tx.to,
    value: toHexQuantity(toBaseUnits(tx.amount ?? 0)),
    gas: toHexQuantity(constants.DEFAULT_GAS_LIMIT),
    gasPrice: toHexQuantity(constants.DEFAULT_GAS_PRICE_WEI),
    maxFeePerGas: toHexQuantity(constants.DEFAULT_BASE_FEE_WEI),
    maxPriorityFeePerGas: '0x0',
    input: '0x',
  };
}

function normalizeBoolean(value, fallback = false) {
  return value === undefined ? fallback : Boolean(value);
}

function buildFeeHistory(blockCount, newestBlock, rewardPercentiles, blockchain) {
  const count = Math.max(1, Math.min(Number(blockCount) || 1, 128));
  const endIndex = normalizeBlockTag(newestBlock, blockchain);
  const startIndex = Math.max(0, endIndex - count + 1);
  const oldestBlock = toHexQuantity(startIndex);
  const baseFeePerGas = [];
  const gasUsedRatio = [];
  const reward = [];

  for (let i = startIndex; i <= endIndex; i += 1) {
    const block = blockchain.getBlockByIndex(i);
    if (!block) continue;

    baseFeePerGas.push(toHexQuantity(constants.DEFAULT_BASE_FEE_WEI));
    const userTxCount = block.transactions.filter(tx => tx.from !== 'COINBASE').length;
    const gasUsed = userTxCount * constants.DEFAULT_GAS_LIMIT;
    gasUsedRatio.push(Math.min(1, gasUsed / constants.BLOCK_GAS_LIMIT));

    if (Array.isArray(rewardPercentiles)) {
      reward.push(rewardPercentiles.map(() => '0x0'));
    }
  }

  baseFeePerGas.push(toHexQuantity(constants.DEFAULT_BASE_FEE_WEI));

  return {
    oldestBlock,
    baseFeePerGas,
    gasUsedRatio,
    reward,
  };
}

function fromHexWeiToWholeSfc(value) {
  const wei = typeof value === 'string' && value.startsWith('0x') ? BigInt(value) : BigInt(value ?? 0);
  const divisor = 10n ** BigInt(constants.DECIMALS);
  if (wei % divisor !== 0n) {
    throw new Error(`Value must be a whole-number amount of ${constants.COIN_SYMBOL}`);
  }
  return Number(wei / divisor);
}

function parseRawTransactionEnvelope(rawTx) {
  const tx = Transaction.fromRawEnvelope(rawTx);

  if (typeof tx.amount === 'string') {
    tx.amount = tx.amount.startsWith('0x')
      ? fromHexWeiToWholeSfc(tx.amount)
      : Number(tx.amount);
  }

  if (!tx.from || !tx.to) {
    throw new Error('raw transaction must include from and to');
  }

  if (!Number.isInteger(tx.amount) || tx.amount <= 0) {
    throw new Error('raw transaction amount must be a positive integer');
  }

  if (!Number.isInteger(tx.nonce) || tx.nonce < 0) {
    throw new Error('raw transaction nonce must be a non-negative integer');
  }

  if (!Number.isInteger(tx.timestamp) || tx.timestamp <= 0) {
    throw new Error('raw transaction timestamp must be a positive integer');
  }

  return tx;
}

function parseEthereumRawTransaction(rawTx, blockchain) {
  let ethTx;
  try {
    ethTx = EthereumTransaction.from(rawTx);
  } catch (error) {
    throw new Error(`Ethereum raw transaction decode failed: ${error.shortMessage ?? error.message}`);
  }

  if (!ethTx.from || !ethTx.to) {
    throw new Error('only simple signed transfers with from and to are supported');
  }

  const chainId = Number(ethTx.chainId ?? 0n);
  if (chainId !== 0 && chainId !== constants.CHAIN_ID) {
    throw new Error(`wrong chainId: expected ${constants.CHAIN_ID}, got ${chainId}`);
  }

  if (ethTx.data && ethTx.data !== '0x') {
    throw new Error('contract calldata is not supported');
  }

  const amount = Number(ethTx.value / (10n ** BigInt(constants.DECIMALS)));
  if (ethTx.value % (10n ** BigInt(constants.DECIMALS)) !== 0n) {
    throw new Error(`Value must be a whole-number amount of ${constants.COIN_SYMBOL}`);
  }

  if (amount <= 0) {
    throw new Error('transaction value must be positive');
  }

  const nonce = Number(ethTx.nonce);
  const expectedNonce = blockchain.state.getNonce(ethTx.from);
  if (nonce !== expectedNonce) {
    throw new Error(`Invalid nonce: expected ${expectedNonce}, got ${nonce}`);
  }

  if (blockchain.state.getBalance(ethTx.from) < amount) {
    throw new Error('Insufficient balance');
  }

  const tx = Transaction.ethereumCompat({
    from: ethTx.from,
    to: ethTx.to,
    amount,
    nonce,
    timestamp: Date.now(),
  });
  tx.txId = String(ethTx.hash ?? '').replace(/^0x/, '') || tx.txId;
  return tx;
}

const { buildGamingMethods }  = require('../usecases/gaming');
const { buildPaymentMethods } = require('../usecases/payments');

/**
 * @param {import('../blockchain/blockchain')} blockchain
 * @param {import('../staking/staking')}       staking
 * @param {import('../staking/slashing').Slashing} slashing
 * @param {object}  options
 * @param {import('../blockchain/supplyTracker')} [supplyTracker]
 */
function buildMethods(blockchain, staking, slashing, options = {}, supplyTracker = null) {
  const faucetClaims = new Map();
  const onMutation = options.onMutation ?? (() => {});
  const broadcastTransaction = options.broadcastTransaction ?? (() => {});

  function validateAddress(address) {
    if (typeof address !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      throw new Error('valid 0x-prefixed 20-byte address required');
    }
  }

  function claimFromFaucet(address) {
    validateAddress(address);

    const now = Date.now();
    const lastClaimAt = faucetClaims.get(address) ?? 0;
    const remainingMs = constants.FAUCET_COOLDOWN_MS - (now - lastClaimAt);

    if (remainingMs > 0) {
      throw new Error(`Faucet cooldown active. Try again in ${Math.ceil(remainingMs / 1000)}s`);
    }

    blockchain.state.coin.mint(address, constants.FAUCET_AMOUNT);
    faucetClaims.set(address, now);
    onMutation();

    return {
      address,
      amount: constants.FAUCET_AMOUNT,
      unit: constants.COIN_SYMBOL,
      balance: blockchain.state.getBalance(address),
      cooldownMs: constants.FAUCET_COOLDOWN_MS,
    };
  }

  return {
    // ── Chain ──────────────────────────────────────────────────────

    sfc_blockNumber() {
      return blockchain.getHeight();
    },

    sfc_getBlockByNumber([indexOrTag]) {
      const index = indexOrTag === 'latest'
        ? blockchain.getHeight()
        : Number(indexOrTag);
      const block = blockchain.getBlockByIndex(index);
      if (!block) throw new Error(`Block ${indexOrTag} not found`);
      return block.toJSON();
    },

    sfc_getChainInfo() {
      const latest = blockchain.latestBlock;
      return {
        height:       blockchain.getHeight(),
        latestHash:   latest.hash,
        latestSlot:   latest.slot,
        latestEpoch:  latest.epoch,
        finalized:    latest.finalized,
        totalStake:   staking.totalActiveStake(),
        validators:   staking.getActiveValidators().length,
        mempoolSize:  blockchain.mempool.length,
      };
    },

    // ── Balances / Staking ─────────────────────────────────────────

    sfc_getBalance([address]) {
      if (!address) throw new Error('address required');
      return {
        address,
        liquid:    blockchain.state.getBalance(address),
        spendable: blockchain.state.getSpendableBalance(address),
        locked:    blockchain.state.getLockedBalance(address),
        staked:    staking.getValidatorStake(address),
        unit:      constants.COIN_SYMBOL,
      };
    },

    sfc_getStake([address]) {
      return staking.getValidatorStake(address);
    },

    // ── Transactions ───────────────────────────────────────────────

    sfc_sendTransaction([txData]) {
      const tx   = Transaction.fromJSON(txData);
      const ok   = blockchain.addTransaction(tx);
      if (!ok) throw new Error('Transaction rejected (invalid signature or duplicate)');
      broadcastTransaction(tx.toJSON());
      return { txId: tx.txId, status: 'pending' };
    },

    sfc_getTransactionPool() {
      return blockchain.mempool.map(t => t.toJSON());
    },

    sfc_getTransactionByHash([txHash]) {
      const normalizedHash = String(txHash || '').replace(/^0x/, '');
      const record = blockchain.getTransactionById(normalizedHash);
      if (!record) {
        return null;
      }
      return record;
    },

    sfc_getRecentTransactions([limit = 10]) {
      const recent = [];

      for (let i = blockchain.chain.length - 1; i >= 0 && recent.length < Number(limit); i -= 1) {
        const block = blockchain.chain[i];
        for (let j = block.transactions.length - 1; j >= 0 && recent.length < Number(limit); j -= 1) {
          const tx = block.transactions[j];
          if (!tx.txId) continue;
          const record = blockchain.getTransactionById(tx.txId);
          if (record) {
            recent.push(record);
          }
        }
      }

      return recent;
    },

    // ── Validators ─────────────────────────────────────────────────

    sfc_getValidators() {
      return staking.getValidatorList().map(v => ({
        address:   v.address,
        stake:     v.stake,
        active:    v.active,
        slashed:   v.slashed,
      }));
    },

    // ── Slashing ───────────────────────────────────────────────────

    sfc_getSlashLog() {
      return slashing.getSlashLog();
    },

    sfc_requestFaucet([address]) {
      return claimFromFaucet(address);
    },

    // ── Supply tracking ────────────────────────────────────────────

    ten_getSupply() {
      if (!supplyTracker) return { error: 'supply tracker not available' };
      return supplyTracker.snapshot();
    },

    ten_getCirculatingSupply() {
      if (!supplyTracker) return 0;
      return supplyTracker.circulatingSupply;
    },

    // ── Chain info (TEN-branded) ───────────────────────────────────

    ten_chainInfo() {
      const latest = blockchain.latestBlock;
      const supply = supplyTracker?.snapshot() ?? {};
      return {
        name:            constants.COIN_NAME,
        symbol:          constants.COIN_SYMBOL,
        chainId:         constants.CHAIN_ID,
        height:          blockchain.getHeight(),
        latestHash:      latest.hash,
        latestSlot:      latest.slot,
        latestEpoch:     latest.epoch,
        totalStake:      staking.totalActiveStake(),
        validators:      staking.getActiveValidators().length,
        mempoolSize:     blockchain.mempool.length,
        supply,
        blockReward:     require('../tokenomics/rewardSchedule').getCurrentReward(blockchain.getHeight()),
        txFee:           constants.TX_FEE,
        burnRate:        `${(constants.TX_FEE_BURN_PCT * 100).toFixed(0)}%`,
      };
    },

    // ── Wallet helpers (for frontend wallet without MetaMask) ──────

    ten_generateWallet() {
      const crypto   = require('crypto');
      const { ec: EC } = require('elliptic');
      const { publicKeyToAddress } = require('../utils/crypto');
      const ec  = new EC('secp256k1');
      const key = ec.genKeyPair();
      const pub = key.getPublic('hex');
      return {
        address:    publicKeyToAddress(pub),
        publicKey:  pub,
        privateKey: key.getPrivate('hex'),
        warning:    'STORE PRIVATE KEY SECURELY. Never share it.',
      };
    },

    ten_buildTransaction([from, to, amount, nonce]) {
      if (!from || !to || !amount) throw new Error('from, to, amount required');
      const payload = {
        from,
        to,
        amount:    Number(amount),
        nonce:     Number(nonce ?? blockchain.state.getNonce(from)),
        timestamp: Date.now(),
      };
      const txId = sha256(payload);
      return { ...payload, txId, signingInstructions: 'Sign this payload with your private key using secp256k1' };
    },

    // ── Use case: Gaming ──────────────────────────────────────────

    ...buildGamingMethods(blockchain, staking, options),

    // ── Use case: SmartPe Payments ────────────────────────────────

    ...buildPaymentMethods(blockchain, blockchain.state),

    // Ethereum-compatible RPC surface for wallet compatibility.
    web3_clientVersion() {
      return `Tenet/${constants.COIN_SYMBOL.toLowerCase()}-rpc/1.0.0`;
    },

    net_version() {
      return String(constants.CHAIN_ID);
    },

    net_listening() {
      return true;
    },

    eth_chainId() {
      return toHexQuantity(constants.CHAIN_ID);
    },

    eth_blockNumber() {
      return toHexQuantity(blockchain.getHeight());
    },

    eth_getBalance([address]) {
      if (!address) throw new Error('address required');
      return toHexQuantity(toBaseUnits(blockchain.state.getBalance(address)));
    },

    eth_getTransactionCount([address]) {
      if (!address) throw new Error('address required');
      return toHexQuantity(blockchain.state.getNonce(address));
    },

    eth_getCode() {
      return '0x';
    },

    eth_gasPrice() {
      return toHexQuantity(constants.DEFAULT_GAS_PRICE_WEI);
    },

    eth_maxPriorityFeePerGas() {
      return '0x0';
    },

    eth_feeHistory([blockCount = 1, newestBlock = 'latest', rewardPercentiles = []]) {
      return buildFeeHistory(blockCount, newestBlock, rewardPercentiles, blockchain);
    },

    eth_estimateGas() {
      return toHexQuantity(constants.DEFAULT_GAS_LIMIT);
    },

    eth_syncing() {
      return false;
    },

    eth_accounts() {
      return [];
    },

    eth_requestAccounts() {
      return [];
    },

    eth_sendTransaction([txData]) {
      if (!txData?.from || !txData?.to) {
        throw new Error('from and to are required');
      }

      validateAddress(txData.from);
      validateAddress(txData.to);

      const amount = fromHexWeiToWholeSfc(txData.value ?? '0x0');
      if (amount <= 0) {
        throw new Error('transaction value must be positive');
      }

      const nonce = txData.nonce !== undefined
        ? Number(BigInt(txData.nonce))
        : blockchain.state.getNonce(txData.from);

      const tx = Transaction.ethereumCompat({
        from: txData.from,
        to: txData.to,
        amount,
        nonce,
        timestamp: Date.now(),
      });

      const ok = blockchain.addTransaction(tx);
      if (!ok) {
        throw new Error('Transaction rejected');
      }

      broadcastTransaction(tx.toJSON());

      return `0x${tx.txId}`;
    },

    eth_sendRawTransaction([rawTx]) {
      let tx;
      let lastError;

      try {
        tx = parseEthereumRawTransaction(rawTx, blockchain);
      } catch (error) {
        lastError = error;
      }

      if (!tx) {
        tx = parseRawTransactionEnvelope(rawTx);

        validateAddress(tx.from);
        validateAddress(tx.to);

        if (!tx.isValid()) {
          throw new Error(lastError
            ? `${lastError.message}; raw transaction signature verification failed`
            : 'Raw transaction signature verification failed');
        }

        const expectedNonce = blockchain.state.getNonce(tx.from);
        if (tx.nonce !== expectedNonce) {
          throw new Error(`Invalid nonce: expected ${expectedNonce}, got ${tx.nonce}`);
        }

        if (blockchain.state.getBalance(tx.from) < tx.amount) {
          throw new Error('Insufficient balance');
        }
      }

      const ok = blockchain.addTransaction(tx);
      if (!ok) {
        throw new Error('Transaction rejected');
      }

      broadcastTransaction(tx.toJSON());

      return `0x${tx.txId}`;
    },

    eth_getTransactionByHash([txHash]) {
      const normalizedHash = String(txHash || '').replace(/^0x/, '');
      const record = blockchain.getTransactionById(normalizedHash);
      if (!record) {
        return null;
      }
      return toEthereumTransaction(record);
    },

    eth_getTransactionReceipt([txHash]) {
      const normalizedHash = String(txHash || '').replace(/^0x/, '');
      const receipt = blockchain.getReceiptByTxId(normalizedHash);
      if (receipt) {
        return receipt;
      }

      const pending = blockchain.getTransactionById(normalizedHash);
      if (pending?.status === 'pending') {
        return null;
      }

      return null;
    },

    eth_getBlockByNumber([indexOrTag]) {
      const index = normalizeBlockTag(indexOrTag, blockchain);
      const block = blockchain.getBlockByIndex(index);
      if (!block) {
        return null;
      }
      return toEthereumBlock(block);
    },

    eth_getBlockByHash([blockHash, hydrated = false]) {
      const normalizedHash = String(blockHash || '').replace(/^0x/, '');
      const block = blockchain.getBlockByHash(normalizedHash);
      if (!block) {
        return null;
      }

      const ethereumBlock = toEthereumBlock(block);
      if (normalizeBoolean(hydrated)) {
        ethereumBlock.transactions = block.transactions
          .map(tx => blockchain.getTransactionById(tx.txId))
          .filter(Boolean)
          .map(toEthereumTransaction);
      }
      return ethereumBlock;
    },
  };
}

module.exports = buildMethods;
