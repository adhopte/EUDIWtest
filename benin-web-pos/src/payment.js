'use strict';

/**
 * Payment boundary (requirements: modular, replaceable, simulated payment
 * acceptable). The POS hands a gateway only a PaymentRequest and a minimal
 * IdentityContext — never names, document numbers or the portrait.
 *
 * To use a real acquirer / mobile-money API, implement the same two members
 * (displayName, authorize) and pass it to the server instead of
 * SimulatedPaymentGateway.
 *
 * @typedef {{ identityVerified: boolean, ageOver18: boolean }} IdentityContext
 * @typedef {{ reference: string, merchantName: string, amount: number, currency: string, identity: IdentityContext }} PaymentRequest
 * @typedef {{ status: 'authorized', code: string, provider: string }
 *         | { status: 'declined', reason: string, attemptsLeft: number }} PaymentResult
 */

const crypto = require('crypto');

class SimulatedPaymentGateway {
  constructor({ pin = '1234', maxAttempts = 3, delayMs = 900 } = {}) {
    this.pin = String(pin);
    this.maxAttempts = maxAttempts;
    this.delayMs = delayMs;
    this.attempts = new Map();
    this.displayName = { en: 'Simulated payment (demo)', fr: 'Paiement simulé (démo)' };
  }

  /**
   * @param {PaymentRequest} request
   * @param {{ pin: string }} authorization the customer's explicit confirmation
   * @returns {Promise<PaymentResult>}
   */
  async authorize(request, authorization) {
    await new Promise((r) => setTimeout(r, this.delayMs));
    if (!request.identity || !request.identity.identityVerified) {
      return { status: 'declined', reason: 'identity_not_verified', attemptsLeft: 0 };
    }
    const used = (this.attempts.get(request.reference) || 0) + 1;
    this.attempts.set(request.reference, used);
    if (used > this.maxAttempts) return { status: 'declined', reason: 'too_many_attempts', attemptsLeft: 0 };
    const given = Buffer.from(String(authorization.pin || ''));
    const ok = given.length === this.pin.length && crypto.timingSafeEqual(given, Buffer.from(this.pin));
    if (!ok) {
      const left = this.maxAttempts - used;
      return { status: 'declined', reason: left > 0 ? 'wrong_pin' : 'too_many_attempts', attemptsLeft: left };
    }
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
    return { status: 'authorized', code, provider: 'simulated' };
  }
}

module.exports = { SimulatedPaymentGateway };
