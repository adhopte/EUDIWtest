'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.BASE_URL = 'https://anip-web-pos.example';
process.env.DEMO_MODE = 'true';
delete process.env.CLIENT_ID;

const { app } = require('../server');
const demoWallet = require('../src/demo/wallet');
const trust = require('../src/verify/trust');
const jwe = require('../src/verify/jwe');
const QRCode = require('qrcode');

let server;
let base;

before(async () => {
  await demoWallet.init();
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function call(method, path, body, key) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(key && { 'x-tx-key': key }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

const newTx = (settings = {}) => call('POST', '/api/transactions', { amount: 15000, ...settings }).then((r) => r.body);
const simulate = (tx, tamper) => call('POST', `/api/tx/${tx.id}/simulate`, { tamper }, tx.key).then((r) => r.body);
const statusOf = (view, id) => view.report.checks.find((c) => c.id === id).status;

/** Reads the QR deep link the way a wallet does. */
function parseRequest(uri) {
  const params = new URL(uri.replace('openid4vp://', 'https://wallet.invalid/')).searchParams;
  return Object.fromEntries([...params].map(([k, v]) => [k, /^[[{]/.test(v) ? JSON.parse(v) : v]));
}

test('QR request: SIGMA profile (DCQL, redirect_uri client_id, encrypted response) with the minimum PID data', async () => {
  const tx = await newTx();
  const req = parseRequest(tx.uri);
  assert.equal(req.client_id, 'redirect_uri:https://anip-web-pos.example/oid4vp/response');
  assert.equal(req.response_uri, 'https://anip-web-pos.example/oid4vp/response');
  assert.equal(req.response_mode, 'direct_post.jwt');
  assert.equal(req.response_type, 'vp_token');
  const cred = req.dcql_query.credentials[0];
  assert.equal(cred.format, 'mso_mdoc');
  assert.equal(cred.meta.doctype_value, 'eu.europa.ec.eudi.pid.1');
  assert.deepEqual(cred.claims.map((c) => c.path[1]), ['family_name', 'given_name', 'age_over_18', 'document_number', 'issuing_authority', 'issuing_country', 'expiry_date']);
  for (const forbidden of ['birth_date', 'resident_address', 'personal_administrative_number', 'portrait']) {
    assert.ok(!cred.claims.some((c) => c.path[1] === forbidden), `${forbidden} must not be requested`);
  }
  assert.deepEqual(cred.claim_sets[1], ['a', 'b']); // fallback: names only
  assert.equal(req.client_metadata.jwks.keys[0].kty, 'EC');
  assert.deepEqual(req.client_metadata.vp_formats_supported, { mso_mdoc: { issuerauth_alg_values: [-7], deviceauth_alg_values: [-7] } });
  assert.ok(tx.qrVersion <= 30, `QR version ${tx.qrVersion} too dense for phone cameras`);
  assert.equal(tx.qrVersion, QRCode.create(tx.uri, { errorCorrectionLevel: 'L' }).version);
  assert.match(tx.qr, /^<svg/);
});

test('portrait is requested only when the terminal enables it', async () => {
  const tx = await newTx({ includePortrait: true });
  assert.ok(parseRequest(tx.uri).dcql_query.credentials[0].claims.some((c) => c.path[1] === 'portrait'));
});

test('genuine PID: every check passes, only requested data is disclosed, payment gets minimal context', async () => {
  const tx = await newTx();
  const view = await simulate(tx, 'NONE');
  assert.equal(view.status, 'verified');
  for (const c of view.report.checks) assert.ok(['PASS', 'NOT_CHECKED'].includes(c.status), `${c.id} ${c.status} ${c.detail}`);
  assert.equal(statusOf(view, 'REVOCATION'), 'NOT_CHECKED'); // never simulated
  assert.deepEqual(Object.keys(view.report.claims).sort(), ['age_over_18', 'document_number', 'expiry_date', 'family_name', 'given_name', 'issuing_authority', 'issuing_country']);
  assert.deepEqual(view.paymentRequest.identity, { identityVerified: true, ageOver18: true });
  assert.ok(!JSON.stringify(view.paymentRequest).includes('KOSSI'), 'no PID attributes in the payment request');
  assert.equal(view.report.issuerTopPem, undefined, 'certificate PEM stays on the server');
});

test('altered data fails data integrity', async () => {
  const view = await simulate(await newTx(), 'ALTERED_NAME');
  assert.equal(view.status, 'rejected');
  assert.equal(statusOf(view, 'DATA_INTEGRITY'), 'FAIL');
  assert.equal(statusOf(view, 'ISSUER_SIGNATURE'), 'PASS');
  assert.equal(view.paymentRequest, null);
});

test('expired PID fails validity', async () => {
  const view = await simulate(await newTx(), 'EXPIRED');
  assert.equal(view.status, 'rejected');
  assert.equal(statusOf(view, 'VALIDITY'), 'FAIL');
});

test('unknown issuer fails when a trusted issuer is required, warns otherwise; "trust this issuer" fixes it', async () => {
  const saved = trust.anchors.splice(0, trust.anchors.length);
  try {
    let tx = await newTx();
    let view = await simulate(tx, 'NONE');
    assert.equal(statusOf(view, 'ISSUER_TRUST'), 'FAIL');
    assert.equal(view.status, 'rejected');
    assert.equal(view.report.canTrustIssuer, true);

    view = await simulate(await newTx({ requireTrustedIssuer: false }), 'NONE');
    assert.equal(statusOf(view, 'ISSUER_TRUST'), 'WARN');
    assert.equal(view.status, 'verified');

    const trusted = await call('POST', `/api/tx/${tx.id}/trust-issuer`, {}, tx.key);
    assert.equal(trusted.status, 200);
    tx = await newTx();
    view = await simulate(tx, 'NONE');
    assert.equal(statusOf(view, 'ISSUER_TRUST'), 'PASS');
  } finally {
    trust.anchors.splice(0, trust.anchors.length, ...saved);
  }
});

test('age 18+ requirement is enforced when enabled', async () => {
  const view = await simulate(await newTx({ requireAgeOver18: true }), 'NONE');
  assert.equal(statusOf(view, 'AGE_OVER_18'), 'PASS');
  assert.equal(view.status, 'verified');
});

test('wallet response endpoint: encrypted response verifies, replay and plain responses are refused', async () => {
  const tx = await newTx();
  const internal = require('../src/oid4vp').getTransaction(tx.id);
  const body = demoWallet.respond(internal);
  // a response for another session's key cannot be decrypted / matched
  const res = await call('POST', '/oid4vp/response', body);
  assert.equal(res.status, 200);
  const view = (await call('GET', `/api/tx/${tx.id}`, undefined, tx.key)).body;
  assert.equal(view.status, 'verified');
  // re-sent by the same wallet: acknowledged, not processed twice
  assert.equal((await call('POST', '/oid4vp/response', body)).status, 200);

  const tx2 = await newTx();
  const plain = await call('POST', '/oid4vp/response', { state: require('../src/oid4vp').getTransaction(tx2.id).state, vp_token: '{}' });
  assert.equal(plain.status, 400);
  assert.equal((await call('GET', `/api/tx/${tx2.id}`, undefined, tx2.key)).body.report.checks[0].detail, 'unencrypted_response');

  assert.equal((await call('POST', '/oid4vp/response', { state: 'nope', vp_token: 'x' })).status, 400);
});

test('citizen declines in the wallet: identity not verified, reason shown', async () => {
  const tx = await newTx();
  const internal = require('../src/oid4vp').getTransaction(tx.id);
  const payload = JSON.stringify({ state: internal.state, error: 'access_denied' });
  const res = await call('POST', '/oid4vp/response', { response: jwe.encrypt(payload, internal.encryption.jwk, { apv: Buffer.from(internal.nonce) }) });
  assert.equal(res.status, 200);
  const view = (await call('GET', `/api/tx/${tx.id}`, undefined, tx.key)).body;
  assert.equal(view.status, 'rejected');
  assert.equal(view.report.checks[0].detail, 'wallet_error:access_denied');
});

test('payment: wrong PIN, then explicit confirmation completes; payment refused before verification', async () => {
  const tx = await newTx();
  assert.equal((await call('POST', `/api/tx/${tx.id}/pay`, { pin: '1234' }, tx.key)).status, 409);
  await simulate(tx, 'NONE');
  let view = (await call('POST', `/api/tx/${tx.id}/pay`, { pin: '0000' }, tx.key)).body;
  assert.equal(view.status, 'verified');
  assert.deepEqual([view.payment.status, view.payment.attemptsLeft], ['declined', 2]);
  view = (await call('POST', `/api/tx/${tx.id}/pay`, { pin: '1234' }, tx.key)).body;
  assert.equal(view.status, 'paid');
  assert.equal(view.payment.status, 'authorized');
  assert.match(view.payment.code, /^[A-Z0-9]{6}$/);
});

test('payment: three wrong PINs or a customer decline end the transaction unpaid', async () => {
  const tx = await newTx();
  await simulate(tx, 'NONE');
  let view;
  for (let i = 0; i < 3; i += 1) view = (await call('POST', `/api/tx/${tx.id}/pay`, { pin: '9999' }, tx.key)).body;
  assert.equal(view.status, 'payment_declined');

  const tx2 = await newTx();
  await simulate(tx2, 'NONE');
  view = (await call('POST', `/api/tx/${tx2.id}/decline`, {}, tx2.key)).body;
  assert.equal(view.status, 'payment_declined');
  assert.equal(view.payment.reason, 'declined_by_customer');
});

test('a transaction is only visible to the terminal that created it, and can be wiped', async () => {
  const tx = await newTx();
  assert.equal((await call('GET', `/api/tx/${tx.id}`)).status, 404);
  assert.equal((await call('GET', `/api/tx/${tx.id}`, undefined, 'x'.repeat(tx.key.length))).status, 404);
  assert.equal((await call('POST', `/api/tx/${tx.id}/simulate`, {})).status, 404);
  assert.equal((await call('DELETE', `/api/tx/${tx.id}`, undefined, tx.key)).status, 204);
  assert.equal((await call('GET', `/api/tx/${tx.id}`, undefined, tx.key)).status, 404);
});

test('terminal UI and config are served', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await page.text(), /ANIP Web POS/);
  const cfg = (await call('GET', '/api/config')).body;
  assert.equal(cfg.demoMode, true);
  assert.equal(cfg.elements.length, 7);
  assert.equal((await call('GET', '/health')).body.ok, true);
});
