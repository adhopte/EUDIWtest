'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const { decodeSdJwtVc } = require('./lib/sdjwt');

let cborDecode = null;
try {
  // Optional: only used if a wallet returns an mDoc DeviceResponse (CBOR)
  // instead of / alongside an SD-JWT VC.
  cborDecode = require('cbor-x').decode;
} catch (e) {
  console.warn('cbor-x not available — mDoc responses will not be parsed.');
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const PORT = process.env.PORT || 3000;

// The wallet ecosystem you're demoing against may use different credential
// type identifiers for "the same" PID. Defaults below match the EUDI ARF
// reference values; override via env once you know the Benin wallet /
// SIGMA Issuer's actual vct and mDoc doctype (they may differ).
const PID_SDJWT_VCT = process.env.PID_SDJWT_VCT || 'urn:eudi:pid:1';
const PID_MDOC_DOCTYPE = process.env.PID_MDOC_DOCTYPE || 'eu.europa.ec.eudi.pid.1';
const BILLER_NAME = process.env.BILLER_NAME || 'Konsa Énergie & Télécom';

// In-memory session store — fine for a demo, NOT for production.
// session = {
//   id, state, nonce, createdAt, status: 'pending'|'verified'|'error',
//   vpToken, presentationSubmission, decoded, error
// }
const sessions = new Map();

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes
function pruneSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}
setInterval(pruneSessions, 60 * 1000).unref();

/**
 * The credential(s) this RP asks for. This targets a PID (national eID)
 * in either format, so it works whether the wallet answers with an
 * SD-JWT VC or an mDoc. Two different wallet ecosystems (the EUDI
 * reference wallet vs. a Benin-specific build) may use different type
 * identifiers for what is conceptually "the same" PID — set
 * PID_SDJWT_VCT / PID_MDOC_DOCTYPE env vars once you know the exact
 * values the SIGMA Issuer / Benin wallet actually use.
 */
function buildPresentationDefinition(sessionId) {
  return {
    id: `pid-request-${sessionId}`,
    input_descriptors: [
      {
        id: PID_MDOC_DOCTYPE,
        name: 'National PID',
        purpose: `Verify your identity to log in to ${BILLER_NAME} online`,
        format: {
          'vc+sd-jwt': { 'sd-jwt_alg_values': ['ES256'] },
          mso_mdoc: { alg: ['ES256'] }
        },
        constraints: {
          limit_disclosure: 'required',
          fields: [
            { path: ['$.given_name', `$['${PID_MDOC_DOCTYPE}']['given_name']`] },
            { path: ['$.family_name', `$['${PID_MDOC_DOCTYPE}']['family_name']`] },
            { path: ['$.birth_date', `$['${PID_MDOC_DOCTYPE}']['birth_date']`] }
          ]
        }
      }
    ]
  };
}

/**
 * GET /api/config — lets the front-end pull branding without hardcoding it.
 */
app.get('/api/config', (req, res) => {
  res.json({ billerName: BILLER_NAME });
});

/**
 * POST /api/session
 * Creates a fresh verification session and returns:
 *  - the openid4vp:// deep link (for a wallet on the same device, or to
 *    render as a QR code for cross-device)
 *  - a QR code data URL of that deep link
 */
app.post('/api/session', (req, res) => {
  const id = uuidv4();
  const state = uuidv4();
  const nonce = crypto.randomBytes(16).toString('hex');

  // client_id_scheme=redirect_uri is the least-friction scheme for a demo:
  // no PKI / signing required, but two things follow from that:
  //  1. client_id MUST literally equal response_uri (self-consistency
  //     check the wallet performs instead of a signature check).
  //  2. The request must be sent PLAIN — the EUDI reference wallet's
  //     OpenID4VP library explicitly disallows a signed/JAR request
  //     object for this scheme, so we do NOT wrap it in a JWT.
  const responseUri = `${BASE_URL}/api/response`;
  const clientId = responseUri;
  const presentationDefinition = buildPresentationDefinition(id);

  const session = {
    id,
    state,
    nonce,
    createdAt: Date.now(),
    status: 'pending',
    presentationDefinition
  };
  sessions.set(id, session);

  // Keep the request itself by value (plain, no JWT) but move the bulky
  // presentation_definition out to its own URL — this is exactly how
  // the official EUDI reference verifier keeps its QR codes short while
  // staying JAR-free for redirect_uri-scheme clients.
  const params = new URLSearchParams({
    client_id: clientId,
    client_id_scheme: 'redirect_uri',
    response_type: 'vp_token',
    response_mode: 'direct_post',
    response_uri: responseUri,
    nonce,
    state,
    presentation_definition_uri: `${BASE_URL}/api/pd/${id}`
  });

  const deepLink = `openid4vp://?${params.toString()}`;

  QRCode.toDataURL(deepLink, { margin: 1, width: 320 }, (err, dataUrl) => {
    if (err) {
      return res.status(500).json({ error: 'qr_generation_failed', detail: err.message });
    }
    res.json({
      sessionId: id,
      state,
      nonce,
      authorizationRequestUri: deepLink,
      qrCodeDataUrl: dataUrl,
      responseUri: `${BASE_URL}/api/response`
    });
  });
});

/**
 * GET /api/pd/:id  — the `presentation_definition_uri` the wallet fetches.
 * Plain JSON, no signing — matches redirect_uri client_id_scheme, which
 * per the wallet's OpenID4VP library must NOT receive a JAR/JWT request.
 */
app.get('/api/pd/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'not_found' });
  res.json(session.presentationDefinition);
});

/**
 * POST /api/response  (this is the OpenID4VP `response_uri`)
 * The wallet posts here directly (response_mode=direct_post) with:
 *   vp_token, presentation_submission, state  (application/x-www-form-urlencoded)
 */
app.post('/api/response', (req, res) => {
  const { vp_token, presentation_submission, state } = req.body;

  if (!state) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'missing state' });
  }

  const session = [...sessions.values()].find((s) => s.state === state);
  if (!session) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'unknown or expired state' });
  }

  if (!vp_token) {
    session.status = 'error';
    session.error = 'missing vp_token';
    return res.status(400).json({ error: 'invalid_request', error_description: 'missing vp_token' });
  }

  try {
    let submission = presentation_submission;
    if (typeof submission === 'string') {
      try { submission = JSON.parse(submission); } catch (_) { /* leave as string */ }
    }

    const tokens = Array.isArray(vp_token) ? vp_token : [vp_token];
    const decoded = tokens.map((token) => decodeAnyCredential(token));

    session.status = 'verified';
    session.vpToken = vp_token;
    session.presentationSubmission = submission;
    session.decoded = decoded;
    session.verifiedAt = Date.now();

    // Per OpenID4VP direct_post, a 200 (optionally with a redirect_uri
    // the wallet's browser component should navigate to) is expected.
    return res.status(200).json({});
  } catch (err) {
    session.status = 'error';
    session.error = err.message;
    return res.status(400).json({ error: 'invalid_request', error_description: err.message });
  }
});

function decodeAnyCredential(token) {
  // SD-JWT VC: contains '~' separators and starts with a JWT (header.payload.sig)
  if (typeof token === 'string' && token.includes('~')) {
    return { format: 'vc+sd-jwt', ...decodeSdJwtVc(token) };
  }

  // mDoc DeviceResponse: base64url-encoded CBOR
  if (cborDecode) {
    try {
      const buf = Buffer.from(token, 'base64url');
      const decoded = cborDecode(buf);
      return { format: 'mso_mdoc', raw: summarizeCbor(decoded), signatureVerified: false };
    } catch (e) {
      // fall through
    }
  }

  throw new Error('Unrecognized vp_token format (not SD-JWT, and mDoc CBOR parse failed)');
}

// CBOR can contain Buffers/Maps that don't JSON.stringify cleanly — flatten for display.
function summarizeCbor(value, depth = 0) {
  if (depth > 6) return '…';
  if (Buffer.isBuffer(value)) return `<bytes:${value.length}>`;
  if (value instanceof Map) {
    const obj = {};
    for (const [k, v] of value) obj[String(k)] = summarizeCbor(v, depth + 1);
    return obj;
  }
  if (Array.isArray(value)) return value.map((v) => summarizeCbor(v, depth + 1));
  if (value && typeof value === 'object') {
    const obj = {};
    for (const k of Object.keys(value)) obj[k] = summarizeCbor(value[k], depth + 1);
    return obj;
  }
  return value;
}

/**
 * GET /api/session/:id
 * Polled by the demo front-end to show live status + decoded claims.
 */
app.get('/api/session/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'not_found' });
  res.json(session);
});

/**
 * GET /.well-known/openid4vp-verifier (informational, not required by spec)
 */
app.get('/health', (req, res) => res.json({
  ok: true,
  baseUrl: BASE_URL,
  billerName: BILLER_NAME,
  pidSdJwtVct: PID_SDJWT_VCT,
  pidMdocDoctype: PID_MDOC_DOCTYPE
}));

app.listen(PORT, () => {
  console.log(`${BILLER_NAME} — OpenID4VP verifier listening on port ${PORT}`);
  console.log(`BASE_URL=${BASE_URL}  (must be the public HTTPS URL wallets can reach)`);
  console.log(`response_uri = ${BASE_URL}/api/response`);
  console.log(`requesting: sd-jwt vct=${PID_SDJWT_VCT}  |  mdoc doctype=${PID_MDOC_DOCTYPE}`);
});
