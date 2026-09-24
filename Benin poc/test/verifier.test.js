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

const jwe = require('../src/verify/jwe');

function pidFor(tx, extra = {}) {
  const jwkThumbprint = tx.encryption ? jwe.thumbprint(tx.encryption.jwk) : null;
  return wallet.presentPidMdoc({ requested: RELYING_PARTIES.bedc.claims, clientId: tx.clientId, nonce: tx.nonce, responseUri: tx.responseUri, jwkThumbprint, ...extra });
}

/** Posts a presentation the way the wallet would (DCQL-shaped, encrypted when requested). */
function post(tx, vp) {
  return oid4vp.handleWalletResponse(wallet.respond(tx, RELYING_PARTIES[tx.rpId], { vpOverride: vp }));
}

function birthCertFor(tx, extra = {}) {
  return wallet.presentBirthCertificateSdJwt({ requested: RELYING_PARTIES.fda.claims, clientId: tx.clientId, nonce: tx.nonce, ...extra });
}

test('BEDC accepts a valid PID mdoc and discloses only requested elements', async () => {
  const tx = oid4vp.createTransaction('bedc');
  const res = await post(tx, pidFor(tx));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {}, 'no redirect_uri in the cross-device (QR) flow');
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
  await post(tx, birthCertFor(tx));
  assert.equal(tx.status, 'verified', JSON.stringify(tx.reasons));
  const { claims, checks } = tx.accepted;
  assert.equal(claims.birth_record_reference, 'BJ-PN-1995-004518');
  assert.equal(claims.given_name, 'Angélique');
  assert.equal(claims.mother_family_name, undefined, 'filiation data must not be disclosed');
  assert.ok(checks.holderBinding.ok, checks.holderBinding.detail);
  assert.ok(checks.trustedIssuer.ok, checks.trustedIssuer.detail);
});

test('an unencrypted response is refused when direct_post.jwt was requested', async () => {
  const tx = oid4vp.createTransaction('fda');
  assert.ok(tx.encryption, 'default response mode is direct_post.jwt');
  const res = await oid4vp.handleWalletResponse({ state: tx.state, vp_token: JSON.stringify({ birth_certificate: [birthCertFor(tx)] }) });
  assert.equal(res.status, 400);
  assert.equal(tx.status, 'rejected');
});

test('a response encrypted to another key is refused', async () => {
  const tx = oid4vp.createTransaction('fda');
  const other = jwe.generateEncryptionKey(tx.encryption.jwk.kid);
  const response = jwe.encrypt(JSON.stringify({ state: tx.state, vp_token: { birth_certificate: [birthCertFor(tx)] } }), other.jwk);
  const res = await oid4vp.handleWalletResponse({ response });
  assert.equal(res.status, 400);
  assert.equal(tx.status, 'pending');
});

test('Concat KDF matches the RFC 7518 Appendix C test vector', () => {
  const z = Buffer.from([158, 86, 217, 29, 129, 113, 53, 211, 114, 131, 66, 131, 191, 132, 38, 156, 251, 49, 110, 163, 218, 128, 106, 72, 246, 218, 167, 121, 140, 254, 144, 196]);
  assert.equal(jwe.concatKdf(z, 'A128GCM', Buffer.from('Alice'), Buffer.from('Bob')).toString('base64url'), 'VqqN6vgjbSBcIijNcacQGg');
});

test('a state can only be used once', async () => {
  const tx = oid4vp.createTransaction('fda');
  await post(tx, birthCertFor(tx));
  assert.equal(tx.status, 'verified');
  const accepted = tx.accepted;
  // the same wallet re-sending (encrypted to this transaction's key) is acknowledged but not re-processed
  const again = await post(tx, birthCertFor(tx));
  assert.equal(again.status, 200);
  assert.equal(tx.accepted, accepted);
  assert.equal(tx.duplicateResponses, 1);
  // an unencrypted replay of the state is refused
  const replay = await oid4vp.handleWalletResponse({ state: tx.state, vp_token: '{}' });
  assert.equal(replay.status, 400);
});

test('same-device logins get a redirect_uri back to the relying party', async () => {
  const tx = oid4vp.createTransaction('bedc');
  tx.sameDevice = true;
  const res = await post(tx, pidFor(tx));
  assert.match(res.body.redirect_uri, /\/bedc\/callback\?tx=.+&response_code=/);
});

test('DCQL falls back to the essential claims with claim_sets', () => {
  const q = oid4vp.dcqlQuery(RELYING_PARTIES.fda).credentials[0];
  const byId = Object.fromEntries(q.claims.map((c) => [c.id, c.path[c.path.length - 1]]));
  assert.deepEqual(q.claim_sets[1].map((id) => byId[id]), RELYING_PARTIES.fda.required);
  assert.ok(q.claim_sets.flat().every((id) => q.claims.some((c) => c.id === id)));
});

test('an injected (unsigned) disclosure is rejected', async () => {
  const tx = oid4vp.createTransaction('fda');
  const vp = birthCertFor(tx);
  const parts = vp.split('~');
  const forged = Buffer.from(JSON.stringify(['salt', 'birth_date', '2010-01-01'])).toString('base64url');
  parts.splice(1, 0, forged);
  await post(tx, parts.join('~'));
  assert.equal(tx.status, 'rejected');
});

test('an SD-JWT bound to another nonce fails holder binding', async () => {
  const tx = oid4vp.createTransaction('fda');
  const vp = birthCertFor(tx, { nonce: 'another-nonce' });
  const original = config.REQUIRE_HOLDER_BINDING;
  config.REQUIRE_HOLDER_BINDING = true;
  try {
    await post(tx, vp);
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
  await post(tx, Buffer.from(encode(response)).toString('base64url'));
  assert.equal(tx.status, 'rejected');
  assert.ok(tx.reasons.some((r) => r.startsWith('digest_mismatch')), JSON.stringify(tx.reasons));
});

test('an mdoc presented for another verifier fails device authentication', async () => {
  const tx = oid4vp.createTransaction('bedc');
  const vp = pidFor(tx, { clientId: 'some-other-verifier' });
  await post(tx, vp);
  assert.equal(tx.results[0].checks.holderBinding.ok, false);
});

test('each relying party only accepts its own credential', async () => {
  const tx = oid4vp.createTransaction('bedc');
  const sdJwt = wallet.presentBirthCertificateSdJwt({ requested: RELYING_PARTIES.fda.claims, clientId: tx.clientId, nonce: tx.nonce });
  await post(tx, sdJwt);
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
      await post(tx, vp);
      assert.equal(tx.status, 'verified', `${variant}/${rpId}: ${JSON.stringify(tx.reasons)}`);
      assert.ok(tx.accepted.checks.holderBinding.ok, `${variant}/${rpId} holder binding`);
    }
  }
});

test('FDA also accepts the birth certificate as an mdoc (rulebook: mdoc optional)', async () => {
  const tx = oid4vp.createTransaction('fda');
  const jwkThumbprint = tx.encryption ? jwe.thumbprint(tx.encryption.jwk) : null;
  const vp = wallet.presentBirthCertificateMdoc({ requested: RELYING_PARTIES.fda.claims, clientId: tx.clientId, nonce: tx.nonce, responseUri: tx.responseUri, jwkThumbprint });
  await post(tx, vp);
  assert.equal(tx.status, 'verified', JSON.stringify(tx.reasons));
  assert.equal(tx.accepted.format, 'mso_mdoc');
  assert.equal(tx.accepted.docType, 'eu.europa.ec.eudi.birth_certificate.1');
  assert.equal(tx.accepted.claims.birth_record_reference, 'BJ-PN-1995-004518');
  assert.ok(tx.accepted.checks.holderBinding.ok);

  const q = oid4vp.dcqlQuery(RELYING_PARTIES.fda);
  assert.deepEqual(q.credential_sets[0].options, [['bc'], ['bcm']]);
});

test('the compact QR request asks for the birth certificate as mdoc, names and birth date mandatory', () => {
  const q = oid4vp.dcqlQuery(RELYING_PARTIES.fda, { compact: true });
  assert.equal(q.credentials.length, 1);
  const [bc] = q.credentials;
  assert.equal(bc.format, 'mso_mdoc');
  assert.equal(bc.meta.doctype_value, 'eu.europa.ec.eudi.birth_certificate.1');
  const byId = Object.fromEntries(bc.claims.map((c) => [c.id, c.path[1]]));
  assert.deepEqual(bc.claim_sets[1].map((id) => byId[id]), ['family_name', 'given_name', 'birth_date']);
  assert.ok(bc.claims.some((c) => c.path[1] === 'birth_record_reference'));
});
