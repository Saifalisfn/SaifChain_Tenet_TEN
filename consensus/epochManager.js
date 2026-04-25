/**
 * consensus/epochManager.js
 * Epoch Manager – end-of-epoch bookkeeping
 *
 * At each epoch boundary:
 *  1. Collect all attesters from the epoch's slots
 *  2. Distribute staking rewards
 *  3. Detect offline validators (missed all slots) and optionally slash
 *  4. Rotate the validator set (re-check active status)
 *  5. Emit 'epochProcessed' event
 */

const EventEmitter = require('events');
const { SLOTS_PER_EPOCH } = require('../config/constants');

class EpochManager extends EventEmitter {
  /**
   * @param {import('../staking/staking')}       staking
   * @param {import('../consensus/attestation')} attestation
   * @param {import('../staking/slashing').Slashing}  slashing
   */
  constructor(staking, attestation, slashing) {
    super();
    this.staking     = staking;
    this.attestation = attestation;
    this.slashing    = slashing;

    /** Slots processed in the current epoch, for offline detection. */
    this._epochSlots = [];
  }

  /** Register a slot as having been processed in this epoch. */
  recordSlot(slot) {
    this._epochSlots.push(slot);
  }

  /**
   * Process end-of-epoch:
   *  - Reward active attesters
   *  - Slash offline validators (missed every slot in epoch)
   *  - Reset slot tracking for next epoch
   */
  processEpoch(epoch) {
    console.log(`\n[Epoch] ═══ Epoch ${epoch} Summary ═══`);

    // 1. Collect unique attesters across all epoch slots
    const attesterSet = new Set();
    for (const slot of this._epochSlots) {
      for (const addr of this.attestation.getAttesters(slot)) {
        attesterSet.add(addr);
      }
    }

    // 2. Reward attesters
    this.staking.distributeRewards([...attesterSet]);

    // 3. Slash offline validators
    const activeValidators = this.staking.getActiveValidators();
    const sawFullEpoch = this._epochSlots.length >= SLOTS_PER_EPOCH;
    if (sawFullEpoch) {
      for (const v of activeValidators) {
        if ((v.joinedEpoch ?? epoch) >= epoch) {
          continue;
        }

        if (!attesterSet.has(v.address)) {
          console.warn(`[Epoch] ${v.address.slice(0,10)}… was OFFLINE this epoch`);
          this.slashing.slash(v.address, 'OFFLINE', this._epochSlots[0] ?? 0);
        }
      }
    } else {
      console.log(`[Epoch] Skipping offline slashing for partial epoch (${this._epochSlots.length}/${SLOTS_PER_EPOCH} slots observed)`);
    }

    console.log(`[Epoch] Active validators: ${activeValidators.length}`);
    console.log(`[Epoch] Total staked: ${this.staking.totalActiveStake()} SFC`);
    console.log(`[Epoch] ═══════════════════════════\n`);

    // 4. Reset for next epoch
    this._epochSlots = [];

    this.emit('epochProcessed', { epoch });
  }
}

module.exports = EpochManager;
