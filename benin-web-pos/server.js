'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');

const config = require('./src/config');
const profile = require('./src/profile');
const oid4vp = require('./src/oid4vp');
const trust = require('./src/verify/trust');
const { buildReport } = require('./src/report');
const { SimulatedPaymentGateway } = require('./src/payment');
const demoWallet = require('./src/demo/wallet');

// Replace with a real acquirer / mobile-money gateway (same interface) in production.
const gateway = new SimulatedPaymentGateway({ pin: config.DEMO_PIN, maxAttempts: config.PIN_ATTEMPTS });

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: 'index.html' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

/* -------------------------------------------------------------- helpers */

const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

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

/** The terminal tab that created a transaction proves it with X-Tx-Key. */
function txForTerminal(req) {
  const tx = oid4vp.getTransaction(req.params.id);
  const key = req.get('x-tx-key') || '';
  if (!tx || key.length !== tx.key.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(tx.key))) return null;
  return tx;
}

/** Called once the wallet's response is verified (or rejected). */
function onWalletResponse(tx, outcome) {
  tx.report = buildReport(outcome, tx.pos.policy);
  tx.status = tx.report.verified ? 'verified' : 'rejected';
  if (tx.report.verified) {
    // FR-09: hand-off to the payment layer with the minimum identity context only
    tx.paymentRequest = {
      reference: `TX-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      merchantName: tx.pos.merchant,
      amount: tx.pos.amount,
      currency: tx.pos.currency,
      identity: { identityVerified: true, ageOver18: tx.report.ageOver18 }
    };
  }
}

function view(tx) {
  const { issuerTopPem, ...report } = tx.report || {};
  return {
    id: tx.id,
    status: tx.status,
    walletStep: tx.walletStep,
    pos: tx.pos,
    durationMs: tx.responseAt ? tx.responseAt - tx.createdAt : null,
    report: tx.report ? { ...report, canTrustIssuer: config.DEMO_MODE && !report.issuerTrusted && Boolean(issuerTopPem) } : null,
    paymentRequest: tx.paymentRequest || null,
    payment: tx.payment || null
  };
}

/* ------------------------------------------------------------------ API */

app.get('/health', (req, res) => res.json({ ok: true, baseUrl: config.BASE_URL, responseUri: config.RESPONSE_URI, requestMode: config.REQUEST_MODE, responseMode: config.RESPONSE_MODE }));

app.get('/api/config', (req, res) => {
  res.json({
    demoMode: config.DEMO_MODE,
    demoPin: config.DEMO_MODE ? config.DEMO_PIN : null,
    pinAttempts: config.PIN_ATTEMPTS,
    paymentProvider: gateway.displayName,
    requestMode: config.REQUEST_MODE,
    responseMode: config.RESPONSE_MODE,
    clientId: config.CLIENT_ID,
    elements: profile.ELEMENTS,
    portrait: profile.PORTRAIT,
    trustAnchors: trust.anchors.map((a) => ({ label: a.label, subject: a.cert.subject.replace(/\n/g, ', '), validTo: a.cert.validTo }))
  });
});

// New sale: create the OpenID4VP transaction and its QR code
app.post('/api/transactions', async (req, res, next) => {
  try {
    const tx = oid4vp.createTransaction(posFromBody(req.body));
    const uri = oid4vp.authorizationRequestUri(tx);
    const qr = await QRCode.toString(uri, { type: 'svg', margin: 2, errorCorrectionLevel: 'L' });
    res.json({ id: tx.id, key: tx.key, uri, qr, qrVersion: QRCode.create(uri, { errorCorrectionLevel: 'L' }).version, transaction: view(tx) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/tx/:id', (req, res) => {
  const tx = txForTerminal(req);
  if (!tx) return res.status(404).json({ status: 'expired' });
  res.json(view(tx));
});

// "New transaction": forget the citizen's data right away instead of waiting for the TTL
app.delete('/api/tx/:id', (req, res) => {
  const tx = txForTerminal(req);
  if (tx) oid4vp.deleteTransaction(tx.id);
  res.status(204).end();
});

// Demo without a phone: the simulated wallet answers through the real response endpoint logic
app.post('/api/tx/:id/simulate', async (req, res, next) => {
  if (!config.DEMO_MODE) return res.status(404).end();
  const tx = txForTerminal(req);
  if (!tx) return res.status(404).json({ status: 'expired' });
  try {
    const tamper = demoWallet.TAMPER.includes(req.body && req.body.tamper) ? req.body.tamper : 'NONE';
    await oid4vp.handleWalletResponse(demoWallet.respond(tx, { tamper }), onWalletResponse);
    res.json(view(tx));
  } catch (err) {
    next(err);
  }
});

// Demo only: trust the issuer certificate presented in this transaction (trust on first use)
app.post('/api/tx/:id/trust-issuer', (req, res) => {
  if (!config.DEMO_MODE) return res.status(404).end();
  const tx = txForTerminal(req);
  if (!tx || !tx.report || !tx.report.issuerTopPem) return res.status(404).json({ ok: false });
  const cert = new crypto.X509Certificate(tx.report.issuerTopPem);
  trust.addAnchor(cert, 'Trusted on first use (demo)');
  console.log(`[trust] demo anchor added: ${cert.subject.replace(/\n/g, ', ')}`);
  res.json({ ok: true, subject: cert.subject.replace(/\n/g, ', ') });
});

// FR-10: the customer confirms the payment explicitly (PIN)
app.post('/api/tx/:id/pay', async (req, res, next) => {
  const tx = txForTerminal(req);
  if (!tx) return res.status(404).json({ status: 'expired' });
  if (tx.status !== 'verified' || !tx.paymentRequest) return res.status(409).json({ error: 'identity_not_verified' });
  if (tx.paying) return res.status(409).json({ error: 'in_progress' });
  try {
    tx.paying = true;
    const result = await gateway.authorize(tx.paymentRequest, { pin: String((req.body && req.body.pin) || '') });
    tx.payment = result;
    if (result.status === 'authorized') tx.status = 'paid';
    else if (!(result.attemptsLeft > 0)) tx.status = 'payment_declined';
    res.json(view(tx));
  } catch (err) {
    next(err);
  } finally {
    tx.paying = false;
  }
});

app.post('/api/tx/:id/decline', (req, res) => {
  const tx = txForTerminal(req);
  if (!tx) return res.status(404).json({ status: 'expired' });
  if (tx.status !== 'verified') return res.status(409).json({ error: 'not_payable' });
  tx.payment = { status: 'declined', reason: 'declined_by_customer', attemptsLeft: 0 };
  tx.status = 'payment_declined';
  res.json(view(tx));
});

/* ------------------------------------------------------ wallet endpoints */

app.use('/oid4vp', (req, res, next) => {
  res.on('finish', () => console.log(`[wallet] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${req.get('user-agent') || 'no user-agent'})`));
  next();
});

// request_uri (REQUEST_MODE=reference)
app.all('/oid4vp/request/:id', (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).end();
  const tx = oid4vp.getTransaction(req.params.id);
  if (!tx || tx.status !== 'pending') return res.status(404).end();
  tx.walletStep = 'request_fetched';
  res.type('application/oauth-authz-req+jwt').send(oid4vp.requestObject(tx));
});

// response_uri: the wallet POSTs the (encrypted) vp_token here
app.post('/oid4vp/response', async (req, res, next) => {
  try {
    const { status, body } = await oid4vp.handleWalletResponse(req.body || {}, onWalletResponse);
    console.log(`[wallet] response -> ${status} ${JSON.stringify(body.error ? body : oid4vp.summaryFor(req.body || {}))}`);
    res.status(status).json(body);
  } catch (err) {
    next(err);
  }
});

/* --------------------------------------------------------------- errors */

app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
// Single-page app: every other GET serves the terminal UI
app.get(/^\/(?!api\/|oid4vp\/).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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
  return app.listen(config.PORT, () => {
    console.log(`ANIP web POS listening on port ${config.PORT}`);
    console.log(`BASE_URL=${config.BASE_URL}  client_id=${config.CLIENT_ID}  request=${config.REQUEST_MODE}  response_mode=${config.RESPONSE_MODE}`);
  });
}

if (require.main === module) start();

module.exports = { app, start, onWalletResponse };
