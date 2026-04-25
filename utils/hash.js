/**
 * utils/hash.js
 * SHA-256 wrapper using Node's built-in crypto module.
 * Deterministic, dependency-free, fast.
 */

const crypto = require('crypto');

/**
 * Returns a hex SHA-256 digest of the given data.
 * Accepts string | object (auto-serialized).
 */
function sha256(data) {
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  return crypto.createHash('sha256').update(str).digest('hex');
}

module.exports = { sha256 };
