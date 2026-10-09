'use strict';

require('dotenv').config({ quiet: true });
const path = require('path');

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

module.exports = {
  PORT: Number(process.env.PORT || 3000),

  // Folder with trusted issuer / IACA PEM certificates (ANIP IACA in production).
  TRUST_DIR: process.env.TRUST_DIR || path.join(__dirname, '..', 'trust'),

  // Simulated ANIP issuer + wallet ("Demo without a phone") and the
  // "Trust this issuer (demo)" button. Never enable in production.
  DEMO_MODE: bool(process.env.DEMO_MODE, true),

  // Simulated payment gateway
  DEMO_PIN: process.env.DEMO_PIN || '1234',
  PIN_ATTEMPTS: Number(process.env.PIN_ATTEMPTS || 3),

  // Size of each BLE write to the wallet (prefix byte included). ISO/IEC 18013-5
  // allows up to MTU-3; Web Bluetooth does not expose the MTU, so the default 20
  // works with any phone. A terminal can raise it in Settings.
  BLE_CHUNK_SIZE: Math.min(512, Math.max(20, Number(process.env.BLE_CHUNK_SIZE || 20))),

  TX_TTL_MS: 15 * 60 * 1000
};
