'use strict';

require('dotenv').config({ quiet: true });
const path = require('path');

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function list(value, fallback) {
  if (!value) return fallback;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

// Hostnames are case-insensitive, but wallets compare client_id and response_uri
// as strings, so normalise (e.g. "Benin-poc.onrender.com" -> "benin-poc.onrender.com").
function normaliseBaseUrl(value) {
  const url = new URL(value || 'http://localhost:3000');
  return `${url.protocol}//${url.host.toLowerCase()}${url.pathname}`.replace(/\/$/, '');
}
const BASE_URL = normaliseBaseUrl(process.env.BASE_URL);
const CLIENT_ID = process.env.CLIENT_ID || 'benin-eservices-rp.poc';

module.exports = {
  PORT: Number(process.env.PORT || 3000),
  BASE_URL,

  // OpenID4VP client identifiers. Each relying party can override the
  // shared CLIENT_ID if they are registered separately in the ecosystem.
  CLIENT_ID,
  BEDC_CLIENT_ID: process.env.BEDC_CLIENT_ID || CLIENT_ID,
  FDA_CLIENT_ID: process.env.FDA_CLIENT_ID || CLIENT_ID,

  // 'dcql' -> dcql_query (OpenID4VP 1.0, default; the only language the current
  //           EUDI reference wallet library accepts)
  // 'pex'  -> presentation_definition (OpenID4VP drafts 18-23)
  QUERY_LANGUAGE: (process.env.QUERY_LANGUAGE || 'dcql').toLowerCase(),

  // 'reference' -> short QR code with request_uri; the wallet fetches an
  //                unsigned request object (alg "none") from this server (default)
  // 'value'     -> all request parameters in the QR code / deep link. Gives a
  //                ~2,500 character, version 35+ QR code most cameras can't read
  REQUEST_MODE: (process.env.REQUEST_MODE || 'reference').toLowerCase(),

  // 'direct_post.jwt' -> the wallet encrypts its response (JWE, ECDH-ES + AES-GCM)
  //                     to a per-request key; required by HAIP wallets (e.g. SIGMA)
  // 'direct_post'     -> plain form POST (older drafts / test wallets)
  RESPONSE_MODE: (process.env.RESPONSE_MODE || 'direct_post.jwt').toLowerCase(),

  // Send client_metadata (vp_formats) in the request. Some older wallets
  // reject unknown metadata; set to false to leave it out.
  CLIENT_METADATA: bool(process.env.CLIENT_METADATA, true),

  // Optional client_id_scheme parameter for pre-1.0 wallets (e.g. redirect_uri)
  CLIENT_ID_SCHEME: process.env.CLIENT_ID_SCHEME || '',

  // Custom URL scheme used for the same-device deep link / QR code.
  WALLET_SCHEME: process.env.WALLET_SCHEME || 'openid4vp://',

  // Verification policy. For the PoC the RP verifies everything it can and
  // shows the result; set these to true to hard-fail on a missing check.
  REQUIRE_TRUSTED_ISSUER: bool(process.env.REQUIRE_TRUSTED_ISSUER, false),
  REQUIRE_HOLDER_BINDING: bool(process.env.REQUIRE_HOLDER_BINDING, false),

  // Directory containing trusted issuer / IACA certificates (PEM).
  TRUST_DIR: process.env.TRUST_DIR || path.join(__dirname, '..', 'trust'),

  // SD-JWT issuers (iss values) whose keys may be resolved from
  // <iss>/.well-known/jwt-vc-issuer when the credential carries no x5c.
  TRUSTED_ISSUERS: list(process.env.TRUSTED_ISSUERS, []),

  // Adds a "Simulate wallet" button that presents rulebook-conformant demo
  // credentials signed by an ephemeral demo issuer. Never enable in production.
  DEMO_MODE: bool(process.env.DEMO_MODE, true),

  // Birth certificate format asked for in the compact by-value QR request, where only
  // one format fits: 'mso_mdoc' (SIGMA holds it as mdoc, no vct) or 'dc+sd-jwt'.
  // Other request modes ask for both formats.
  BIRTH_CERT_COMPACT_FORMAT: process.env.BIRTH_CERT_COMPACT_FORMAT || 'mso_mdoc',

  // Accepted SD-JWT VC types for the birth certificate attestation.
  BIRTH_CERT_VCTS: list(process.env.BIRTH_CERT_VCTS, [
    'https://credentials.benin.example/birth_certificate',
    'eu.europa.ec.eudi.birth_certificate.1',
    'urn:eu.europa.ec.eudi:birth_certificate:1'
  ]),

  SESSION_SECRET: process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex'),
  TX_TTL_MS: 10 * 60 * 1000,
  LOGIN_TTL_MS: 30 * 60 * 1000
};
