'use strict';

require('dotenv').config({ quiet: true });
const path = require('path');

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

// Hostnames are case-insensitive, but wallets compare client_id and response_uri
// as strings, so normalise (e.g. "Benin-POS.onrender.com" -> "benin-pos.onrender.com").
function normaliseBaseUrl(value) {
  const url = new URL(value || 'http://localhost:3000');
  return `${url.protocol}//${url.host.toLowerCase()}${url.pathname}`.replace(/\/$/, '');
}

// On Render, RENDER_EXTERNAL_URL is set automatically (https://<service>.onrender.com).
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = normaliseBaseUrl(process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`);
const RESPONSE_URI = `${BASE_URL}/oid4vp/response`;

module.exports = {
  PORT,
  BASE_URL,
  RESPONSE_URI,

  /*
   * OpenID4VP request profile. The defaults are the profile the SIGMA wallet
   * (eudi-lib-jvm-openid4vp-kt, HAIP) accepts without a verifier certificate:
   * unsigned request by value, DCQL, client_id "redirect_uri:<response_uri>",
   * encrypted response (direct_post.jwt).
   */
  // 'value'     -> the whole request is in the QR code (default; unsigned requests)
  // 'reference' -> short QR with request_uri (wallets that accept unsigned request objects)
  REQUEST_MODE: (process.env.REQUEST_MODE || 'value').toLowerCase(),
  CLIENT_ID: process.env.CLIENT_ID || `redirect_uri:${RESPONSE_URI}`,
  // 'direct_post.jwt' (HAIP, default) or 'direct_post'
  RESPONSE_MODE: (process.env.RESPONSE_MODE || 'direct_post.jwt').toLowerCase(),
  // DCQL claim_sets: [all requested elements] or, failing that, [family_name, given_name],
  // so a PID without e.g. document_number still matches (QR version ~29 instead of ~27).
  DCQL_CLAIM_SETS: bool(process.env.DCQL_CLAIM_SETS, true),
  // Deep-link scheme encoded in the QR code
  WALLET_SCHEME: process.env.WALLET_SCHEME || 'openid4vp://',

  // Folder with trusted issuer / IACA PEM certificates (ANIP IACA in production).
  TRUST_DIR: process.env.TRUST_DIR || path.join(__dirname, '..', 'trust'),

  // Simulated ANIP issuer + wallet ("Demo without a phone") and the
  // "Trust this issuer (demo)" button. Never enable in production.
  DEMO_MODE: bool(process.env.DEMO_MODE, true),

  // Simulated payment gateway
  DEMO_PIN: process.env.DEMO_PIN || '1234',
  PIN_ATTEMPTS: Number(process.env.PIN_ATTEMPTS || 3),

  TX_TTL_MS: 10 * 60 * 1000
};
