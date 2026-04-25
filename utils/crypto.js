/**
 * utils/crypto.js
 * ECDSA key-pair generation, signing, and verification.
 * Curve: secp256k1 (same as Bitcoin/Ethereum).
 *
 * Dependency: npm install elliptic
 */

const { ec: EC } = require('elliptic');
const { sha256 }  = require('./hash');

const ec = new EC('secp256k1');

/**
 * Generate a fresh key pair.
 * Returns { privateKey, publicKey } as hex strings.
 */
function generateKeyPair() {
  const keyPair    = ec.genKeyPair();
  const privateKey = keyPair.getPrivate('hex');
  const publicKey  = keyPair.getPublic('hex');          // uncompressed 04...
  return { privateKey, publicKey };
}

/**
 * Sign arbitrary data with a private key.
 * @returns {string} DER-encoded signature as hex
 */
function sign(data, privateKeyHex) {
  const hash    = sha256(data);
  const keyPair = ec.keyFromPrivate(privateKeyHex, 'hex');
  const sig     = keyPair.sign(hash);
  return sig.toDER('hex');
}

/**
 * Verify a DER-hex signature against data and a public key.
 * @returns {boolean}
 */
function verify(data, signatureHex, publicKeyHex) {
  try {
    const hash    = sha256(data);
    const keyPair = ec.keyFromPublic(publicKeyHex, 'hex');
    return keyPair.verify(hash, signatureHex);
  } catch {
    return false;
  }
}

/**
 * Derive a short address from a public key (last 20 bytes, hex).
 * Mirrors Ethereum's keccak-based derivation in spirit.
 */
function publicKeyToAddress(publicKeyHex) {
  return '0x' + sha256(publicKeyHex).slice(-40);
}

module.exports = { generateKeyPair, sign, verify, publicKeyToAddress };
