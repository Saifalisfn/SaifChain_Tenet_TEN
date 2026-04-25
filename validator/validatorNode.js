/**
 * validator/validatorNode.js
 * Validator Node – The Full Consensus Participant
 *
 * This is the heart of SaifChain. Each running instance represents
 * one validator node. It:
 *
 *  1. Registers itself in the staking pool
 *  2. Listens to slot events from SlotEngine
 *  3. Checks if it is the proposer for each slot
 *  4. Proposes blocks when selected
 *  5. Attests to blocks proposed by others
 *  6. Broadcasts blocks and attestations over P2P
 *  7. Handles attestations received from the network
 *  8. Triggers finality checks after each slot
 *  9. Processes epoch-end bookkeeping
 */

const MSG = require('../p2p/messageTypes');
const { SLOT_DURATION_MS, SLOTS_PER_EPOCH } = require('../config/constants');

class ValidatorNode {
  /**
   * @param {object} config
   * @param {string} config.address       – validator address (0x…)
   * @param {string} config.publicKey     – ECDSA public key hex
   * @param {string} config.privateKey    – ECDSA private key hex (KEEP SECRET)
   * @param {number} config.initialStake  – TEN to stake on startup
   *
   * @param {import('../blockchain/blockchain')}         blockchain
   * @param {import('../staking/staking')}               staking
   * @param {import('../staking/slashing').Slashing}     slashing
   * @param {import('../consensus/slotEngine')}          slotEngine
   * @param {import('../consensus/epochManager')}        epochManager
   * @param {import('../consensus/validatorSelection')}  validatorSelection
   * @param {import('../consensus/attestation')}         attestation
   * @param {import('../consensus/finality')}            finality
   * @param {import('../p2p/p2p')}                       p2p
   */
  constructor(config, blockchain, staking, slashing, slotEngine, epochManager, validatorSelection, attestation, finality, p2p) {
    this.address    = config.address;
    this.publicKey  = config.publicKey;
    this.privateKey = config.privateKey;
    this.initialStake = config.initialStake;

    this.blockchain         = blockchain;
    this.staking            = staking;
    this.slashing           = slashing;
    this.slotEngine         = slotEngine;
    this.epochManager       = epochManager;
    this.validatorSelection = validatorSelection;
    this.attestation        = attestation;
    this.finality           = finality;
    this.p2p                = p2p;

    /** Track the block proposed in each slot (for double-vote detection). */
    this._proposedBlocks = new Map();   // slot → blockHash
    /** Pending blocks waiting for attestations: slot → Block */
    this._pendingBlocks  = new Map();
    this._observedBlockProposals = new Map();
  }

  // ── Startup ───────────────────────────────────────────────────────

  async start() {
    console.log(`\n[Validator] Starting node: ${this.address.slice(0,14)}…`);
    const currentEpoch = Math.floor(Date.now() / SLOT_DURATION_MS / SLOTS_PER_EPOCH);

    // Register / stake
    if (this.staking.getValidatorStake(this.address) === 0) {
      this.staking.stake(this.address, this.initialStake, this.publicKey, currentEpoch);
    } else {
      console.log(`[Validator] Reusing persisted stake for ${this.address.slice(0,14)}â€¦`);
    }

    // Attach P2P attestation handler
    this.p2p.setLocalIdentity({
      address: this.address,
      publicKey: this.publicKey,
      privateKey: this.privateKey,
    });
    this.p2p.on(MSG.ATTESTATION, attestData => this._onNetworkAttestation(attestData));
    this.p2p.on(MSG.BLOCK, blockData => this._onNetworkBlock(blockData));
    this.p2p.on(MSG.VALIDATOR_SYNC, payload => this._onValidatorSync(payload));
    this.p2p.on(MSG.REQUEST_VALIDATORS, () => this._sendValidatorSet());

    this._primeObservedBlockProposals();
    this._announceSelf();

    // Attach slot / epoch listeners
    this.slotEngine.on('slot',  ({ slot, epoch }) => this._onSlot(slot, epoch));
    this.slotEngine.on('epoch', ({ epoch, slot }) => this._onEpoch(epoch, slot));

    // Start the heartbeat
    this.slotEngine.start();

    console.log(`[Validator] Node ${this.address.slice(0,14)}… is LIVE ✅\n`);
  }

  // ── Slot handler ──────────────────────────────────────────────────

  async _onSlot(slot, epoch) {
    this.epochManager.recordSlot(slot);

    try {
      const proposer = this.validatorSelection.selectProposer(slot, epoch);

      if (proposer.address === this.address) {
        // ── We are the proposer ──────────────────────────────────────
        await this._proposeBlock(slot, epoch);
      } else {
        // ── We are an attester ───────────────────────────────────────
        // Wait briefly for proposer to broadcast, then attest
        setTimeout(() => this._attestSlot(slot, proposer.address), 500);
      }
    } catch (err) {
      console.error('[Validator] Slot error:', err.message);
    }
  }

  // ── Block proposal ────────────────────────────────────────────────

  async _proposeBlock(slot, epoch) {
    console.log(`\n[Validator] 📦 PROPOSING block for slot ${slot}`);

    const block = this.blockchain.createBlock(this.address, slot, epoch);
    block.signBlock(this.privateKey);
    this._proposedBlocks.set(slot, block.hash);
    this._rememberBlockProposal(block);
    this._pendingBlocks.set(slot, block);

    // Self-attest (proposer always votes for own block)
    const selfAttestation = this.attestation.createAttestation(
      this.address, block.hash, slot, this.privateKey
    );
    this.attestation.recordAttestation(selfAttestation);
    block.addAttestation(selfAttestation);

    // Broadcast block to network
    this.p2p.broadcast(MSG.BLOCK, block.toJSON());
    console.log(`[Validator] Block #${block.index} broadcast (hash=${block.hash.slice(0,12)}…)`);

    // Check finality after a short window
    setTimeout(() => this._checkFinalityForSlot(slot), 2000);
  }

  // ── Attestation (voting) ──────────────────────────────────────────

  _attestSlot(slot, proposerAddress) {
    const candidateBlock = this._pendingBlocks.get(slot);
    if (!candidateBlock) {
      // May not have received the block yet — skip (will be marked offline at epoch end)
      console.log(`[Validator] Slot ${slot}: no block to attest yet`);
      return;
    }

    const blockHash = candidateBlock.hash;

    // Double-vote guard
    if (this._proposedBlocks.has(slot)) {
      const slashed = this.slashing.checkDoubleVote(this.address, slot, this._proposedBlocks.get(slot), blockHash);
      if (slashed) {
        this._sendValidatorSet();
      }
    }

    const attestData = this.attestation.createAttestation(
      this.address, blockHash, slot, this.privateKey
    );

    const recorded = this.attestation.recordAttestation(attestData);
    if (recorded) {
      // Add to block
      candidateBlock.addAttestation(attestData);
      // Broadcast vote
      this.p2p.broadcast(MSG.ATTESTATION, attestData);
      console.log(`[Validator] 🗳  Attested slot ${slot} (block ${blockHash.slice(0,12)}…)`);
    }
  }

  // ── Handle incoming attestations ──────────────────────────────────

  _onNetworkAttestation(attestData) {
    const { validatorAddress, blockHash, slot, signature } = attestData;

    if (!this.attestation.isValidAttestation(attestData)) {
      return;
    }

    // Double-vote detection
    const votes = this.attestation.slotVotes.get(slot);
    if (votes && votes.has(validatorAddress)) {
      const existing = votes.get(validatorAddress);
      const slashed = this.slashing.checkDoubleVote(validatorAddress, slot, existing.blockHash, blockHash);
      if (slashed) {
        this._sendValidatorSet();
      }
      return;
    }

    const recorded = this.attestation.recordAttestation(attestData);
    if (recorded) {
      // Update block's attestation list if we have it
      const block = this._pendingBlocks.get(slot) ?? this.blockchain.latestBlock;
      if (block && block.slot === slot) {
        block.addAttestation(attestData);
      }
      // Try finality
      this._checkFinalityForSlot(slot);
    }
  }

  // ── Handle incoming blocks ────────────────────────────────────────

  _onNetworkBlock(blockData) {
    const Block = require('../blockchain/block');
    const block = Block.fromJSON(blockData);
    const currentHeight = this.blockchain.getHeight();
    const existingPending = this._pendingBlocks.get(block.slot);

    // Double-proposal detection runs before proposer check because a validator's
    // stake (and thus their probability weight) may have changed since they
    // proposed the original block — we still want to catch the equivocation.
    if (this._isValidSignedBlock(block)) {
      const conflictingProposal = this._rememberBlockProposal(block);
      if (conflictingProposal) {
        const slashed = this.slashing.checkDoubleProposal(
          block.validator,
          block.slot,
          conflictingProposal,
          block.hash,
        );
        if (slashed) {
          this._sendValidatorSet();
        }
        return;
      }
    }

    const expectedProposer = this.validatorSelection.selectProposer(block.slot, block.epoch);

    if (expectedProposer.address !== block.validator) {
      console.warn(
        `[Validator] Rejected block for slot ${block.slot}: expected proposer ${expectedProposer.address.slice(0,10)}..., got ${block.validator.slice(0,10)}...`
      );
      return;
    }

    if (!this._isValidSignedBlock(block)) {
      console.warn(
        `[Validator] Rejected unsigned/invalidly signed block for slot ${block.slot} from ${block.validator.slice(0,10)}...`
      );
      return;
    }

    if (existingPending && existingPending.hash !== block.hash) {
      console.warn(
        `[Validator] Ignoring competing block for slot ${block.slot}: have ${existingPending.hash.slice(0,12)}..., got ${block.hash.slice(0,12)}...`
      );

      if (block.finalized) {
        this.p2p.broadcast(MSG.REQUEST_CHAIN, {});
      }
      return;
    }

    if (block.index <= currentHeight) {
      return;
    }

    if (block.finalized) {
      if (block.index > currentHeight + 1) {
        this.p2p.broadcast(MSG.REQUEST_CHAIN, {});
        return;
      }

      const appended = this.blockchain.appendBlock(block);
      if (appended) {
        console.log(`[Validator] Accepted finalized block #${block.index} from network`);
        this._pendingBlocks.delete(block.slot);
      } else {
        this.p2p.broadcast(MSG.REQUEST_CHAIN, {});
      }
      return;
    }

    if (block.index > currentHeight + 1) {
      this.p2p.broadcast(MSG.REQUEST_CHAIN, {});
    }

    this._pendingBlocks.set(block.slot, block);
  }

  // ── Finality check ────────────────────────────────────────────────

  _checkFinalityForSlot(slot) {
    const block = this._pendingBlocks.get(slot);
    if (!block || block.finalized) return;

    const finalized = this.finality.checkFinality(block);
    if (finalized) {
      const appended = this.blockchain.appendBlock(block);
      if (appended) {
        // Broadcast finalized block
        this.p2p.broadcast(MSG.BLOCK, block.toJSON());
        this._pendingBlocks.delete(slot);
      }
    }
  }

  // ── Epoch handler ─────────────────────────────────────────────────

  _onEpoch(epoch, slot) {
    console.log(`[Validator] Epoch ${epoch} boundary reached`);
    // Finalize any remaining unfinalized blocks
    this.finality.tryFinalizeAll(this.blockchain.chain);
    // Process epoch rewards / slashing
    this.epochManager.processEpoch(epoch);
  }

  _announceSelf() {
    this.p2p.broadcast(MSG.VALIDATOR_SYNC, {
      validators: [this._localValidatorRecord()],
    });
  }

  _sendValidatorSet() {
    this.p2p.broadcast(MSG.VALIDATOR_SYNC, {
      validators: this.staking.getValidatorList(),
    });
  }

  _localValidatorRecord() {
    return {
      address: this.address,
      publicKey: this.publicKey,
      stake: this.staking.getValidatorStake(this.address),
      active: true,
      slashed: false,
      joinedEpoch: this.staking.validatorPool.get(this.address)?.joinedEpoch ?? Math.floor(Date.now() / SLOT_DURATION_MS / SLOTS_PER_EPOCH),
    };
  }

  _onValidatorSync(payload) {
    const validators = Array.isArray(payload?.validators) ? payload.validators : [];

    for (const validator of validators) {
      const added = this.staking.importValidator(validator);
      if (added) {
        console.log(`[Validator] Synced validator ${validator.address.slice(0,14)}…`);
      }
    }
  }

  _proposalKey(slot, validatorAddress) {
    return `${slot}:${validatorAddress}`;
  }

  _rememberBlockProposal(block) {
    const key = this._proposalKey(block.slot, block.validator);
    const existingHash = this._observedBlockProposals.get(key);
    if (!existingHash) {
      this._observedBlockProposals.set(key, block.hash);
      return null;
    }

    return existingHash === block.hash ? null : existingHash;
  }

  _primeObservedBlockProposals() {
    for (const block of this.blockchain.chain) {
      if (!block?.validator || block.validator === 'GENESIS' || !block.signature) {
        continue;
      }

      this._rememberBlockProposal(block);
    }
  }

  _isValidSignedBlock(block) {
    const validatorRecord = this.staking.validatorPool.get(block.validator);
    if (!validatorRecord?.publicKey) {
      return false;
    }

    return block.hasValidSignature(validatorRecord.publicKey);
  }
}

module.exports = ValidatorNode;
