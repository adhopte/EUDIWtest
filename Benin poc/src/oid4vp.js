'use strict';

const crypto = require('crypto');
const config = require('./config');
const { RELYING_PARTIES } = require('./rulebook');
const { verifySdJwtPresentation } = require('./verify/sdjwt');
const { verifyDeviceResponse } = require('./verify/mdoc');

const SIGNING_ALGS = ['ES256', 'ES384', 'ES512', 'EdDSA'];
const RESPONSE_URI = `${config.BASE_URL}/oid4vp/response`;

// In-memory transaction store — fine for a single-instance PoC.
const transactions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, tx] of transactions) {
    if (now - tx.createdAt > config.TX_TTL_MS) transactions.delete(id);
  }
}, 60 * 1000).unref();

function clientIdFor(rpId) {
  return rpId === 'bedc' ? config.BEDC_CLIENT_ID : config.FDA_CLIENT_ID;
}

function createTransaction(rpId) {
  const rp = RELYING_PARTIES[rpId];
  if (!rp) throw new Error(`unknown relying party ${rpId}`);
  const tx = {
    id: crypto.randomUUID(),
    rpId,
    state: crypto.randomBytes(16).toString('base64url'),
    nonce: crypto.randomBytes(16).toString('base64url'),
    browserKey: crypto.randomBytes(24).toString('base64url'),
    responseCode: crypto.randomBytes(24).toString('base64url'),
    clientId: clientIdFor(rpId),
    responseUri: RESPONSE_URI,
    createdAt: Date.now(),
    status: 'pending'
  };
  transactions.set(tx.id, tx);
  return tx;
}

const getTransaction = (id) => transactions.get(id);

function presentationDefinition(rp) {
  if (rp.format === 'mso_mdoc') {
    return {
      id: `${rp.id}-${rp.credential}`,
      input_descriptors: [
        {
          id: rp.docType,
          format: { mso_mdoc: { alg: SIGNING_ALGS } },
          constraints: {
            limit_disclosure: 'required',
            fields: rp.claims.map((c) => ({ path: [`$['${rp.namespace}']['${c}']`], intent_to_retain: false }))
          }
        }
      ]
    };
  }
  const sdJwtFormat = { 'sd-jwt_alg_values': SIGNING_ALGS, 'kb-jwt_alg_values': SIGNING_ALGS };
  return {
    id: `${rp.id}-${rp.credential}`,
    input_descriptors: [
      {
        id: rp.credential,
        format: { 'vc+sd-jwt': sdJwtFormat, 'dc+sd-jwt': sdJwtFormat },
        constraints: {
          limit_disclosure: 'required',
          fields: [
            { path: ['$.vct'], filter: { type: 'string', enum: rp.vcts } },
            ...rp.claims.map((c) => ({ path: [`$.${c}`], intent_to_retain: false }))
          ]
        }
      }
    ]
  };
}

function dcqlQuery(rp) {
  const isMdoc = rp.format === 'mso_mdoc';
  return {
    credentials: [
      {
        id: rp.credential,
        format: rp.format,
        meta: isMdoc ? { doctype_value: rp.docType } : { vct_values: rp.vcts },
        claims: rp.claims.map((c) =>
          isMdoc ? { path: [rp.namespace, c], intent_to_retain: false } : { path: [c] }
        )
      }
    ]
  };
}

function clientMetadata() {
  const sdJwt = { 'sd-jwt_alg_values': SIGNING_ALGS, 'kb-jwt_alg_values': SIGNING_ALGS };
  const mdoc = { alg: SIGNING_ALGS };
  return {
    client_name: 'Benin Government eServices',
    vp_formats: { mso_mdoc: mdoc, 'vc+sd-jwt': sdJwt, 'dc+sd-jwt': sdJwt },
    vp_formats_supported: {
      mso_mdoc: { issuerauth_alg_values: [-7, -35, -36, -8], deviceauth_alg_values: [-7, -35, -36, -8] },
      'dc+sd-jwt': sdJwt
    }
  };
}

/** OpenID4VP authorization request parameters (response_mode=direct_post). */
function requestParameters(tx) {
  const rp = RELYING_PARTIES[tx.rpId];
  const params = {
    response_type: 'vp_token',
    client_id: tx.clientId,
    response_mode: 'direct_post',
    response_uri: tx.responseUri,
    nonce: tx.nonce,
    state: tx.state,
    client_metadata: clientMetadata()
  };
  if (config.CLIENT_ID_SCHEME) params.client_id_scheme = config.CLIENT_ID_SCHEME;
  if (config.QUERY_LANGUAGE === 'dcql') params.dcql_query = dcqlQuery(rp);
  else params.presentation_definition = presentationDefinition(rp);
  return params;
}

/** Unsigned request object served at request_uri (RFC 9101, alg "none"). */
function requestObject(tx) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'oauth-authz-req+jwt' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ ...requestParameters(tx), aud: 'https://self-issued.me/v2', iat: Math.floor(Date.now() / 1000) })).toString('base64url');
  return `${header}.${payload}.`;
}

/** Builds the wallet deep link (also rendered as the QR code). */
function authorizationRequest(tx) {
  const scheme = config.WALLET_SCHEME.endsWith('://') ? config.WALLET_SCHEME : `${config.WALLET_SCHEME}://`;
  let query;
  if (config.REQUEST_MODE === 'reference') {
    const q = { client_id: tx.clientId, request_uri: `${config.BASE_URL}/oid4vp/request/${tx.id}` };
    if (config.CLIENT_ID_SCHEME) q.client_id_scheme = config.CLIENT_ID_SCHEME;
    query = q;
  } else {
    const params = requestParameters(tx);
    query = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  }
  return { uri: `${scheme}?${new URLSearchParams(query).toString()}` };
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
        /* not JSON: a single presentation */
      }
    }
  }
  if (typeof token === 'string') return [token];
  if (Array.isArray(token)) return token.flatMap(extractPresentations);
  if (token && typeof token === 'object') return Object.values(token).flatMap(extractPresentations);
  return [];
}

async function verifyPresentation(presentation, tx) {
  const rp = RELYING_PARTIES[tx.rpId];
  if (presentation.includes('~')) {
    return [
      await verifySdJwtPresentation(presentation, {
        nonce: tx.nonce,
        audiences: [tx.clientId, `x509_san_dns:${tx.clientId}`, `redirect_uri:${tx.clientId}`],
        vcts: rp.vcts || []
      })
    ];
  }
  return verifyDeviceResponse(presentation, {
    docType: rp.docType,
    namespace: rp.namespace,
    clientId: tx.clientId,
    nonce: tx.nonce,
    responseUri: tx.responseUri
  });
}

/** Applies the relying-party acceptance policy to a verified presentation. */
function evaluate(result, rp) {
  const reasons = [];
  const c = result.checks;
  if (result.errors.length) reasons.push(...result.errors);
  for (const name of ['credentialType', 'issuerSignature', 'disclosures', 'validity']) {
    if (!c[name] || !c[name].ok) reasons.push(`check_failed:${name}`);
  }
  if (config.REQUIRE_TRUSTED_ISSUER && !(c.trustedIssuer && c.trustedIssuer.ok)) reasons.push('check_failed:trustedIssuer');
  if (config.REQUIRE_HOLDER_BINDING && !(c.holderBinding && c.holderBinding.ok)) reasons.push('check_failed:holderBinding');
  const expectedFormat = rp.format === 'mso_mdoc' ? 'mso_mdoc' : 'dc+sd-jwt';
  if (result.format !== expectedFormat) reasons.push(`unexpected_format:${result.format}`);
  for (const claim of rp.required) {
    if (result.claims[claim] === undefined) reasons.push(`missing_claim:${claim}`);
  }
  return reasons;
}

/**
 * Handles the wallet's direct_post to response_uri. Returns
 * { status, body } to send back to the wallet.
 */
async function handleWalletResponse(body) {
  const tx = [...transactions.values()].find((t) => t.state === body.state);
  if (!tx || tx.status !== 'pending') {
    return { status: 400, body: { error: 'invalid_request', error_description: 'unknown, expired or already used state' } };
  }
  if (body.error) {
    tx.status = 'rejected';
    tx.reasons = [`wallet_error:${body.error}`];
    return { status: 200, body: {} };
  }
  if (!body.vp_token) {
    tx.status = 'rejected';
    tx.reasons = ['missing_vp_token'];
    return { status: 400, body: { error: 'invalid_request', error_description: 'missing vp_token' } };
  }

  const rp = RELYING_PARTIES[tx.rpId];
  const presentations = extractPresentations(body.vp_token);
  const results = (await Promise.all(presentations.map((p) => verifyPresentation(p, tx)))).flat();
  const evaluated = results.map((r) => ({ result: r, reasons: evaluate(r, rp) }));
  const accepted = evaluated.find((e) => e.reasons.length === 0);

  tx.results = results;
  if (accepted) {
    tx.status = 'verified';
    tx.accepted = accepted.result;
  } else {
    tx.status = 'rejected';
    tx.reasons = evaluated.length ? evaluated[0].reasons : ['no_presentation'];
  }
  tx.completedAt = Date.now();

  // Same-device flow: the wallet sends the user's browser back to the RP.
  const redirectUri = `${config.BASE_URL}/${tx.rpId}/callback?tx=${tx.id}&response_code=${tx.responseCode}`;
  return { status: 200, body: { redirect_uri: redirectUri } };
}

/** One-line outcome of a transaction for the server log (no personal data). */
function summary(state) {
  const tx = [...transactions.values()].find((t) => t.state === state);
  if (!tx) return { status: 'unknown_state' };
  return {
    rp: tx.rpId,
    status: tx.status,
    reasons: tx.reasons,
    checks: (tx.results || []).map((r) => Object.fromEntries(Object.entries(r.checks).map(([k, v]) => [k, v.ok ? 'ok' : v.detail || 'fail'])))
  };
}

module.exports = {
  summary,
  createTransaction,
  getTransaction,
  authorizationRequest,
  requestObject,
  presentationDefinition,
  dcqlQuery,
  handleWalletResponse,
  extractPresentations,
  RESPONSE_URI
};
