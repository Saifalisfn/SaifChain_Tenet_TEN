/**
 * consensus/slotEngine.js
 * Slot Engine – heartbeat of the consensus loop
 *
 * Every SLOT_DURATION_MS milliseconds:
 *  1. Increment slot counter
 *  2. Emit 'slot' event with { slot, epoch }
 *  3. When slot % SLOTS_PER_EPOCH === 0 → emit 'epoch' event
 *
 * The ValidatorNode listens to these events to drive:
 *  - Proposer selection
 *  - Block proposal
 *  - Attestation collection
 *  - Epoch rewards
 */

const EventEmitter               = require('events');
const { SLOT_DURATION_MS, SLOTS_PER_EPOCH } = require('../config/constants');

class SlotEngine extends EventEmitter {
  constructor() {
    super();
    this.currentSlot  = -1;
    this.currentEpoch = 0;
    this._timer       = null;
    this._running     = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.currentSlot = Math.floor(Date.now() / SLOT_DURATION_MS);
    this.currentEpoch = Math.floor(this.currentSlot / SLOTS_PER_EPOCH);
    console.log(`[SlotEngine] Started (slot=${SLOT_DURATION_MS}ms, epoch=${SLOTS_PER_EPOCH} slots)`);

    this._scheduleNextTick();
  }

  stop() {
    clearTimeout(this._timer);
    this._running = false;
    console.log('[SlotEngine] Stopped');
  }

  _scheduleNextTick() {
    const now = Date.now();
    const delay = SLOT_DURATION_MS - (now % SLOT_DURATION_MS);
    this._timer = setTimeout(() => {
      this._tick();
      if (this._running) {
        this._scheduleNextTick();
      }
    }, delay);
  }

  _tick() {
    const computedSlot = Math.floor(Date.now() / SLOT_DURATION_MS);
    if (computedSlot <= this.currentSlot) {
      return;
    }

    this.currentSlot = computedSlot;
    const newEpoch = Math.floor(this.currentSlot / SLOTS_PER_EPOCH);

    if (newEpoch > this.currentEpoch) {
      this.currentEpoch = newEpoch;
      this.emit('epoch', { epoch: this.currentEpoch, slot: this.currentSlot });
    }

    this.emit('slot', { slot: this.currentSlot, epoch: this.currentEpoch });

    console.log(`[SlotEngine] ⏱  Slot ${this.currentSlot} | Epoch ${this.currentEpoch}`);
  }
}

module.exports = SlotEngine;
