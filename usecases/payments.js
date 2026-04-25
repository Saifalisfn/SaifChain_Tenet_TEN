'use strict';

/**
 * usecases/payments.js
 * SmartPe — merchant settlement on Tenet (TEN).
 *
 * Use case: e-commerce / fintech payment rails
 *
 * Flow:
 *   1. Merchant registers (gets a merchant ID + settlement address)
 *   2. Customer pays → frontend calls ten_createPaymentIntent
 *   3. Payment intent returns: { intentId, amount, payTo, expiresAt }
 *   4. Customer wallet sends TEN to payTo address
 *   5. Backend polls ten_checkPayment → confirms when tx is finalized
 *   6. Merchant receives net settlement (after platform fee deduction)
 *
 * Platform fee: 0.5% of transaction (deducted from merchant payout).
 * Fee destination: treasury address (reinvested or burned via governance).
 *
 * RPC methods exposed:
 *   ten_createPaymentIntent   – create a payment request
 *   ten_checkPayment          – check if a payment intent was fulfilled
 *   ten_getMerchantBalance    – pending settlement balance for a merchant
 *   ten_settlePayment         – trigger manual settlement (merchant pull)
 */

const crypto = require('crypto');
const { sha256 } = require('../utils/hash');

const PLATFORM_FEE_PCT    = 0.005;   // 0.5%
const TREASURY_ADDRESS    = '0x0000000000000000000000000000000000000003';
const INTENT_TTL_MS       = 10 * 60 * 1000;  // 10 minutes

class PaymentsManager {
  /**
   * @param {import('../blockchain/blockchain')} blockchain
   * @param {import('../blockchain/state')}      state
   */
  constructor(blockchain, state) {
    this.blockchain = blockchain;
    this.state      = state;

    /** @type {Map<string, object>} intentId → intent */
    this.intents    = new Map();
    /** @type {Map<string, number>} merchantAddress → pending TEN */
    this.pendingSettlement = new Map();
  }

  // ── Payment Intents ───────────────────────────────────────────────

  /**
   * Create a payment intent.
   * @param {string} merchantAddress  where funds go (minus platform fee)
   * @param {number} amount           TEN amount requested
   * @param {string} orderId          merchant's order reference
   * @returns {{ intentId, payTo, amount, fee, netAmount, expiresAt }}
   */
  createIntent(merchantAddress, amount, orderId) {
    if (amount <= 0)  throw new Error('amount must be positive');
    if (!merchantAddress) throw new Error('merchantAddress required');

    const fee       = Math.floor(amount * PLATFORM_FEE_PCT * 100) / 100;
    const netAmount = amount - fee;
    const intentId  = sha256({ merchant: merchantAddress, orderId, amount, ts: Date.now() });
    const expiresAt = Date.now() + INTENT_TTL_MS;

    this.intents.set(intentId, {
      intentId,
      merchantAddress,
      orderId,
      amount,
      fee,
      netAmount,
      expiresAt,
      status:    'pending',
      txHash:    null,
      createdAt: Date.now(),
    });

    return { intentId, payTo: merchantAddress, amount, fee, netAmount, expiresAt };
  }

  /**
   * Check if a payment intent has been fulfilled.
   * Scans recent blocks for a transfer to merchantAddress of the expected amount.
   */
  checkPayment(intentId) {
    const intent = this.intents.get(intentId);
    if (!intent) throw new Error(`Intent ${intentId} not found`);

    if (intent.status === 'fulfilled') {
      return { status: 'fulfilled', txHash: intent.txHash, settlementAmount: intent.netAmount };
    }

    if (Date.now() > intent.expiresAt) {
      intent.status = 'expired';
      return { status: 'expired', message: 'Payment intent expired' };
    }

    // Scan recent blocks for matching transfer
    const chain = this.blockchain.chain;
    for (let i = chain.length - 1; i >= Math.max(0, chain.length - 50); i--) {
      const block = chain[i];
      if (!block.finalized) continue;

      for (const tx of block.transactions) {
        if (
          tx.from !== 'COINBASE' &&
          tx.to   === intent.merchantAddress &&
          tx.amount === intent.amount
        ) {
          intent.status = 'fulfilled';
          intent.txHash = tx.txId;

          // Queue settlement (fee goes to treasury)
          this._queueSettlement(intent.merchantAddress, intent.netAmount, TREASURY_ADDRESS, intent.fee);

          return {
            status:           'fulfilled',
            txHash:           tx.txId,
            blockNumber:      block.index,
            settlementAmount: intent.netAmount,
            platformFee:      intent.fee,
          };
        }
      }
    }

    return { status: 'pending', expiresIn: Math.max(0, intent.expiresAt - Date.now()) };
  }

  /**
   * Queue a settlement for a merchant.
   * In production this triggers an on-chain tx from the platform wallet.
   */
  _queueSettlement(merchantAddress, amount, feeAddress, feeAmount) {
    const current = this.pendingSettlement.get(merchantAddress) ?? 0;
    this.pendingSettlement.set(merchantAddress, current + amount);
    console.log(`[Payments] Queued settlement: ${amount} TEN → ${merchantAddress.slice(0,10)}… (fee: ${feeAmount} TEN)`);
  }

  /** Get pending settlement balance for a merchant. */
  getMerchantBalance(merchantAddress) {
    return {
      merchantAddress,
      pendingSettlement: this.pendingSettlement.get(merchantAddress) ?? 0,
      liquidBalance:     this.state.getSpendableBalance(merchantAddress),
    };
  }
}

/**
 * Build RPC method handlers for SmartPe payments.
 */
function buildPaymentMethods(blockchain, state) {
  const mgr = new PaymentsManager(blockchain, state);

  return {
    ten_createPaymentIntent([merchantAddress, amount, orderId]) {
      return mgr.createIntent(merchantAddress, Number(amount), orderId ?? `order-${Date.now()}`);
    },

    ten_checkPayment([intentId]) {
      return mgr.checkPayment(intentId);
    },

    ten_getMerchantBalance([merchantAddress]) {
      return mgr.getMerchantBalance(merchantAddress);
    },

    ten_paymentConfig() {
      return {
        platformFeePct: PLATFORM_FEE_PCT * 100 + '%',
        intentTTLSeconds: INTENT_TTL_MS / 1000,
        treasuryAddress: TREASURY_ADDRESS,
        symbol: 'TEN',
        chainId: require('../config/constants').CHAIN_ID,
      };
    },
  };
}

module.exports = { PaymentsManager, buildPaymentMethods, PLATFORM_FEE_PCT };
