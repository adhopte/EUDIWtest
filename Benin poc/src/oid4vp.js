'use strict';

const crypto = require('crypto');
const config = require('./config');
const { RELYING_PARTIES } = require('./rulebook');
const { verifySdJwtPresentation } = require('./verify/sdjwt');
const { verifyDeviceResponse } = require('./verify/mdoc');
const jwe = require('./verify/jwe');

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

if (config.CLIENT_ID.startsWith('redirect_uri:') && config.CLIENT_ID.toLowerCase() !== `redirect_uri:${RESPONSE_URI}`.toLowerCase()) {
  console.warn(`WARNING: CLIENT_ID ${config.CLIENT_ID} must be exactly redirect_uri:${RESPONSE_URI}`);
}

function clientIdFor(rpId) {
  const id = rpId === 'bedc' ? config.BEDC_CLIENT_ID : config.FDA_CLIENT_ID;
  // redirect_uri: client IDs must equal response_uri; fix host capitalisation differences
  return id.toLowerCase() === `redirect_uri:${RESPONSE_URI}`.toLowerCase() ? `redirect_uri:${RESPONSE_URI}` : id;
}

/**
 * Request variants for the wallet test page. Each one changes only how the
 * request is delivered / identified; verification is identical. `env` is what
 * to set on the server to make that variant the default.
 */
const VARIANTS = {
  configured: {
    profile: () => ({}),
    env: () => ({})
  },
  legacy: {
    // Same shape as the original root-level dummy RP: everything in the QR code,
    // presentation_definition, bare client_id, no client_metadata
    profile: () => ({ requestMode: 'value', queryLanguage: 'pex', clientMetadata: false, clientIdScheme: '', responseMode: 'direct_post' }),
    env: () => ({ REQUEST_MODE: 'value', QUERY_LANGUAGE: 'pex', CLIENT_METADATA: 'false', RESPONSE_MODE: 'direct_post' })
  },
  dcql: {
    // OpenID4VP 1.0 query language, request by reference
    profile: () => ({ requestMode: 'reference', queryLanguage: 'dcql' }),
    env: () => ({ REQUEST_MODE: 'reference', QUERY_LANGUAGE: 'dcql' })
  },
  redirect_uri: {
    // Pre-1.0 drafts: client_id = response_uri with client_id_scheme=redirect_uri (unsigned requests allowed)
    profile: () => ({ requestMode: 'value', queryLanguage: 'pex', clientId: RESPONSE_URI, clientIdScheme: 'redirect_uri', clientMetadata: false }),
    env: () => ({ REQUEST_MODE: 'value', QUERY_LANGUAGE: 'pex', CLIENT_ID: RESPONSE_URI, CLIENT_ID_SCHEME: 'redirect_uri', CLIENT_METADATA: 'false' })
  },
  redirect_uri_prefix: {
    // OpenID4VP 1.0: "redirect_uri:" client identifier prefix, DCQL
    // Unsigned, by value, encrypted response: the only unsigned form the current EUDI
    // reference library (eudi-lib-jvm-openid4vp-kt) accepts without pre-registration,
    // plus direct_post.jwt required by HAIP wallets such as SIGMA. client_metadata
    // then carries only jwks, encryption methods and vp_formats_supported.
    profile: () => ({ requestMode: 'value', queryLanguage: 'dcql', clientId: `redirect_uri:${RESPONSE_URI}`, clientIdScheme: '', clientMetadata: false, responseMode: 'direct_post.jwt' }),
    env: () => ({ REQUEST_MODE: 'value', QUERY_LANGUAGE: 'dcql', CLIENT_ID: `redirect_uri:${RESPONSE_URI}`, CLIENT_METADATA: 'false', RESPONSE_MODE: 'direct_post.jwt' })
  }
};

function createTransaction(rpId, variant = 'configured') {
  const rp = RELYING_PARTIES[rpId];
  if (!rp) throw new Error(`unknown relying party ${rpId}`);
  if (!VARIANTS[variant]) throw new Error(`unknown variant ${variant}`);
  const profile = {
    requestMode: config.REQUEST_MODE,
    queryLanguage: config.QUERY_LANGUAGE,
    clientId: clientIdFor(rpId),
    clientIdScheme: config.CLIENT_ID_SCHEME,
    clientMetadata: config.CLIENT_METADATA,
    responseMode: config.RESPONSE_MODE,
    ...VARIANTS[variant].profile()
  };
  const id = crypto.randomUUID();
  // Per-request response encryption key (never reused across transactions)
  const encryption = profile.responseMode === 'direct_post.jwt' ? jwe.generateEncryptionKey(crypto.randomBytes(6).toString('base64url')) : null;
  const tx = {
    encryption,
    variant,
    profile,
    id,
    rpId,
    state: crypto.randomBytes(16).toString('base64url'),
    nonce: crypto.randomBytes(16).toString('base64url'),
    browserKey: crypto.randomBytes(24).toString('base64url'),
    responseCode: crypto.randomBytes(24).toString('base64url'),
    clientId: profile.clientId,
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

/**
 * DCQL query. `compact` leaves out intent_to_retain (optional in DCQL) to keep
 * by-value QR codes small enough for phone cameras.
 */
// One-letter DCQL claim ids keep by-value QR codes small
const claimId = (i) => String.fromCharCode(97 + i);

function dcqlQuery(rp, { compact = false } = {}) {
  // Compact (by-value QR) requests with alternative formats only ask for the
  // required claims, without claim_sets, so the QR code stays scannable.
  const minimal = compact && Boolean(rp.alternative);
  const claims = minimal ? rp.compactClaims || rp.required : rp.claims;
  const useSets = rp.claimSets && claims.length > rp.required.length;
  const credentialQuery = (q) => {
    const isMdoc = q.format === 'mso_mdoc';
    return {
      id: q.credential,
      format: q.format,
      meta: isMdoc ? { doctype_value: q.docType } : { vct_values: q.vcts },
      claims: claims.map((c, i) => {
        const claim = { path: isMdoc ? [q.namespace, c] : [c] };
        if (useSets) claim.id = claimId(i);
        if (isMdoc && !compact) claim.intent_to_retain = false;
        return claim;
      }),
      // Prefer every requested claim, but still match a credential that only
      // has the claims the relying party cannot work without
      ...(useSets && { claim_sets: [claims.map((c, i) => claimId(i)), rp.required.map((c) => claimId(claims.indexOf(c)))] })
    };
  };
  if (minimal) {
    // Only one format fits in a scannable QR code
    const pick = rp.alternative.format === config.BIRTH_CERT_COMPACT_FORMAT ? rp.alternative : rp;
    return { credentials: [credentialQuery({ ...rp, ...pick })] };
  }
  const query = { credentials: [credentialQuery(rp)] };
  if (rp.alternative) {
    query.credentials.push(credentialQuery({ ...rp.alternative }));
    // either format satisfies the request
    query.credential_sets = [{ options: [[rp.credential], [rp.alternative.credential]] }];
  }
  return query;
}

const VP_FORMATS_SUPPORTED = {
  mso_mdoc: { issuerauth_alg_values: [-7, -35, -36, -8], deviceauth_alg_values: [-7, -35, -36, -8] },
  'dc+sd-jwt': { 'sd-jwt_alg_values': SIGNING_ALGS, 'kb-jwt_alg_values': SIGNING_ALGS }
};

// HAIP mandates ES256; used in the compact metadata to keep QR codes scannable
const VP_FORMATS_SUPPORTED_HAIP = {
  mso_mdoc: { issuerauth_alg_values: [-7], deviceauth_alg_values: [-7] },
  'dc+sd-jwt': { 'sd-jwt_alg_values': ['ES256'], 'kb-jwt_alg_values': ['ES256'] }
};

/**
 * client_metadata. `full` adds the pre-1.0 vp_formats and a display name; the
 * response-encryption part (jwks, encrypted_response_enc_values_supported) is
 * always sent when the response is encrypted, since the wallet needs the key.
 */
function clientMetadata(tx) {
  const sdJwt = { 'sd-jwt_alg_values': SIGNING_ALGS, 'kb-jwt_alg_values': SIGNING_ALGS };
  const format = RELYING_PARTIES[tx.rpId].format;
  const full = tx.profile.clientMetadata;
  const md = { vp_formats_supported: { [format]: (full ? VP_FORMATS_SUPPORTED : VP_FORMATS_SUPPORTED_HAIP)[format] } };
  if (full) {
    md.client_name = 'Benin Government eServices';
    md.vp_formats = { mso_mdoc: { alg: SIGNING_ALGS }, 'vc+sd-jwt': sdJwt, 'dc+sd-jwt': sdJwt };
  }
  if (tx.encryption) {
    md.jwks = { keys: [tx.encryption.jwk] };
    md.encrypted_response_enc_values_supported = full ? jwe.SUPPORTED_ENC : ['A128GCM'];
    if (full) {
      // pre-1.0 drafts
      md.authorization_encrypted_response_alg = 'ECDH-ES';
      md.authorization_encrypted_response_enc = 'A128GCM';
    }
  }
  return md;
}

/** OpenID4VP authorization request parameters (response_mode=direct_post). */
function requestParameters(tx) {
  const rp = RELYING_PARTIES[tx.rpId];
  const params = {
    response_type: 'vp_token',
    client_id: tx.clientId,
    response_mode: tx.profile.responseMode,
    response_uri: tx.responseUri,
    nonce: tx.nonce,
    state: tx.state
  };
  if (tx.profile.clientMetadata || tx.encryption) params.client_metadata = clientMetadata(tx);
  if (tx.profile.clientIdScheme) params.client_id_scheme = tx.profile.clientIdScheme;
  if (tx.profile.queryLanguage === 'dcql') params.dcql_query = dcqlQuery(rp, { compact: tx.profile.requestMode === 'value' && !tx.profile.clientMetadata });
  else params.presentation_definition = presentationDefinition(rp);
  return params;
}

/** Unsigned request object served at request_uri (RFC 9101, alg "none"). */
function requestObject(tx) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'oauth-authz-req+jwt' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ ...requestParameters(tx), aud: 'https://self-issued.me/v2', iat: Math.floor(Date.now() / 1000) })).toString('base64url');
  return `${header}.${payload}.`;
}

/**
 * Query-string encoding that leaves RFC 3986 query-safe characters
 * (":" "/" "," "@") readable. JSON braces and quotes stay percent-encoded
 * (java.net.URI rejects them), and "&" "=" "+" "#" are always encoded.
 */
function encodeQuery(query) {
  const enc = (v) => encodeURIComponent(v).replace(/%3A/g, ':').replace(/%2F/g, '/').replace(/%2C/g, ',').replace(/%40/g, '@');
  return Object.entries(query).map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
}

/** Builds the wallet deep link (also rendered as the QR code). */
function authorizationRequest(tx) {
  const scheme = config.WALLET_SCHEME.endsWith('://') ? config.WALLET_SCHEME : `${config.WALLET_SCHEME}://`;
  let query;
  if (tx.profile.requestMode === 'reference') {
    const q = { client_id: tx.clientId, request_uri: `${config.BASE_URL}/oid4vp/request/${tx.id}` };
    if (tx.profile.clientIdScheme) q.client_id_scheme = tx.profile.clientIdScheme;
    query = q;
  } else {
    const params = requestParameters(tx);
    query = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  }
  return { uri: `${scheme}?${encodeQuery(query)}` };
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

async function verifyPresentation(presentation, tx, jweHeader) {
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
  const mdoc = rp.format === 'mso_mdoc' ? rp : rp.alternative || {};
  return verifyDeviceResponse(presentation, {
    docType: mdoc.docType,
    namespace: mdoc.namespace,
    clientId: tx.clientId,
    nonce: tx.nonce,
    responseUri: tx.responseUri,
    // encrypted responses bind the SessionTranscript to the verifier's encryption key,
    // and ISO 18013-7 wallets carry their mdocGeneratedNonce in the JWE "apu"
    jwkThumbprint: tx.encryption ? jwe.thumbprint(tx.encryption.jwk) : null,
    mdocGeneratedNonce: jweHeader && jweHeader.apu ? Buffer.from(jweHeader.apu, 'base64url').toString('utf8') : null
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
  const accepted = [rp.format, rp.alternative && rp.alternative.format].filter(Boolean);
  if (!accepted.includes(result.format)) reasons.push(`unexpected_format:${result.format}`);
  for (const claim of rp.required) {
    if (result.claims[claim] === undefined) reasons.push(`missing_claim:${claim}`);
  }
  return reasons;
}

/**
 * Handles the wallet's direct_post to response_uri. Returns
 * { status, body } to send back to the wallet.
 */
async function handleWalletResponse(rawBody) {
  let body = rawBody;
  let jweHeader = null;
  if (typeof rawBody.response === 'string') {
    // direct_post.jwt: the wallet posts response=<JWE>; the kid names our per-request key
    let header;
    try {
      header = jwe.parseHeader(rawBody.response);
    } catch (err) {
      return { status: 400, body: { error: 'invalid_request', error_description: `malformed response JWE: ${err.message}` } };
    }
    const keyTx = transactions.get(header.kid) || [...transactions.values()].find((t) => t.encryption && t.encryption.jwk.kid === header.kid);
    if (!keyTx || !keyTx.encryption) {
      return { status: 400, body: { error: 'invalid_request', error_description: 'unknown encryption key' } };
    }
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
    // The wallet re-sent a response (decrypted with this transaction's key, so it
    // is the same wallet) for a login that is already finished: acknowledge it
    // without processing it again.
    tx.duplicateResponses = (tx.duplicateResponses || 0) + 1;
    return { status: 200, body: {} };
  }
  if (!tx || tx.status !== 'pending') {
    return { status: 400, body: { error: 'invalid_request', error_description: 'unknown, expired or already used state' } };
  }
  tx.walletStep = 'response_received';
  if (tx.encryption && !jweHeader) {
    tx.status = 'rejected';
    tx.reasons = ['unencrypted_response'];
    return { status: 400, body: { error: 'invalid_request', error_description: 'response must be encrypted (direct_post.jwt)' } };
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
  const results = (await Promise.all(presentations.map((p) => verifyPresentation(p, tx, jweHeader)))).flat();
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

  // Same-device flow only: the wallet sends the user's browser back to the RP.
  // In the cross-device (QR) flow the desktop page is already polling, and a
  // redirect_uri makes some wallets (e.g. SIGMA) re-open the consent screen.
  if (!tx.sameDevice) return { status: 200, body: {} };
  const redirectUri = `${config.BASE_URL}/${tx.rpId}/callback?tx=${tx.id}&response_code=${tx.responseCode}`;
  return { status: 200, body: { redirect_uri: redirectUri } };
}

/** One-line outcome of a transaction for the server log (no personal data). */
function summary(state) {
  const tx = [...transactions.values()].find((t) => t.state === state);
  if (!tx) return { status: 'unknown_state' };
  return {
    rp: tx.rpId,
    variant: tx.variant,
    status: tx.status,
    duplicates: tx.duplicateResponses || 0,
    credentials: (tx.results || []).map((r) => `${r.format}:${r.vct || r.docType || '?'}`),
    reasons: tx.reasons,
    checks: (tx.results || []).map((r) => Object.fromEntries(Object.entries(r.checks).map(([k, v]) => [k, v.ok ? 'ok' : v.detail || 'fail'])))
  };
}

/** Log summary for a raw wallet POST (plain or encrypted). */
function summaryFor(rawBody) {
  if (typeof rawBody.response === 'string') {
    try {
      const tx = transactions.get(jwe.parseHeader(rawBody.response).kid);
      return summary(tx && tx.state);
    } catch (_) {
      return { status: 'malformed_jwe' };
    }
  }
  return summary(rawBody.state);
}

module.exports = {
  VARIANTS,
  summary,
  summaryFor,
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
