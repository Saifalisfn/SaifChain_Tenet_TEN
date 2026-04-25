/**
 * p2p/peerDiscovery.js
 * Simple static peer discovery via environment variable / config.
 *
 * In production you'd use a DHT (e.g. Kademlia) or a bootstrap node list.
 * Here we read PEERS env var: comma-separated ws:// URLs.
 *
 * Usage
 * ─────
 *   PEERS=ws://localhost:6002,ws://localhost:6003 node index.js
 */

class PeerDiscovery {
  /**
   * @param {import('./p2p')} p2pNetwork
   */
  constructor(p2pNetwork) {
    this.network = p2pNetwork;
  }

  /** Connect to all peers listed in the PEERS environment variable. */
  connectFromEnv() {
    const raw = process.env.PEERS ?? '';
    if (!raw) return;

    const urls = raw.split(',').map(s => s.trim()).filter(Boolean);
    console.log(`[PeerDiscovery] Connecting to ${urls.length} bootstrap peer(s)`);

    for (const url of urls) {
      this.network.connect(url);
    }
  }

  /**
   * Connect to an explicit list of peer URLs.
   * @param {string[]} urls
   */
  connectToList(urls) {
    for (const url of urls) {
      this.network.connect(url);
    }
  }
}

module.exports = PeerDiscovery;
