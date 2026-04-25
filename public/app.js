'use strict';

const state = {
  refreshMs: 5000,
};

const elements = {
  networkStatusText: document.getElementById('network-status-text'),
  lastUpdated: document.getElementById('last-updated'),
  refreshAll: document.getElementById('refresh-all'),
  metricHeight: document.getElementById('metric-height'),
  metricSlot: document.getElementById('metric-slot'),
  metricValidators: document.getElementById('metric-validators'),
  metricStake: document.getElementById('metric-stake'),
  latestBlock: document.getElementById('latest-block'),
  latestFinalityBadge: document.getElementById('latest-finality-badge'),
  validatorsList: document.getElementById('validators-list'),
  mempoolList: document.getElementById('mempool-list'),
  mempoolCount: document.getElementById('mempool-count'),
  slashLog: document.getElementById('slash-log'),
  blockForm: document.getElementById('block-form'),
  blockInput: document.getElementById('block-input'),
  blockResult: document.getElementById('block-result'),
  balanceForm: document.getElementById('balance-form'),
  addressInput: document.getElementById('address-input'),
  balanceResult: document.getElementById('balance-result'),
  faucetForm: document.getElementById('faucet-form'),
  faucetInput: document.getElementById('faucet-input'),
  faucetResult: document.getElementById('faucet-result'),
  fillMetamask: document.getElementById('fill-metamask'),
  sendForm: document.getElementById('send-form'),
  sendFromInput: document.getElementById('send-from-input'),
  fillSendMetamask: document.getElementById('fill-send-metamask'),
  sendToInput: document.getElementById('send-to-input'),
  sendAmountInput: document.getElementById('send-amount-input'),
  sendResult: document.getElementById('send-result'),
};

async function rpc(method, params = []) {
  const response = await fetch('/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id: Date.now(),
    }),
  });

  const payload = await response.json();
  if (payload.error) {
    throw new Error(payload.error.message);
  }

  return payload.result;
}

function shortHash(value, size = 12) {
  if (!value) return '-';
  return value.length > size ? `${value.slice(0, size)}...` : value;
}

function formatDate(timestamp) {
  if (!timestamp && timestamp !== 0) return '-';
  return new Date(timestamp).toLocaleString();
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value ?? 0));
}

function sfcToWeiHex(amount) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Amount must be a positive number');
  }

  return `0x${(BigInt(Math.trunc(amount)) * (10n ** 18n)).toString(16)}`;
}

function setOnlineStatus(isOnline, message) {
  document.body.classList.toggle('online', isOnline);
  document.body.classList.toggle('offline', !isOnline);
  elements.networkStatusText.textContent = message;
}

function createEmptyNode(message) {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.innerHTML = `<p>${message}</p>`;
  return div;
}

function updateMetrics(chainInfo) {
  elements.metricHeight.textContent = formatNumber(chainInfo.height);
  elements.metricSlot.textContent = formatNumber(chainInfo.latestSlot);
  elements.metricValidators.textContent = formatNumber(chainInfo.validators);
  elements.metricStake.textContent = `${formatNumber(chainInfo.totalStake)} SFC`;
}

function updateLatestBlock(block) {
  elements.latestFinalityBadge.textContent = block.finalized ? 'Finalized' : 'Pending finality';
  elements.latestFinalityBadge.className = `badge ${block.finalized ? '' : 'warn'}`.trim();

  elements.latestBlock.innerHTML = `
    <div class="headline-number">
      <strong>#${formatNumber(block.index)}</strong>
      <span class="mono">${shortHash(block.hash, 18)}</span>
    </div>
    <div class="detail-grid">
      <div class="detail-card">
        <span class="detail-label">Validator</span>
        <span class="detail-value mono">${block.validator}</span>
      </div>
      <div class="detail-card">
        <span class="detail-label">Previous Hash</span>
        <span class="detail-value mono">${shortHash(block.previousHash, 24)}</span>
      </div>
      <div class="detail-card">
        <span class="detail-label">Slot / Epoch</span>
        <span class="detail-value">${block.slot} / ${block.epoch}</span>
      </div>
      <div class="detail-card">
        <span class="detail-label">Transactions</span>
        <span class="detail-value">${block.transactions.length}</span>
      </div>
      <div class="detail-card">
        <span class="detail-label">Attestations</span>
        <span class="detail-value">${block.attestations.length}</span>
      </div>
      <div class="detail-card">
        <span class="detail-label">Timestamp</span>
        <span class="detail-value">${formatDate(block.timestamp)}</span>
      </div>
    </div>
  `;
}

function renderValidators(validators) {
  elements.validatorsList.innerHTML = '';

  if (!validators.length) {
    elements.validatorsList.appendChild(createEmptyNode('No validators registered.'));
    return;
  }

  validators.forEach((validator) => {
    const item = document.createElement('article');
    item.className = 'list-item';
    item.innerHTML = `
      <div class="list-title-row">
        <strong class="mono">${shortHash(validator.address, 18)}</strong>
        <span class="badge ${validator.slashed ? 'danger' : validator.active ? '' : 'warn'}">
          ${validator.slashed ? 'Slashed' : validator.active ? 'Active' : 'Inactive'}
        </span>
      </div>
      <p class="list-meta mono">${validator.address}</p>
      <div class="mini-row">
        <span class="mini-meta">Stake</span>
        <strong>${formatNumber(validator.stake)} SFC</strong>
      </div>
    `;
    elements.validatorsList.appendChild(item);
  });
}

function renderMempool(transactions) {
  elements.mempoolCount.textContent = `${transactions.length} tx`;
  elements.mempoolList.innerHTML = '';

  if (!transactions.length) {
    elements.mempoolList.appendChild(createEmptyNode('Mempool is empty.'));
    return;
  }

  transactions.forEach((tx) => {
    const item = document.createElement('article');
    item.className = 'list-item';
    item.innerHTML = `
      <div class="list-title-row">
        <strong class="mono">${shortHash(tx.txId, 18)}</strong>
        <strong>${formatNumber(tx.amount)} SFC</strong>
      </div>
      <p class="list-meta mono">${shortHash(tx.from, 20)} -> ${shortHash(tx.to, 20)}</p>
      <div class="mini-row">
        <span class="mini-meta">Nonce ${tx.nonce}</span>
        <span class="mini-meta">${formatDate(tx.timestamp)}</span>
      </div>
    `;
    elements.mempoolList.appendChild(item);
  });
}

function renderSlashLog(entries) {
  elements.slashLog.innerHTML = '';

  if (!entries.length) {
    elements.slashLog.appendChild(createEmptyNode('No slashing events recorded.'));
    return;
  }

  entries
    .slice()
    .reverse()
    .forEach((entry) => {
      const item = document.createElement('article');
      item.className = 'list-item';
      item.innerHTML = `
        <div class="list-title-row">
          <strong>${entry.offence}</strong>
          <span class="badge danger">${formatNumber(entry.penalty)} SFC</span>
        </div>
        <p class="list-meta mono">${entry.address}</p>
        <div class="mini-row">
          <span class="mini-meta">Slot ${entry.slot}</span>
          <span class="mini-meta">${formatDate(entry.timestamp)}</span>
        </div>
      `;
      elements.slashLog.appendChild(item);
    });
}

function writeResult(element, value) {
  element.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

async function getMetamaskAccount() {
  if (!window.ethereum?.request) {
    throw new Error('MetaMask not detected in this browser');
  }

  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  if (!accounts.length) {
    throw new Error('No MetaMask account available');
  }

  return accounts[0];
}

async function waitForReceipt(txHash, attempts = 8, delayMs = 2500) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const receipt = await rpc('eth_getTransactionReceipt', [txHash]);
    if (receipt) {
      return receipt;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return null;
}

async function refreshDashboard() {
  try {
    const [chainInfo, latestBlock, validators, mempool, slashLog] = await Promise.all([
      rpc('sfc_getChainInfo'),
      rpc('sfc_getBlockByNumber', ['latest']),
      rpc('sfc_getValidators'),
      rpc('sfc_getTransactionPool'),
      rpc('sfc_getSlashLog'),
    ]);

    updateMetrics(chainInfo);
    updateLatestBlock(latestBlock);
    renderValidators(validators);
    renderMempool(mempool);
    renderSlashLog(slashLog);

    setOnlineStatus(true, 'Node online');
    elements.lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    setOnlineStatus(false, 'Node offline');
    elements.lastUpdated.textContent = error.message;
  }
}

elements.refreshAll.addEventListener('click', () => {
  refreshDashboard();
});

elements.blockForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = elements.blockInput.value.trim() || 'latest';

  try {
    const result = await rpc('sfc_getBlockByNumber', [value]);
    writeResult(elements.blockResult, result);
  } catch (error) {
    writeResult(elements.blockResult, { error: error.message });
  }
});

elements.balanceForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = elements.addressInput.value.trim();

  if (!value) {
    writeResult(elements.balanceResult, { error: 'Address is required' });
    return;
  }

  try {
    const result = await rpc('sfc_getBalance', [value]);
    writeResult(elements.balanceResult, result);
  } catch (error) {
    writeResult(elements.balanceResult, { error: error.message });
  }
});

elements.faucetForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = elements.faucetInput.value.trim();

  if (!value) {
    writeResult(elements.faucetResult, { error: 'Address is required' });
    return;
  }

  try {
    const result = await rpc('sfc_requestFaucet', [value]);
    writeResult(elements.faucetResult, result);
    await refreshDashboard();
  } catch (error) {
    writeResult(elements.faucetResult, { error: error.message });
  }
});

elements.fillMetamask.addEventListener('click', async () => {
  try {
    const account = await getMetamaskAccount();
    elements.faucetInput.value = account;
    writeResult(elements.faucetResult, { account, message: 'MetaMask account loaded' });
  } catch (error) {
    writeResult(elements.faucetResult, { error: error.message });
  }
});

elements.fillSendMetamask.addEventListener('click', async () => {
  try {
    const account = await getMetamaskAccount();
    elements.sendFromInput.value = account;
    writeResult(elements.sendResult, { account, message: 'MetaMask account loaded as sender' });
  } catch (error) {
    writeResult(elements.sendResult, { error: error.message });
  }
});

elements.sendForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const from = elements.sendFromInput.value.trim();
  const to = elements.sendToInput.value.trim();
  const amount = Number(elements.sendAmountInput.value);

  if (!from || !to) {
    writeResult(elements.sendResult, { error: 'From and to addresses are required' });
    return;
  }

  try {
    const nonce = await rpc('eth_getTransactionCount', [from, 'latest']);
    const txHash = await rpc('eth_sendTransaction', [{
      from,
      to,
      value: sfcToWeiHex(amount),
      nonce,
    }]);

    writeResult(elements.sendResult, {
      status: 'submitted',
      txHash,
      message: 'Waiting for finalization...',
    });

    const receipt = await waitForReceipt(txHash);
    const recipientBalance = await rpc('eth_getBalance', [to, 'latest']);

    writeResult(elements.sendResult, {
      status: receipt ? 'finalized' : 'pending',
      txHash,
      receipt,
      recipientBalance,
      explorer: `/explorer.html`,
    });

    await refreshDashboard();
  } catch (error) {
    writeResult(elements.sendResult, { error: error.message });
  }
});

refreshDashboard();
setInterval(refreshDashboard, state.refreshMs);
