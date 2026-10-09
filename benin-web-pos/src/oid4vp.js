'use strict';

/**
 * OpenID4VP verifier for the web POS (ISO/IEC 18013-7 style mdoc presentation
 * over the internet, cross-device QR flow). The terminal shows a QR code, the
 * citizen scans it with the EUDI wallet, consents, and the wallet POSTs the
 * encrypted DeviceResponse to response_uri.
 *
 * Derived from "Benin poc/src/oid4vp.js" (the profile already accepted by
 * SIGMA), reduced to the single POS PID request.
 */

const crypto = require('crypto');
const config = require('./config');
const profile = require('./profile');
const { verifyDeviceResponse } = require('./verify/mdoc');
const jwe = require('./verify/jwe');

const transactions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, tx] of transactions) {
    if (now - tx.createdAt > config.TX_TTL_MS) transactions.delete(id);
  }
}, 60 * 1000).unref();

const randomId = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');

/**
 * @param {{ merchant: string, amount: number, currency: string,
 *   policy: { requireTrustedIssuer: boolean, requireAgeOver18: boolean, includePortrait: boolean } }} pos
 */
function createTransaction(pos) {
  const id = crypto.randomUUID();
  const encryption = config.RESPONSE_MODE === 'direct_post.jwt' ? jwe.generateEncryptionKey(randomId(6)) : null;
  const tx = {
    id,
    pos,
    encryption,
    key: randomId(24), // binds the transaction to the terminal's browser tab
    state: randomId(),
    nonce: randomId(),
    clientId: config.CLIENT_ID,
    responseUri: config.RESPONSE_URI,
    requestMode: config.REQUEST_MODE,
    createdAt: Date.now(),
    status: 'pending', // pending → verified | rejected → paid | payment_declined
    walletStep: 'qr_displayed'
  };
  transactions.set(id, tx);
  return tx;
}

const getTransaction = (id) => transactions.get(id);
const deleteTransaction = (id) => transactions.delete(id);

/** One-letter DCQL claim ids keep the by-value QR code small. */
const claimId = (i) => String.fromCharCode(97 + i);

/**
 * DCQL query for the PID mdoc. claim_sets: prefer every requested element,
 * but still match a PID that only has the required ones (the wallet decides
 * what it can share; the POS then reports what is missing).
 */
function dcqlQuery(tx) {
  const elements = profile.elements(tx.pos.policy.includePortrait);
  const ids = elements.map((e, i) => claimId(i));
  // By-value QR codes must stay scannable: intent_to_retain (optional in DCQL)
  // is only sent with request_uri. The POS never retains PID data either way.
  const compact = tx.requestMode === 'value';
  const credential = {
    id: 'pid',
    format: 'mso_mdoc',
    meta: { doctype_value: profile.PID.docType },
    claims: elements.map((e, i) => ({
      ...(config.DCQL_CLAIM_SETS && { id: ids[i] }),
      path: [profile.PID.namespace, e.id],
      ...(!compact && { intent_to_retain: false })
    }))
  };
  if (config.DCQL_CLAIM_SETS) credential.claim_sets = [ids, elements.map((e, i) => (e.required ? ids[i] : null)).filter(Boolean)];
  return { credentials: [credential] };
}

/** client_metadata: HAIP algorithms and the per-transaction response encryption key. */
function clientMetadata(tx) {
  const md = { vp_formats_supported: { mso_mdoc: { issuerauth_alg_values: [-7], deviceauth_alg_values: [-7] } } };
  if (tx.encryption) {
    md.jwks = { keys: [tx.encryption.jwk] };
    md.encrypted_response_enc_values_supported = ['A128GCM'];
  }
  return md;
}

function requestParameters(tx) {
  return {
    response_type: 'vp_token',
    client_id: tx.clientId,
    response_mode: config.RESPONSE_MODE,
    response_uri: tx.responseUri,
    nonce: tx.nonce,
    state: tx.state,
    dcql_query: dcqlQuery(tx),
    client_metadata: clientMetadata(tx)
  };
}

/** Unsigned request object served at request_uri (REQUEST_MODE=reference). */
function requestObject(tx) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'oauth-authz-req+jwt' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ ...requestParameters(tx), aud: 'https://self-issued.me/v2', iat: Math.floor(Date.now() / 1000) })).toString('base64url');
  return `${header}.${payload}.`;
}

/**
 * Query-string encoding that leaves ":" "/" "," "@" readable (shorter QR code);
 * JSON braces and quotes stay percent-encoded (java.net.URI rejects them).
 */
function encodeQuery(query) {
  const enc = (v) => encodeURIComponent(v).replace(/%3A/g, ':').replace(/%2F/g, '/').replace(/%2C/g, ',').replace(/%40/g, '@');
  return Object.entries(query).map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
}

/** The wallet deep link rendered as the QR code. */
function authorizationRequestUri(tx) {
  const scheme = config.WALLET_SCHEME.endsWith('://') ? config.WALLET_SCHEME : `${config.WALLET_SCHEME}://`;
  const query = tx.requestMode === 'reference'
    ? { client_id: tx.clientId, request_uri: `${config.BASE_URL}/oid4vp/request/${tx.id}` }
    : Object.fromEntries(Object.entries(requestParameters(tx)).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return `${scheme}?${encodeQuery(query)}`;
}

/** Flattens the vp_token of any OpenID4VP version into a list of presentations. */
function extractPresentations(vpToken) {
  let token = vpToken;
  if (typeof token === 'string') {
    const trimmed = token.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        token = JSON.parse(trimmed);
      } catch (_) {
        /* a single presentation */
      }
    }
  }
  if (typeof token === 'string') return [token];
  if (Array.isArray(token)) return token.flatMap(extractPresentations);
  if (token && typeof token === 'object') return Object.values(token).flatMap(extractPresentations);
  return [];
}

/**
 * Handles the wallet's direct_post(.jwt) to response_uri. `onResponse(tx, outcome)`
 * receives { results } or { walletError } or { responseError }.
 * Returns { status, body } for the wallet.
 */
async function handleWalletResponse(rawBody, onResponse) {
  let body = rawBody;
  let jweHeader = null;
  if (typeof rawBody.response === 'string') {
    let header;
    try {
      header = jwe.parseHeader(rawBody.response);
    } catch (err) {
      return { status: 400, body: { error: 'invalid_request', error_description: `malformed response JWE: ${err.message}` } };
    }
    const keyTx = [...transactions.values()].find((t) => t.encryption && t.encryption.jwk.kid === header.kid);
    if (!keyTx) return { status: 400, body: { error: 'invalid_request', error_description: 'unknown encryption key' } };
    try {
      const decrypted = jwe.decrypt(rawBody.response, keyTx.encryption.privateKey);
      body = JSON.parse(decrypted.payload.toString('utf8'));
      jweHeader = decrypted.header;
    } catch (err) {
      return { status: 400, body: { error: 'invalid_request', error_description: `cannot decrypt response: ${err.message}` } };
    }
    if (body.state !== keyTx.state) {
      return { status: 400, body: { error: 'invalid_request', error_description: 'state does not match the encryption key' } };
    }
  }

  const tx = [...transactions.values()].find((t) => t.state === body.state);
  if (tx && tx.status !== 'pending' && jweHeader) {
    // Same wallet re-sending a response for a finished transaction: acknowledge only.
    tx.duplicateResponses = (tx.duplicateResponses || 0) + 1;
    return { status: 200, body: {} };
  }
  if (!tx || tx.status !== 'pending') {
    return { status: 400, body: { error: 'invalid_request', error_description: 'unknown, expired or already used state' } };
  }
  tx.walletStep = 'response_received';
  tx.responseAt = Date.now();

  if (tx.encryption && !jweHeader) {
    await onResponse(tx, { responseError: 'unencrypted_response' });
    return { status: 400, body: { error: 'invalid_request', error_description: 'response must be encrypted (direct_post.jwt)' } };
  }
  if (body.error) {
    await onResponse(tx, { walletError: body.error });
    return { status: 200, body: {} };
  }
  if (!body.vp_token) {
    await onResponse(tx, { responseError: 'missing_vp_token' });
    return { status: 400, body: { error: 'invalid_request', error_description: 'missing vp_token' } };
  }

  const expected = {
    docType: profile.PID.docType,
    namespace: profile.PID.namespace,
    clientId: tx.clientId,
    nonce: tx.nonce,
    responseUri: tx.responseUri,
    // encrypted responses bind the SessionTranscript to the verifier key's JWK thumbprint;
    // ISO 18013-7 wallets carry their mdocGeneratedNonce in the JWE "apu"
    jwkThumbprint: tx.encryption ? jwe.thumbprint(tx.encryption.jwk) : null,
    mdocGeneratedNonce: jweHeader && jweHeader.apu ? Buffer.from(jweHeader.apu, 'base64url').toString('utf8') : null
  };
  const presentations = extractPresentations(body.vp_token);
  const results = (await Promise.all(presentations.map((p) => verifyDeviceResponse(p, expected)))).flat();
  await onResponse(tx, { results });
  return { status: 200, body: {} };
}

/** Log line for a wallet POST, without personal data. */
function summaryFor(rawBody) {
  let tx;
  try {
    tx = typeof rawBody.response === 'string'
      ? [...transactions.values()].find((t) => t.encryption && t.encryption.jwk.kid === jwe.parseHeader(rawBody.response).kid)
      : [...transactions.values()].find((t) => t.state === rawBody.state);
  } catch (_) {
    return { status: 'malformed_jwe' };
  }
  if (!tx) return { status: 'unknown_state' };
  return {
    status: tx.status,
    duplicates: tx.duplicateResponses || 0,
    checks: tx.report ? Object.fromEntries(tx.report.checks.map((c) => [c.id, c.status])) : undefined
  };
}

module.exports = {
  createTransaction,
  getTransaction,
  deleteTransaction,
  dcqlQuery,
  requestObject,
  authorizationRequestUri,
  handleWalletResponse,
  extractPresentations,
  summaryFor
};
