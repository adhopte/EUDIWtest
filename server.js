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
const CLIENT_ID = process.env.CLIENT_ID || 'dummy-rp.benin-poc';
const PORT = process.env.PORT || 3000;

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
 * The credential(s) this dummy RP asks for. Adjust `vct` / fields to
 * match whatever the SIGMA Issuer actually issues for the Benin PID
 * (e.g. "urn:eudi:pid:1" or the SIGMA-specific vct string) and the
 * mDoc doctype ("eu.europa.ec.eudi.pid.1") for the parallel format.
 */
function buildPresentationDefinition(sessionId) {
  return {
    id: `pid-request-${sessionId}`,
    input_descriptors: [
      {
        id: 'eu.europa.ec.eudi.pid.1',
        name: 'Benin PID (PoC)',
        purpose: 'Demonstrate OpenID4VP presentation of the national PID for the Benin ASIN PoC',
        format: {
          'vc+sd-jwt': { 'sd-jwt_alg_values': ['ES256'] },
          mso_mdoc: { alg: ['ES256'] }
        },
        constraints: {
          limit_disclosure: 'required',
          fields: [
            { path: ['$.given_name', "$['eu.europa.ec.eudi.pid.1']['given_name']"] },
            { path: ['$.family_name', "$['eu.europa.ec.eudi.pid.1']['family_name']"] },
            { path: ['$.birth_date', "$['eu.europa.ec.eudi.pid.1']['birth_date']"] }
          ]
        }
      }
    ]
  };
}

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

  const session = {
    id,
    state,
    nonce,
    createdAt: Date.now(),
    status: 'pending'
  };
  sessions.set(id, session);

  const presentationDefinition = buildPresentationDefinition(id);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'vp_token',
    response_mode: 'direct_post',
    response_uri: `${BASE_URL}/api/response`,
    nonce,
    state,
    presentation_definition: JSON.stringify(presentationDefinition)
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
app.get('/health', (req, res) => res.json({ ok: true, baseUrl: BASE_URL, clientId: CLIENT_ID }));

app.listen(PORT, () => {
  console.log(`Dummy OpenID4VP RP listening on port ${PORT}`);
  console.log(`BASE_URL=${BASE_URL}  (must be the public HTTPS URL wallets can reach)`);
  console.log(`response_uri = ${BASE_URL}/api/response`);
});
