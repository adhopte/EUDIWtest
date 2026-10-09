'use strict';

/*
 * ANIP web POS — server.
 *
 * The browser terminal is the ISO/IEC 18013-5 mdoc reader: it scans the wallet's
 * engagement QR code, talks to the wallet over Bluetooth (Web Bluetooth) with
 * session encryption, and decrypts the DeviceResponse. It then posts the
 * DeviceResponse and the SessionTranscript here, and this server verifies the
 * PID (issuer signature, trust, digests, validity, DeviceAuth over the
 * SessionTranscript) and runs the payment step.
 */

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { decode, Tag } = require('cbor-x');

const config = require('./src/config');
const profile = require('./src/profile');
const trust = require('./src/verify/trust');
const { verifyDeviceResponse } = require('./src/verify/mdoc');
const { buildReport } = require('./src/report');
const { SimulatedPaymentGateway } = require('./src/payment');
const demoWallet = require('./src/demo/wallet');

// Replace with a real acquirer / mobile-money gateway (same interface) in production.
const gateway = new SimulatedPaymentGateway({ pin: config.DEMO_PIN, maxAttempts: config.PIN_ATTEMPTS });

/* ---------------------------------------------------------------- state */

const sales = new Map(); // verified (or rejected) presentations and their payment
const seenTranscripts = new Map(); // SessionTranscript hash → time (replay protection)
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sales) if (now - s.createdAt > config.TX_TTL_MS) sales.delete(id);
  for (const [h, at] of seenTranscripts) if (now - at > 24 * 3600 * 1000) seenTranscripts.delete(h);
}, 60 * 1000).unref();

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    // camera (wallet QR code) for this page only; Web Bluetooth is same-origin by default
    'Permissions-Policy': 'camera=(self), geolocation=(), microphone=()',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: 'index.html' }));
app.get('/vendor/jsQR.js', (req, res) => res.sendFile(require.resolve('jsqr/dist/jsQR.js')));
app.use(express.json({ limit: '2mb' }));

/* -------------------------------------------------------------- helpers */

const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const b64u = (s) => Buffer.from(String(s || ''), 'base64url');

function posFromBody(body = {}) {
  const amount = Number(body.amount);
  return {
    merchant: String(body.merchant || 'Supermarché Étoile — Cotonou').slice(0, 80),
    amount: Number.isInteger(amount) && amount > 0 && amount <= 1e9 ? amount : 15000,
    currency: /^[A-Z]{3}$/.test(body.currency || '') ? body.currency : 'XOF',
    policy: {
      requireTrustedIssuer: bool(body.requireTrustedIssuer, true),
      requireAgeOver18: bool(body.requireAgeOver18, false),
      includePortrait: bool(body.includePortrait, false)
    }
  };
}

/** The terminal tab that created a sale proves it with X-Sale-Key. */
function saleForTerminal(req) {
  const sale = sales.get(req.params.id);
  const key = req.get('x-sale-key') || '';
  if (!sale || key.length !== sale.key.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(sale.key))) return null;
  return sale;
}

/**
 * Checks the SessionTranscript shape for the QR engagement:
 * [DeviceEngagementBytes, EReaderKeyBytes, null]. Returns the EReaderKey COSE map.
 */
function parseTranscript(bytes) {
  const st = decode(bytes);
  if (!Array.isArray(st) || st.length !== 3 || !(st[0] instanceof Tag) || !(st[1] instanceof Tag) || st[2] !== null) {
    throw new Error('session_transcript_not_qr_handover');
  }
  return decode(st[1].value);
}

/** Reader's ephemeral private key (only for DeviceMac), if it matches the transcript. */
function readerPrivateKey(jwk, eReaderKey) {
  if (!jwk || typeof jwk !== 'object') return null;
  try {
    const get = (m, k) => (m instanceof Map ? m.get(k) : m[k]);
    const x = Buffer.from(get(eReaderKey, -2)).toString('base64url');
    const y = Buffer.from(get(eReaderKey, -3)).toString('base64url');
    if (jwk.x !== x || jwk.y !== y) return null;
    return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, format: 'jwk' });
  } catch (_) {
    return null;
  }
}

function view(sale) {
  const { issuerTopPem, ...report } = sale.report;
  return {
    id: sale.id,
    status: sale.status,
    pos: sale.pos,
    session: sale.session,
    report: { ...report, canTrustIssuer: config.DEMO_MODE && !report.issuerTrusted && Boolean(issuerTopPem) },
    paymentRequest: sale.paymentRequest || null,
    payment: sale.payment || null
  };
}

/* ------------------------------------------------------------------ API */

app.get('/health', (req, res) => res.json({ ok: true, flow: 'ISO/IEC 18013-5 proximity (QR engagement + BLE)', demoMode: config.DEMO_MODE }));

app.get('/api/config', (req, res) => {
  res.json({
    demoMode: config.DEMO_MODE,
    demoPin: config.DEMO_MODE ? config.DEMO_PIN : null,
    pinAttempts: config.PIN_ATTEMPTS,
    paymentProvider: gateway.displayName,
    docType: profile.PID.docType,
    namespace: profile.PID.namespace,
    elements: profile.ELEMENTS,
    portrait: profile.PORTRAIT,
    bleChunkSize: config.BLE_CHUNK_SIZE,
    trustAnchors: trust.anchors.map((a) => ({ label: a.label, subject: a.cert.subject.replace(/\n/g, ', '), validTo: a.cert.validTo }))
  });
});

/**
 * The terminal posts what it read from the wallet. The server verifies it and
 * opens a sale for the payment step.
 */
app.post('/api/verify', async (req, res, next) => {
  try {
    const body = req.body || {};
    const pos = posFromBody(body.pos);
    const stBytes = b64u(body.sessionTranscript);
    let eReaderKey;
    try {
      eReaderKey = parseTranscript(stBytes);
    } catch (err) {
      return res.status(400).json({ error: 'invalid_session_transcript', detail: err.message });
    }
    // A SessionTranscript holds a fresh EReaderKey: the same one twice is a replay.
    const stHash = crypto.createHash('sha256').update(stBytes).digest('hex');
    if (seenTranscripts.has(stHash)) return res.status(409).json({ error: 'replayed_session' });
    seenTranscripts.set(stHash, Date.now());

    const results = body.walletError
      ? null
      : await verifyDeviceResponse(String(body.deviceResponse || ''), {
        docType: profile.PID.docType,
        namespace: profile.PID.namespace,
        sessionTranscriptBytes: stBytes,
        readerPrivateKey: readerPrivateKey(body.readerKey, eReaderKey)
      });
    const report = buildReport(body.walletError ? { walletError: String(body.walletError).slice(0, 80) } : { results }, pos.policy);
    const sale = {
      id: crypto.randomUUID(),
      key: crypto.randomBytes(24).toString('base64url'),
      createdAt: Date.now(),
      pos,
      report,
      status: report.verified ? 'verified' : 'rejected',
      session: {
        engagement: 'QR code (ISO/IEC 18013-5)',
        transport: String((body.session && body.session.transport) || 'BLE').slice(0, 80),
        bleIdent: body.session && typeof body.session.bleIdent === 'boolean' ? body.session.bleIdent : null,
        durationMs: body.session && Number.isFinite(body.session.durationMs) ? body.session.durationMs : null
      }
    };
    if (report.verified) {
      // FR-09: hand-off to the payment layer with the minimum identity context only
      sale.paymentRequest = {
        reference: `TX-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
        merchantName: pos.merchant,
        amount: pos.amount,
        currency: pos.currency,
        identity: { identityVerified: true, ageOver18: report.ageOver18 }
      };
    }
    sales.set(sale.id, sale);
    console.log(`[verify] ${sale.status} via ${sale.session.transport}: ${report.checks.map((c) => `${c.id}=${c.status}`).join(' ')}`);
    res.json({ id: sale.id, key: sale.key, sale: view(sale) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/sale/:id', (req, res) => {
  const sale = saleForTerminal(req);
  if (!sale) return res.status(404).json({ status: 'expired' });
  res.json(view(sale));
});

// "New transaction": forget the citizen's data right away instead of waiting for the TTL
app.delete('/api/sale/:id', (req, res) => {
  if (saleForTerminal(req)) sales.delete(req.params.id);
  res.status(204).end();
});

// Demo only: trust the issuer certificate presented in this sale (trust on first use)
app.post('/api/sale/:id/trust-issuer', (req, res) => {
  if (!config.DEMO_MODE) return res.status(404).end();
  const sale = saleForTerminal(req);
  if (!sale || !sale.report.issuerTopPem) return res.status(404).json({ ok: false });
  const cert = new crypto.X509Certificate(sale.report.issuerTopPem);
  trust.addAnchor(cert, 'Trusted on first use (demo)');
  console.log(`[trust] demo anchor added: ${cert.subject.replace(/\n/g, ', ')}`);
  res.json({ ok: true });
});

// FR-10: the customer confirms the payment explicitly (PIN)
app.post('/api/sale/:id/pay', async (req, res, next) => {
  const sale = saleForTerminal(req);
  if (!sale) return res.status(404).json({ status: 'expired' });
  if (sale.status !== 'verified' || !sale.paymentRequest) return res.status(409).json({ error: 'identity_not_verified' });
  if (sale.paying) return res.status(409).json({ error: 'in_progress' });
  try {
    sale.paying = true;
    const result = await gateway.authorize(sale.paymentRequest, { pin: String((req.body && req.body.pin) || '') });
    sale.payment = result;
    if (result.status === 'authorized') sale.status = 'paid';
    else if (!(result.attemptsLeft > 0)) sale.status = 'payment_declined';
    res.json(view(sale));
  } catch (err) {
    next(err);
  } finally {
    sale.paying = false;
  }
});

app.post('/api/sale/:id/decline', (req, res) => {
  const sale = saleForTerminal(req);
  if (!sale) return res.status(404).json({ status: 'expired' });
  if (sale.status !== 'verified') return res.status(409).json({ error: 'not_payable' });
  sale.payment = { status: 'declined', reason: 'declined_by_customer', attemptsLeft: 0 };
  sale.status = 'payment_declined';
  res.json(view(sale));
});

/* ------------------------------------------------ demo wallet (no phone) */

// A simulated wallet shows its engagement QR code…
app.post('/api/demo/wallet', (req, res) => {
  if (!config.DEMO_MODE) return res.status(404).end();
  const { tamper, deviceAuth } = req.body || {};
  res.json(demoWallet.createDevice({ tamper, deviceAuth: deviceAuth === 'mac' ? 'mac' : 'signature' }));
});

// …and answers the reader's SessionEstablishment (HTTPS stands in for BLE).
app.post('/api/demo/wallet/:id/message', async (req, res, next) => {
  if (!config.DEMO_MODE) return res.status(404).end();
  try {
    await new Promise((r) => setTimeout(r, 600)); // the citizen taps "Share" in the wallet
    const reply = demoWallet.handleMessage(req.params.id, b64u(req.body && req.body.message));
    res.json({ message: Buffer.from(reply).toString('base64url') });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
});

/* --------------------------------------------------------------- errors */

app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
// Single-page app: every other GET serves the terminal UI
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

async function start() {
  if (config.DEMO_MODE) {
    await demoWallet.init();
    console.log('DEMO_MODE on: simulated ANIP issuer registered as a trust anchor.');
  }
  return app.listen(config.PORT, () => console.log(`ANIP web POS (ISO 18013-5 proximity reader) listening on port ${config.PORT}`));
}

if (require.main === module) start();

module.exports = { app, start };
