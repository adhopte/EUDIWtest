'use strict';

process.env.DEMO_MODE = 'true';
process.env.PORT = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const { messages } = require('../src/i18n');

let server;
let base;

test.before(async () => {
  const { start } = require('../server');
  server = await start();
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test('English and French translations have the same keys', () => {
  assert.deepEqual(Object.keys(messages.fr).sort(), Object.keys(messages.en).sort());
});

test('portal lists both services and switches language', async () => {
  const en = await (await fetch(`${base}/`)).text();
  assert.match(en, /<html lang="en">/);
  assert.match(en, /href="\/bedc\/login"/);
  assert.match(en, /href="\/fda\/login"/);
  const fr = await (await fetch(`${base}/?lang=fr`)).text();
  assert.match(fr, /<html lang="fr">/);
  assert.match(fr, /Accéder au portail santé/);
});

test('dashboards require a verified login', async () => {
  const res = await fetch(`${base}/fda/dashboard`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /\/fda\/login/);
});

test('full demo login flow reaches the FDA dashboard', async () => {
  const create = await fetch(`${base}/api/fda/transactions`, { method: 'POST' });
  const cookie = create.headers.get('set-cookie').split(';')[0];
  const tx = await create.json();
  assert.match(tx.uri, /^openid4vp:\/\/\?/);
  assert.match(tx.qr, /^data:image\/png;base64,/);

  const sim = await (await fetch(`${base}/api/tx/${tx.id}/simulate`, { method: 'POST', headers: { cookie } })).json();
  assert.equal(sim.status, 'verified');

  const cb = await fetch(`${base}/fda/callback?tx=${tx.id}`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(cb.headers.get('location'), '/fda/dashboard');
  const sid = cb.headers.get('set-cookie').match(/sid_fda=[^;]+/)[0];

  const dash = await (await fetch(`${base}/fda/dashboard?lang=fr`, { headers: { cookie: sid } })).text();
  assert.match(dash, /Bienvenue, Angélique HOUNGBEDJI/);
});

test('the QR code uses request_uri and the wallet can fetch the request object', async () => {
  const create = await fetch(`${base}/api/bedc/transactions`, { method: 'POST' });
  const cookie = create.headers.get('set-cookie').split(';')[0];
  const tx = await create.json();
  assert.ok(tx.uri.length < 300, `QR payload too long: ${tx.uri.length}`);
  const requestUri = new URL(tx.uri.replace('openid4vp://', 'http://x/')).searchParams.get('request_uri');
  const localUri = requestUri.replace(/^https?:\/\/[^/]+/, base);
  const res = await fetch(localUri);
  assert.match(res.headers.get('content-type'), /oauth-authz-req\+jwt/);
  const payload = JSON.parse(Buffer.from((await res.text()).split('.')[1], 'base64url'));
  assert.equal(payload.response_mode, 'direct_post');
  assert.equal(payload.presentation_definition.input_descriptors[0].id, 'eu.europa.ec.eudi.pid.1');
  const status = await (await fetch(`${base}/api/tx/${tx.id}`, { headers: { cookie } })).json();
  assert.equal(status.walletStep, 'request_fetched');
});

test('wallet test page renders one card per variant in French', async () => {
  const html = await (await fetch(`${base}/fda/wallet-test?lang=fr`)).text();
  assert.match(html, /Test de compatibilité du portefeuille/);
  assert.equal((html.match(/class="card wt-card"/g) || []).length, 5);
});

test('transaction status is not visible to another browser', async () => {
  const create = await fetch(`${base}/api/bedc/transactions`, { method: 'POST' });
  const tx = await create.json();
  const res = await fetch(`${base}/api/tx/${tx.id}`);
  assert.equal(res.status, 404);
  const cb = await fetch(`${base}/bedc/callback?tx=${tx.id}`, { redirect: 'manual' });
  assert.match(cb.headers.get('location'), /error=expired/);
});
