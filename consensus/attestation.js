/**
 * consensus/attestation.js
 * Attestation - Validator Voting System
 *
 * Each validator in the committee signs the block hash they observed
 * in a given slot. These votes are aggregated here.
 *
 * Data model per slot
 *   slotVotes: Map<slot, Map<validatorAddress, { blockHash, signature }>>
 *
 * After >= 2/3 of total stake attests to the same block hash,
 * finality.js can mark that block finalized.
 */

const { sign, verify } = require('../utils/crypto');

class Attestation {
  /**
   * @param {import('../staking/staking')} staking
   */
  constructor(staking) {
    this.staking = staking;
    /** @type {Map<number, Map<string, { blockHash:string, signature:string }>>} */
    this.slotVotes = new Map();
  }

  createAttestation(validatorAddress, blockHash, slot, privateKey) {
    const payload = { validatorAddress, blockHash, slot };
    const signature = sign(payload, privateKey);
    return { validatorAddress, blockHash, slot, signature };
  }

  recordAttestation({ validatorAddress, blockHash, slot, signature }) {
    if (!this.isValidAttestation({ validatorAddress, blockHash, slot, signature })) {
      return false;
    }

    if (!this.slotVotes.has(slot)) {
      this.slotVotes.set(slot, new Map());
    }
    const votes = this.slotVotes.get(slot);

    if (votes.has(validatorAddress)) {
      return false;
    }

    votes.set(validatorAddress, { blockHash, signature });
    console.log(`[Attestation] OK ${validatorAddress.slice(0,10)}... attested slot ${slot}`);
    return true;
  }

  isValidAttestation({ validatorAddress, blockHash, slot, signature }) {
    const validator = this.staking.validatorPool.get(validatorAddress);
    if (!validator || !validator.active) {
      console.warn(`[Attestation] Unknown/inactive validator ${String(validatorAddress).slice(0,10)}`);
      return false;
    }

    const payload = { validatorAddress, blockHash, slot };
    if (!verify(payload, signature, validator.publicKey)) {
      console.warn(`[Attestation] Bad signature from ${String(validatorAddress).slice(0,10)}`);
      return false;
    }

    return true;
  }

  getAttestingStake(slot, blockHash) {
    const votes = this.slotVotes.get(slot);
    if (!votes) return 0;

    let stakeSum = 0;
    for (const [addr, vote] of votes) {
      if (vote.blockHash === blockHash) {
        stakeSum += this.staking.getValidatorStake(addr);
      }
    }
    return stakeSum;
  }

  getAttestations(slot) {
    const votes = this.slotVotes.get(slot);
    if (!votes) return [];

    return [...votes.entries()].map(([validatorAddress, vote]) => ({
      validatorAddress,
      blockHash: vote.blockHash,
      signature: vote.signature,
    }));
  }

  getAttesters(slot) {
    return [...(this.slotVotes.get(slot) ?? new Map()).keys()];
  }
}

module.exports = Attestation;
