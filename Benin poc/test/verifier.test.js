'use strict';

process.env.DEMO_MODE = 'true';
process.env.BASE_URL = 'http://localhost:0';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decode, Tag } = require('cbor-x');

const config = require('../src/config');
const oid4vp = require('../src/oid4vp');
const wallet = require('../src/demo/wallet');
const { encode } = require('../src/verify/mdoc');
const { RELYING_PARTIES, PID } = require('../src/rulebook');

test.before(() => wallet.init());

function pidFor(tx, extra = {}) {
  return wallet.presentPidMdoc({ requested: RELYING_PARTIES.bedc.claims, clientId: tx.clientId, nonce: tx.nonce, responseUri: tx.responseUri, ...extra });
}

function birthCertFor(tx, extra = {}) {
  return wallet.presentBirthCertificateSdJwt({ requested: RELYING_PARTIES.fda.claims, clientId: tx.clientId, nonce: tx.nonce, ...extra });
}

test('BEDC accepts a valid PID mdoc and discloses only requested elements', async () => {
  const tx = oid4vp.createTransaction('bedc');
  const res = await oid4vp.handleWalletResponse({ state: tx.state, vp_token: pidFor(tx) });
  assert.equal(res.status, 200);
  assert.match(res.body.redirect_uri, /\/bedc\/callback\?tx=/);
  assert.equal(tx.status, 'verified', JSON.stringify(tx.reasons));
  const { claims, checks } = tx.accepted;
  assert.equal(claims.family_name, 'KOSSI');
  assert.equal(claims.birth_date, '1988-04-12');
  assert.deepEqual(claims.nationality, ['BJ']);
  assert.equal(claims.issuing_country, 'BJ');
  assert.equal(claims.personal_administrative_number, undefined, 'NPI must not be disclosed');
  assert.equal(claims.portrait, undefined);
  for (const name of ['credentialType', 'issuerSignature', 'trustedIssuer', 'disclosures', 'validity', 'holderBinding']) {
    assert.ok(checks[name].ok, `${name}: ${checks[name].detail}`);
  }
});

test('FDA accepts a valid Birth Certificate SD-JWT with key binding', async () => {
  const tx = oid4vp.createTransaction('fda');
  await oid4vp.handleWalletResponse({ state: tx.state, vp_token: birthCertFor(tx) });
  assert.equal(tx.status, 'verified', JSON.stringify(tx.reasons));
  const { claims, checks } = tx.accepted;
  assert.equal(claims.birth_record_reference, 'BJ-PN-1995-004518');
  assert.equal(claims.given_name, 'Angélique');
  assert.equal(claims.mother_family_name, undefined, 'filiation data must not be disclosed');
  assert.ok(checks.holderBinding.ok, checks.holderBinding.detail);
  assert.ok(checks.trustedIssuer.ok, checks.trustedIssuer.detail);
});

test('DCQL-shaped vp_token objects are accepted', async () => {
  const tx = oid4vp.createTransaction('fda');
  const vpToken = JSON.stringify({ birth_certificate: [birthCertFor(tx)] });
  await oid4vp.handleWalletResponse({ state: tx.state, vp_token: vpToken });
  assert.equal(tx.status, 'verified', JSON.stringify(tx.reasons));
});

test('a state can only be used once', async () => {
  const tx = oid4vp.createTransaction('fda');
  await oid4vp.handleWalletResponse({ state: tx.state, vp_token: birthCertFor(tx) });
  const replay = await oid4vp.handleWalletResponse({ state: tx.state, vp_token: birthCertFor(tx) });
  assert.equal(replay.status, 400);
});

test('an injected (unsigned) disclosure is rejected', async () => {
  const tx = oid4vp.createTransaction('fda');
  const vp = birthCertFor(tx);
  const parts = vp.split('~');
  const forged = Buffer.from(JSON.stringify(['salt', 'birth_date', '2010-01-01'])).toString('base64url');
  parts.splice(1, 0, forged);
  await oid4vp.handleWalletResponse({ state: tx.state, vp_token: parts.join('~') });
  assert.equal(tx.status, 'rejected');
});

test('an SD-JWT bound to another nonce fails holder binding', async () => {
  const tx = oid4vp.createTransaction('fda');
  const vp = birthCertFor(tx, { nonce: 'another-nonce' });
  const original = config.REQUIRE_HOLDER_BINDING;
  config.REQUIRE_HOLDER_BINDING = true;
  try {
    await oid4vp.handleWalletResponse({ state: tx.state, vp_token: vp });
  } finally {
    config.REQUIRE_HOLDER_BINDING = original;
  }
  assert.equal(tx.status, 'rejected');
  assert.equal(tx.results[0].checks.holderBinding.detail, 'nonce_mismatch');
});

test('a tampered mdoc element value is rejected (digest mismatch)', async () => {
  const tx = oid4vp.createTransaction('bedc');
  const response = decode(Buffer.from(pidFor(tx), 'base64url'));
  const items = response.documents[0].issuerSigned.nameSpaces[PID.namespace];
  const idx = items.findIndex((t) => decode(t.value).elementIdentifier === 'family_name');
  const item = decode(items[idx].value);
  item.elementValue = 'IMPOSTOR';
  items[idx] = new Tag(encode(item), 24);
  await oid4vp.handleWalletResponse({ state: tx.state, vp_token: Buffer.from(encode(response)).toString('base64url') });
  assert.equal(tx.status, 'rejected');
  assert.ok(tx.reasons.some((r) => r.startsWith('digest_mismatch')), JSON.stringify(tx.reasons));
});

test('an mdoc presented for another verifier fails device authentication', async () => {
  const tx = oid4vp.createTransaction('bedc');
  const vp = pidFor(tx, { clientId: 'some-other-verifier' });
  await oid4vp.handleWalletResponse({ state: tx.state, vp_token: vp });
  assert.equal(tx.results[0].checks.holderBinding.ok, false);
});

test('each relying party only accepts its own credential', async () => {
  const tx = oid4vp.createTransaction('bedc');
  const sdJwt = wallet.presentBirthCertificateSdJwt({ requested: RELYING_PARTIES.fda.claims, clientId: tx.clientId, nonce: tx.nonce });
  await oid4vp.handleWalletResponse({ state: tx.state, vp_token: sdJwt });
  assert.equal(tx.status, 'rejected');
});

test('the authorization request follows the rulebook identifiers', () => {
  const pd = oid4vp.presentationDefinition(RELYING_PARTIES.bedc);
  assert.equal(pd.input_descriptors[0].id, 'eu.europa.ec.eudi.pid.1');
  assert.ok(pd.input_descriptors[0].constraints.fields.every((f) => f.path[0].startsWith("$['eu.europa.ec.eudi.pid.1']")));
  const dcql = oid4vp.dcqlQuery(RELYING_PARTIES.fda);
  assert.deepEqual(dcql.credentials[0].meta.vct_values, config.BIRTH_CERT_VCTS);
  assert.equal(dcql.credentials[0].format, 'dc+sd-jwt');
});

test('every wallet-test variant produces a request that verifies end to end', async () => {
  for (const variant of Object.keys(oid4vp.VARIANTS)) {
    for (const rpId of ['bedc', 'fda']) {
      const tx = oid4vp.createTransaction(rpId, variant);
      const { uri } = oid4vp.authorizationRequest(tx);
      const query = new URL(uri.replace('openid4vp://', 'http://x/')).searchParams;
      assert.equal(query.get('client_id'), tx.clientId, variant);
      const vp = rpId === 'bedc' ? pidFor(tx) : birthCertFor(tx);
      const token = tx.profile.queryLanguage === 'dcql' ? JSON.stringify({ [RELYING_PARTIES[rpId].credential]: [vp] }) : vp;
      await oid4vp.handleWalletResponse({ state: tx.state, vp_token: token });
      assert.equal(tx.status, 'verified', `${variant}/${rpId}: ${JSON.stringify(tx.reasons)}`);
      assert.ok(tx.accepted.checks.holderBinding.ok, `${variant}/${rpId} holder binding`);
    }
  }
});
