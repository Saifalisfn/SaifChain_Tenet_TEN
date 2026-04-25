'use strict';

const explorer = {
  statusText: document.getElementById('explorer-status-text'),
  lastUpdated: document.getElementById('explorer-last-updated'),
  height: document.getElementById('explorer-height'),
  hash: document.getElementById('explorer-hash'),
  mempool: document.getElementById('explorer-mempool'),
  validators: document.getElementById('explorer-validators'),
  recentTransactions: document.getElementById('recent-transactions'),
  mempoolList: document.getElementById('explorer-mempool-list'),
  blockForm: document.getElementById('explorer-block-form'),
  blockInput: document.getElementById('explorer-block-input'),
  blockResult: document.getElementById('explorer-block-result'),
  txForm: document.getElementById('explorer-tx-form'),
  txInput: document.getElementById('explorer-tx-input'),
  txResult: document.getElementById('explorer-tx-result'),
  receiptForm: document.getElementById('explorer-receipt-form'),
  receiptInput: document.getElementById('explorer-receipt-input'),
  receiptResult: document.getElementById('explorer-receipt-result'),
};

async function rpc(method, params = []) {
  const response = await fetch('/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: Date.now() }),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message);
  return payload.result;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value ?? 0));
}

function shortHash(value, size = 18) {
  if (!value) return '-';
  return value.length > size ? `${value.slice(0, size)}...` : value;
}

function formatDate(timestamp) {
  return timestamp || timestamp === 0 ? new Date(timestamp).toLocaleString() : '-';
}

function writeResult(element, value) {
  element.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function createEmptyNode(message) {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.innerHTML = `<p>${message}</p>`;
  return div;
}

function renderRecentTransactions(records) {
  explorer.recentTransactions.innerHTML = '';
  if (!records.length) {
    explorer.recentTransactions.appendChild(createEmptyNode('No finalized transactions yet.'));
    return;
  }

  records.forEach((record) => {
    const tx = record.tx;
    const item = document.createElement('article');
    item.className = 'list-item';
    item.innerHTML = `
      <div class="list-title-row">
        <strong class="mono">${shortHash(`0x${tx.txId}`)}</strong>
        <span class="badge">${record.status}</span>
      </div>
      <p class="list-meta mono">${shortHash(tx.from, 22)} -> ${shortHash(tx.to, 22)}</p>
      <div class="mini-row">
        <span class="mini-meta">${formatNumber(tx.amount)} TEN</span>
        <span class="mini-meta">Block ${record.blockIndex ?? '-'}</span>
      </div>
    `;
    explorer.recentTransactions.appendChild(item);
  });
}

function renderMempool(transactions) {
  explorer.mempoolList.innerHTML = '';
  if (!transactions.length) {
    explorer.mempoolList.appendChild(createEmptyNode('Mempool is empty.'));
    return;
  }

  transactions.forEach((tx) => {
    const item = document.createElement('article');
    item.className = 'list-item';
    item.innerHTML = `
      <div class="list-title-row">
        <strong class="mono">${shortHash(`0x${tx.txId}`)}</strong>
        <span class="badge warn">pending</span>
      </div>
      <p class="list-meta mono">${shortHash(tx.from, 22)} -> ${shortHash(tx.to, 22)}</p>
      <div class="mini-row">
        <span class="mini-meta">${formatNumber(tx.amount)} TEN</span>
        <span class="mini-meta">Nonce ${tx.nonce}</span>
      </div>
    `;
    explorer.mempoolList.appendChild(item);
  });
}

async function refreshExplorer() {
  try {
    const [chainInfo, recentTransactions, mempool] = await Promise.all([
      rpc('sfc_getChainInfo'),
      rpc('sfc_getRecentTransactions', [12]),
      rpc('sfc_getTransactionPool'),
    ]);

    explorer.height.textContent = formatNumber(chainInfo.height);
    explorer.hash.textContent = shortHash(chainInfo.latestHash, 16);
    explorer.mempool.textContent = formatNumber(chainInfo.mempoolSize);
    explorer.validators.textContent = formatNumber(chainInfo.validators);
    renderRecentTransactions(recentTransactions);
    renderMempool(mempool);

    document.body.classList.add('online');
    document.body.classList.remove('offline');
    explorer.statusText.textContent = 'Explorer synced';
    explorer.lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    document.body.classList.add('offline');
    document.body.classList.remove('online');
    explorer.statusText.textContent = 'Explorer offline';
    explorer.lastUpdated.textContent = error.message;
  }
}

explorer.blockForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = explorer.blockInput.value.trim() || 'latest';
  try {
    writeResult(explorer.blockResult, await rpc('sfc_getBlockByNumber', [value]));
  } catch (error) {
    writeResult(explorer.blockResult, { error: error.message });
  }
});

explorer.txForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = explorer.txInput.value.trim();
  try {
    writeResult(explorer.txResult, await rpc('eth_getTransactionByHash', [value]));
  } catch (error) {
    writeResult(explorer.txResult, { error: error.message });
  }
});

explorer.receiptForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = explorer.receiptInput.value.trim();
  try {
    writeResult(explorer.receiptResult, await rpc('eth_getTransactionReceipt', [value]));
  } catch (error) {
    writeResult(explorer.receiptResult, { error: error.message });
  }
});

refreshExplorer();
setInterval(refreshExplorer, 5000);
