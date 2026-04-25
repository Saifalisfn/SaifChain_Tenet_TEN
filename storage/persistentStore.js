'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

class PersistentStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.dbPath = path.join(rootDir, 'node-state.db');
    this.legacyJsonPath = path.join(rootDir, 'node-state.json');
    this._saveTimer = null;

    this._ensureDir();
    this.db = new DatabaseSync(this.dbPath);
    this._initSchema();
    this._migrateLegacySnapshotTable();
  }

  _ensureDir() {
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS blocks (
        block_index INTEGER PRIMARY KEY,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mempool (
        tx_id TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS balances (
        address TEXT PRIMARY KEY,
        balance INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS nonces (
        address TEXT PRIMARY KEY,
        nonce INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS stakes (
        address TEXT PRIMARY KEY,
        stake INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS validators (
        address TEXT PRIMARY KEY,
        public_key TEXT,
        stake INTEGER NOT NULL,
        active INTEGER NOT NULL,
        slashed INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tx_index (
        tx_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS receipts (
        tx_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS slash_log (
        entry_order INTEGER PRIMARY KEY,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS legacy_snapshots (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  _migrateLegacySnapshotTable() {
    const row = this.db.prepare('SELECT payload FROM legacy_snapshots WHERE id = 1').get();
    if (!row?.payload) {
      return;
    }

    this.save(JSON.parse(row.payload));
    this.db.prepare('DELETE FROM legacy_snapshots WHERE id = 1').run();
  }

  exists() {
    const row = this.db.prepare(`SELECT value FROM metadata WHERE key = 'version'`).get();
    return Boolean(row) || fs.existsSync(this.legacyJsonPath);
  }

  load() {
    const version = this.db.prepare(`SELECT value FROM metadata WHERE key = 'version'`).get();
    if (version?.value) {
      return {
        version: Number(version.value),
        validatorAddress: this._getMeta('validatorAddress'),
        blockchain: {
          chain: this.db.prepare('SELECT payload FROM blocks ORDER BY block_index').all().map(row => JSON.parse(row.payload)),
          mempool: this.db.prepare('SELECT payload FROM mempool ORDER BY position').all().map(row => JSON.parse(row.payload)),
          state: {
            balances: this._loadKeyValueTable('balances', 'balance'),
            nonces: this._loadKeyValueTable('nonces', 'nonce'),
            stakes: this._loadKeyValueTable('stakes', 'stake'),
          },
          txIndex: this.db.prepare('SELECT tx_id, payload FROM tx_index ORDER BY tx_id').all().map(row => [row.tx_id, JSON.parse(row.payload)]),
          receipts: this.db.prepare('SELECT tx_id, payload FROM receipts ORDER BY tx_id').all().map(row => [row.tx_id, JSON.parse(row.payload)]),
        },
        staking: this.db.prepare('SELECT * FROM validators ORDER BY address').all().map(row => ({
          address: row.address,
          publicKey: row.public_key,
          stake: row.stake,
          active: Boolean(row.active),
          slashed: Boolean(row.slashed),
        })),
        slashing: this.db.prepare('SELECT payload FROM slash_log ORDER BY entry_order').all().map(row => JSON.parse(row.payload)),
      };
    }

    if (fs.existsSync(this.legacyJsonPath)) {
      const legacy = JSON.parse(fs.readFileSync(this.legacyJsonPath, 'utf8'));
      this.save(legacy);
      return legacy;
    }

    return null;
  }

  save(snapshot) {
    try {
      this.db.exec('BEGIN IMMEDIATE');

      const data = snapshot;
      this._setMeta('version', String(data.version ?? 1));
      this._setMeta('validatorAddress', data.validatorAddress ?? '');

      this.db.exec(`
        DELETE FROM blocks;
        DELETE FROM mempool;
        DELETE FROM balances;
        DELETE FROM nonces;
        DELETE FROM stakes;
        DELETE FROM validators;
        DELETE FROM tx_index;
        DELETE FROM receipts;
        DELETE FROM slash_log;
      `);

      const insertBlock = this.db.prepare('INSERT INTO blocks (block_index, payload) VALUES (?, ?)');
      for (const block of data.blockchain?.chain ?? []) {
        insertBlock.run(block.index, JSON.stringify(block));
      }

      const insertMempool = this.db.prepare('INSERT INTO mempool (tx_id, position, payload) VALUES (?, ?, ?)');
      (data.blockchain?.mempool ?? []).forEach((tx, position) => {
        insertMempool.run(tx.txId ?? `mempool-${position}`, position, JSON.stringify(tx));
      });

      this._writeKeyValueTable('balances', 'balance', data.blockchain?.state?.balances ?? {});
      this._writeKeyValueTable('nonces', 'nonce', data.blockchain?.state?.nonces ?? {});
      this._writeKeyValueTable('stakes', 'stake', data.blockchain?.state?.stakes ?? {});

      const insertValidator = this.db.prepare(`
        INSERT INTO validators (address, public_key, stake, active, slashed)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const validator of data.staking ?? []) {
        insertValidator.run(
          validator.address,
          validator.publicKey ?? null,
          validator.stake ?? 0,
          validator.active ? 1 : 0,
          validator.slashed ? 1 : 0
        );
      }

      const insertTxIndex = this.db.prepare('INSERT INTO tx_index (tx_id, payload) VALUES (?, ?)');
      for (const [txId, payload] of data.blockchain?.txIndex ?? []) {
        insertTxIndex.run(txId, JSON.stringify(payload));
      }

      const insertReceipt = this.db.prepare('INSERT INTO receipts (tx_id, payload) VALUES (?, ?)');
      for (const [txId, payload] of data.blockchain?.receipts ?? []) {
        insertReceipt.run(txId, JSON.stringify(payload));
      }

      const insertSlashEntry = this.db.prepare('INSERT INTO slash_log (entry_order, payload) VALUES (?, ?)');
      (data.slashing ?? []).forEach((entry, index) => {
        insertSlashEntry.run(index, JSON.stringify(entry));
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  _setMeta(key, value) {
    this.db.prepare(`
      INSERT INTO metadata (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  _getMeta(key) {
    return this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(key)?.value ?? null;
  }

  _writeKeyValueTable(tableName, valueColumn, values) {
    const stmt = this.db.prepare(`INSERT INTO ${tableName} (address, ${valueColumn}) VALUES (?, ?)`);
    for (const [address, value] of Object.entries(values)) {
      stmt.run(address, Number(value));
    }
  }

  _loadKeyValueTable(tableName, valueColumn) {
    const rows = this.db.prepare(`SELECT address, ${valueColumn} AS value FROM ${tableName}`).all();
    return Object.fromEntries(rows.map(row => [row.address, row.value]));
  }

  schedule(snapshotBuilder, delayMs = 100) {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this.save(snapshotBuilder());
      this._saveTimer = null;
    }, delayMs);
  }

  flush(snapshotBuilder) {
    clearTimeout(this._saveTimer);
    this.save(snapshotBuilder());
    this._saveTimer = null;
  }
}

module.exports = PersistentStore;
