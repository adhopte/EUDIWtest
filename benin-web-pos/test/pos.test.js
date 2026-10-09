'use strict';

/*
 * End to end: the browser reader module (public/js/mdoc-reader.js) reads the
 * simulated wallet over the ISO/IEC 18013-5 proximity protocol, then the server
 * verifies the presentation and runs the payment step.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.DEMO_MODE = 'true';

const { app } = require('../server');
const demoWallet = require('../src/demo/wallet');
const trust = require('../src/verify/trust');
const R = require('../public/js/mdoc-reader.js');

let server;
let base;
const PID = 'eu.europa.ec.eudi.pid.1';
const ELEMENTS = { family_name: false, given_name: false, age_over_18: false, document_number: false, issuing_authority: false, issuing_country: false, expiry_date: false };

before(async () => {
  await demoWallet.init();
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function call(method, path, body, key) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(key && { 'x-sale-key': key }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

/** Reads the simulated wallet like the terminal does (HTTPS stands in for BLE). */
async function readWallet({ tamper = 'NONE', deviceAuth = 'signature', elements = ELEMENTS } = {}) {
  const wallet = (await call('POST', '/api/demo/wallet', { tamper, deviceAuth })).body;
  const engagement = R.parseEngagement(wallet.qr);
  const session = await R.createSession(engagement);
  const transport = {
    identOk: null,
    exchange: async (m) => R.b64urlDecode((await call('POST', `/api/demo/wallet/${wallet.id}/message`, { message: R.b64urlEncode(m) })).body.message),
    close: async () => {}
  };
  return { engagement, read: await R.readPid({ engagement, session, transport, docType: PID, namespace: PID, elements }) };
}

async function verify(read, pos = {}) {
  return call('POST', '/api/verify', { ...read, pos: { amount: 15000, ...pos }, session: { transport: 'test' } });
}
const statusOf = (sale, id) => sale.report.checks.find((c) => c.id === id).status;

test('the simulated wallet shows a real ISO 18013-5 engagement (BLE peripheral server mode)', async () => {
  const { engagement } = await readWallet();
  assert.equal(engagement.version, '1.0');
  assert.deepEqual(engagement.methods, ['BLE']);
  assert.equal(engagement.ble.peripheralServer, true);
  assert.match(engagement.ble.peripheralServerUuid, /^[0-9a-f-]{36}$/);
  assert.equal(R.bleCompatibility(engagement), null);
});

test('genuine PID: every check passes, only the requested elements are disclosed, minimal payment context', async () => {
  const { read } = await readWallet();
  const { status, body } = await verify(read);
  assert.equal(status, 200);
  const sale = body.sale;
  assert.equal(sale.status, 'verified');
  for (const c of sale.report.checks) assert.ok(['PASS', 'NOT_CHECKED'].includes(c.status), `${c.id} ${c.status} ${c.detail}`);
  assert.match(sale.report.deviceAuth, /DeviceSignature/);
  assert.deepEqual(Object.keys(sale.report.claims).sort(), Object.keys(ELEMENTS).sort());
  assert.ok(!('birth_date' in sale.report.claims) && !('personal_administrative_number' in sale.report.claims));
  assert.deepEqual(sale.paymentRequest.identity, { identityVerified: true, ageOver18: true });
  assert.ok(!JSON.stringify(sale.paymentRequest).includes('KOSSI'), 'no PID attributes in the payment request');
  assert.equal(sale.report.issuerTopPem, undefined, 'certificate PEM stays on the server');
});

test('DeviceMac authentication (EMacKey from the reader key) is verified', async () => {
  const { read } = await readWallet({ deviceAuth: 'mac' });
  const sale = (await verify(read)).body.sale;
  assert.equal(statusOf(sale, 'DEVICE_AUTH'), 'PASS');
  assert.match(sale.report.deviceAuth, /DeviceMac/);
  // without the reader's ephemeral key the MAC cannot be checked
  const { read: read2 } = await readWallet({ deviceAuth: 'mac' });
  const sale2 = (await verify({ ...read2, readerKey: undefined })).body.sale;
  assert.equal(statusOf(sale2, 'DEVICE_AUTH'), 'FAIL');
});

test('altered data fails data integrity; expired PID fails validity', async () => {
  const altered = (await verify((await readWallet({ tamper: 'ALTERED_NAME' })).read)).body.sale;
  assert.equal(altered.status, 'rejected');
  assert.equal(statusOf(altered, 'DATA_INTEGRITY'), 'FAIL');
  assert.equal(statusOf(altered, 'ISSUER_SIGNATURE'), 'PASS');
  assert.equal(altered.paymentRequest, null);

  const expired = (await verify((await readWallet({ tamper: 'EXPIRED' })).read)).body.sale;
  assert.equal(expired.status, 'rejected');
  assert.equal(statusOf(expired, 'VALIDITY'), 'FAIL');
});

test('a presentation replayed or moved to another session is refused', async () => {
  const a = (await readWallet()).read;
  assert.equal((await verify(a)).status, 200);
  assert.equal((await verify(a)).status, 409, 'same SessionTranscript twice');

  const b = (await readWallet()).read;
  const swapped = (await verify({ ...a, sessionTranscript: b.sessionTranscript })).body.sale;
  assert.equal(statusOf(swapped, 'DEVICE_AUTH'), 'FAIL');
  assert.equal(swapped.status, 'rejected');

  assert.equal((await call('POST', '/api/verify', { deviceResponse: a.deviceResponse, sessionTranscript: 'oA' })).status, 400);
});

test('unknown issuer fails when a trusted issuer is required, warns otherwise; "trust this issuer" fixes it', async () => {
  const saved = trust.anchors.splice(0, trust.anchors.length);
  try {
    const { body } = await verify((await readWallet()).read);
    assert.equal(statusOf(body.sale, 'ISSUER_TRUST'), 'FAIL');
    assert.equal(body.sale.report.canTrustIssuer, true);

    const relaxed = (await verify((await readWallet()).read, { requireTrustedIssuer: false })).body.sale;
    assert.equal(statusOf(relaxed, 'ISSUER_TRUST'), 'WARN');
    assert.equal(relaxed.status, 'verified');

    assert.equal((await call('POST', `/api/sale/${body.id}/trust-issuer`, {}, body.key)).status, 200);
    const again = (await verify((await readWallet()).read)).body.sale;
    assert.equal(statusOf(again, 'ISSUER_TRUST'), 'PASS');
  } finally {
    trust.anchors.splice(0, trust.anchors.length, ...saved);
  }
});

test('age 18+ requirement: enforced when enabled, missing age fails', async () => {
  const ok = (await verify((await readWallet()).read, { requireAgeOver18: true })).body.sale;
  assert.equal(statusOf(ok, 'AGE_OVER_18'), 'PASS');
  const { family_name, given_name } = ELEMENTS;
  const noAge = (await verify((await readWallet({ elements: { family_name, given_name } })).read, { requireAgeOver18: true })).body.sale;
  assert.equal(statusOf(noAge, 'AGE_OVER_18'), 'FAIL');
});

test('payment: wrong PIN, then explicit confirmation completes; refused before verification', async () => {
  const rejected = (await verify((await readWallet({ tamper: 'EXPIRED' })).read)).body;
  assert.equal((await call('POST', `/api/sale/${rejected.id}/pay`, { pin: '1234' }, rejected.key)).status, 409);

  const { id, key } = (await verify((await readWallet()).read)).body;
  let sale = (await call('POST', `/api/sale/${id}/pay`, { pin: '0000' }, key)).body;
  assert.equal(sale.status, 'verified');
  assert.deepEqual([sale.payment.status, sale.payment.attemptsLeft], ['declined', 2]);
  sale = (await call('POST', `/api/sale/${id}/pay`, { pin: '1234' }, key)).body;
  assert.equal(sale.status, 'paid');
  assert.match(sale.payment.code, /^[A-Z0-9]{6}$/);
});

test('payment: three wrong PINs or a customer decline end the sale unpaid', async () => {
  const s1 = (await verify((await readWallet()).read)).body;
  let sale;
  for (let i = 0; i < 3; i += 1) sale = (await call('POST', `/api/sale/${s1.id}/pay`, { pin: '9999' }, s1.key)).body;
  assert.equal(sale.status, 'payment_declined');

  const s2 = (await verify((await readWallet()).read)).body;
  sale = (await call('POST', `/api/sale/${s2.id}/decline`, {}, s2.key)).body;
  assert.equal(sale.status, 'payment_declined');
  assert.equal(sale.payment.reason, 'declined_by_customer');
});

test('a sale is only visible to the terminal that created it, and can be wiped', async () => {
  const { id, key } = (await verify((await readWallet()).read)).body;
  assert.equal((await call('GET', `/api/sale/${id}`)).status, 404);
  assert.equal((await call('GET', `/api/sale/${id}`, undefined, 'x'.repeat(key.length))).status, 404);
  assert.equal((await call('DELETE', `/api/sale/${id}`, undefined, key)).status, 204);
  assert.equal((await call('GET', `/api/sale/${id}`, undefined, key)).status, 404);
});

test('a simulated wallet answers one session only', async () => {
  const wallet = (await call('POST', '/api/demo/wallet', {})).body;
  const engagement = R.parseEngagement(wallet.qr);
  const session = await R.createSession(engagement);
  const msg = await session.establishment(R.deviceRequest(PID, PID, ELEMENTS));
  assert.equal((await call('POST', `/api/demo/wallet/${wallet.id}/message`, { message: R.b64urlEncode(msg) })).status, 200);
  assert.equal((await call('POST', `/api/demo/wallet/${wallet.id}/message`, { message: R.b64urlEncode(msg) })).status, 404);
});

test('terminal UI, reader scripts and config are served with the camera permission', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(page.headers.get('permissions-policy'), /camera=\(self\)/);
  const html = await page.text();
  for (const src of ['/js/cbor.js', '/js/mdoc-reader.js', '/vendor/jsQR.js', '/js/app.js']) {
    assert.ok(html.includes(src), src);
    assert.equal((await fetch(base + src)).status, 200, src);
  }
  const cfg = (await call('GET', '/api/config')).body;
  assert.equal(cfg.docType, PID);
  assert.equal(cfg.elements.length, 7);
  assert.equal(cfg.bleChunkSize, 20);
  assert.match((await call('GET', '/health')).body.flow, /18013-5/);
});
