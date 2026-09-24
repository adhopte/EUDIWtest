'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const QRCode = require('qrcode');

const config = require('./src/config');
const i18n = require('./src/i18n');
const oid4vp = require('./src/oid4vp');
const dashboardData = require('./src/dashboard-data');
const { RELYING_PARTIES } = require('./src/rulebook');
const demoWallet = require('./src/demo/wallet');

const BRANDS = {
  bedc: {
    id: 'bedc',
    name: 'BEDC Electricity PLC',
    logo: '/brand/bedc-logo.png',
    icon: '/brand/bedc-icon.png',
    css: '/css/bedc.css',
    credentialKey: 'portal.bedc.credential',
    nav: ['home', 'account', 'pay', 'outages', 'support']
  },
  fda: {
    id: 'fda',
    name: 'FDA Benin',
    logo: '/brand/fda-logo.jpg',
    icon: '/brand/fda-icon.svg',
    css: '/css/fda.css',
    credentialKey: 'portal.fda.credential',
    nav: ['home', 'regulations', 'guidelines', 'services', 'contact']
  }
};

const secureCookies = config.BASE_URL.startsWith('https://');
const cookieOpts = (maxAge) => ({ httpOnly: true, signed: true, sameSite: 'lax', secure: secureCookies, maxAge });

// Signed-in users, per relying party. In-memory for the PoC.
const logins = new Map();

const app = express();
app.set('trust proxy', true);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY'
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(cookieParser(config.SESSION_SECRET));
app.use(i18n.middleware);

app.locals.formatClaim = formatClaim;
app.locals.formatDate = formatDate;
app.locals.formatMoney = (amount, lang) => `${new Intl.NumberFormat(lang === 'fr' ? 'fr-FR' : 'en-GB').format(amount)} FCFA`;
app.locals.pick = (value, lang) => (value && typeof value === 'object' ? value[lang] : value);
app.locals.config = config;

function formatDate(value, lang, opts = { day: 'numeric', month: 'long', year: 'numeric' }) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-GB', { timeZone: 'UTC', ...opts });
}

function formatClaim(name, value, t, lang) {
  if (value === undefined || value === null) return '—';
  if (name === 'gender') return t(`gender.${value}`);
  if (/_date$/.test(name) && typeof value === 'string') return formatDate(value, lang);
  if (typeof value === 'boolean') return value ? '✓' : '✗';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return value.bytes ? `[${Math.round((value.bytes.length * 3) / 4)} bytes]` : JSON.stringify(value);
  return String(value);
}

/** Requested claims first, in the order the relying party asked for them. */
function orderClaims(claims, order) {
  const keys = Object.keys(claims).sort((a, b) => {
    const ia = order.indexOf(a) === -1 ? order.length : order.indexOf(a);
    const ib = order.indexOf(b) === -1 ? order.length : order.indexOf(b);
    return ia - ib;
  });
  return Object.fromEntries(keys.map((k) => [k, claims[k]]));
}

function currentLogin(req, rpId) {
  const sid = req.signedCookies[`sid_${rpId}`];
  const login = sid && logins.get(sid);
  if (!login || login.rpId !== rpId || Date.now() - login.at > config.LOGIN_TTL_MS) return null;
  return login;
}

function requireRp(req, res, next) {
  if (!BRANDS[req.params.rp]) return next('route');
  req.rp = RELYING_PARTIES[req.params.rp];
  res.locals.brand = BRANDS[req.params.rp];
  res.locals.rp = req.rp;
  next();
}

/* ------------------------------------------------------------ portal */

app.get('/', (req, res) => res.render('portal', { brands: BRANDS }));

app.get('/health', (req, res) => res.json({ ok: true, baseUrl: config.BASE_URL, responseUri: oid4vp.RESPONSE_URI, queryLanguage: config.QUERY_LANGUAGE }));

/* -------------------------------------------------------- OpenID4VP */

app.post('/api/:rp/transactions', requireRp, async (req, res, next) => {
  try {
    const variant = oid4vp.VARIANTS[req.query.variant] ? req.query.variant : 'configured';
    const tx = oid4vp.createTransaction(req.rp.id, variant);
    const { uri } = oid4vp.authorizationRequest(tx);
    const qr = await QRCode.toDataURL(uri, { margin: 2, width: uri.length > 600 ? 720 : 360, errorCorrectionLevel: 'L' });
    res.cookie(`tx_${tx.id}`, tx.browserKey, cookieOpts(config.TX_TTL_MS));
    res.json({ id: tx.id, uri, qr, variant, env: oid4vp.VARIANTS[variant].env() });
  } catch (err) {
    next(err);
  }
});

function txForBrowser(req) {
  const tx = oid4vp.getTransaction(req.params.id);
  if (!tx || req.signedCookies[`tx_${tx.id}`] !== tx.browserKey) return null;
  return tx;
}

app.get('/api/tx/:id', (req, res) => {
  const tx = txForBrowser(req);
  if (!tx) return res.status(404).json({ status: 'expired' });
  res.json({ status: tx.status, reasons: tx.reasons || [], walletStep: tx.walletStep || null });
});

app.post('/api/tx/:id/simulate', async (req, res, next) => {
  if (!config.DEMO_MODE) return res.status(404).end();
  const tx = txForBrowser(req);
  if (!tx) return res.status(404).json({ status: 'expired' });
  try {
    await oid4vp.handleWalletResponse(demoWallet.respond(tx, RELYING_PARTIES[tx.rpId]));
    res.json({ status: tx.status, reasons: tx.reasons || [] });
  } catch (err) {
    next(err);
  }
});

// Log every wallet-facing call so a failing wallet can be diagnosed from the host logs.
app.use('/oid4vp', (req, res, next) => {
  res.on('finish', () => {
    console.log(`[wallet] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${req.get('user-agent') || 'no user-agent'})`);
  });
  next();
});

// request_uri: authorization request by reference (REQUEST_MODE=reference)
app.all('/oid4vp/request/:id', (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).end();
  const tx = oid4vp.getTransaction(req.params.id);
  if (!tx || tx.status !== 'pending') return res.status(404).end();
  tx.walletStep = 'request_fetched';
  res.type('application/oauth-authz-req+jwt').send(oid4vp.requestObject(tx));
});

// response_uri: the wallet POSTs vp_token here (response_mode=direct_post)
app.post('/oid4vp/response', async (req, res, next) => {
  try {
    const { status, body } = await oid4vp.handleWalletResponse(req.body || {});
    console.log(`[wallet] response keys=${Object.keys(req.body || {}).join(',') || 'none'} -> ${status} ${JSON.stringify(body.error ? body : oid4vp.summaryFor(req.body || {}))}`);
    res.status(status).json(body);
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------- relying parties */

app.get('/:rp', requireRp, (req, res) => res.redirect(`/${req.rp.id}/${currentLogin(req, req.rp.id) ? 'dashboard' : 'login'}`));

// Wallet compatibility test: one QR code per request variant
app.get('/:rp/wallet-test', requireRp, (req, res) => {
  res.render('wallet-test', { variants: Object.keys(oid4vp.VARIANTS) });
});

app.get('/:rp/login', requireRp, (req, res) => {
  if (currentLogin(req, req.rp.id)) return res.redirect(`/${req.rp.id}/dashboard`);
  res.render('login', { error: req.query.error, reasons: [].concat(req.query.reason || []) });
});

app.get('/:rp/callback', requireRp, (req, res) => {
  const tx = oid4vp.getTransaction(req.query.tx);
  const boundToBrowser = tx && req.signedCookies[`tx_${tx.id}`] === tx.browserKey;
  const sameDevice = tx && req.query.response_code && req.query.response_code === tx.responseCode;
  if (!tx || tx.rpId !== req.rp.id || !(boundToBrowser || sameDevice)) {
    return res.redirect(`/${req.rp.id}/login?error=expired`);
  }
  if (tx.status !== 'verified') {
    const reasons = (tx.reasons || []).map((r) => `&reason=${encodeURIComponent(r)}`).join('');
    return res.redirect(`/${req.rp.id}/login?error=rejected${reasons}`);
  }

  const sid = crypto.randomBytes(24).toString('base64url');
  logins.set(sid, {
    rpId: tx.rpId,
    at: Date.now(),
    claims: orderClaims(tx.accepted.claims, req.rp.claims),
    checks: tx.accepted.checks,
    format: tx.accepted.format,
    issuer: tx.accepted.issuer,
    credentialType: tx.accepted.vct || tx.accepted.docType
  });
  tx.status = 'consumed';
  res.clearCookie(`tx_${tx.id}`);
  res.cookie(`sid_${tx.rpId}`, sid, cookieOpts(config.LOGIN_TTL_MS));
  res.redirect(`/${tx.rpId}/dashboard`);
});

app.get('/:rp/dashboard', requireRp, (req, res) => {
  const login = currentLogin(req, req.rp.id);
  if (!login) return res.redirect(`/${req.rp.id}/login?error=session`);
  const data = dashboardData[req.rp.id](login.claims);
  res.render(`${req.rp.id}-dashboard`, { login, data, claims: login.claims });
});

app.post('/:rp/logout', requireRp, (req, res) => {
  const sid = req.signedCookies[`sid_${req.rp.id}`];
  if (sid) logins.delete(sid);
  res.clearCookie(`sid_${req.rp.id}`);
  res.redirect('/');
});

/* ------------------------------------------------------------ errors */

app.use((req, res) => res.status(404).render('error', { message: res.locals.t('error.not_found') }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (req.path.startsWith('/api/') || req.path.startsWith('/oid4vp/')) {
    return res.status(500).json({ error: 'server_error' });
  }
  res.status(500).render('error', { message: err.message });
});

async function start() {
  if (config.DEMO_MODE) {
    await demoWallet.init();
    console.log('DEMO_MODE on: simulated ANIP issuer registered as a trust anchor.');
  }
  return app.listen(config.PORT, () => {
    console.log(`Benin Government eServices RP listening on port ${config.PORT}`);
    console.log(`BASE_URL=${config.BASE_URL}  response_uri=${oid4vp.RESPONSE_URI}  query=${config.QUERY_LANGUAGE}  response_mode=${config.RESPONSE_MODE}`);
  });
}

if (require.main === module) start();

module.exports = { app, start };
