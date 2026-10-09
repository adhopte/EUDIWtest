'use strict';

/*
 * The browser reader (public/js/mdoc-reader.js) checked against the
 * ISO/IEC 18013-5 Annex D test vectors, and the server verification of the
 * Annex D DeviceResponse (DeviceMac over the proximity SessionTranscript).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const R = require('../public/js/mdoc-reader.js');
const CBOR = require('../public/js/cbor.js');
const { verifyDeviceResponse } = require('../src/verify/mdoc');
const V = require('./vectors/iso18013-5-annex-d.json');

const hex = (s) => new Uint8Array(Buffer.from(s, 'hex'));
const toHex = (b) => Buffer.from(b).toString('hex');
const b64u = (h) => Buffer.from(h, 'hex').toString('base64url');
const readerJwk = { kty: 'EC', crv: 'P-256', x: b64u(V.ephemeral_reader_key_x), y: b64u(V.ephemeral_reader_key_y), d: b64u(V.ephemeral_reader_key_d) };

/**
 * Annex D used NFC negotiated handover: its SessionTranscript holds the engagement
 * sent over NFC and a Handover structure (null for the QR engagement used by this POS).
 */
async function vectorSession() {
  const st = CBOR.decode(CBOR.decode(hex(V.session_transcript_bytes)).value);
  const engagement = R.parseEngagement(`mdoc:${Buffer.from(st[0].value).toString('base64url')}`);
  const handover = st[2];
  const subtle = globalThis.crypto.subtle;
  const privateKey = await subtle.importKey('jwk', readerJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const { d, ...pub } = readerJwk;
  const publicKey = await subtle.importKey('jwk', pub, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  return { engagement, session: await R.createSession(engagement, { readerKeyPair: { privateKey, publicKey }, handover }) };
}

test('Annex D: device engagement is parsed (BLE options, EDeviceKey)', () => {
  const e = R.parseEngagement(`mdoc:${b64u(V.device_engagement)}`);
  assert.equal(e.version, '1.0');
  assert.deepEqual(e.methods, ['BLE']);
  assert.equal(e.ble.centralClient, true);
  assert.equal(e.ble.peripheralServer, false);
  assert.equal(e.ble.centralClientUuid, '45efef74-2b2c-4837-a9a3-b0e1d05a6917');
  // Annex D wallet only offers central client mode: a browser cannot be the BLE peripheral
  assert.equal(R.bleCompatibility(e), 'central_only');
  assert.throws(() => R.parseEngagement('openid4vp://?x'), /not_mdoc_qr/);
});

test('Annex D: SessionTranscript, SessionEstablishment and SessionData match the standard', async () => {
  const { session } = await vectorSession();
  assert.equal(toHex(CBOR.encode(new CBOR.Tag(24, session.sessionTranscript))), V.session_transcript_bytes);
  assert.equal(toHex(await session.establishment(hex(V.device_request))), V.session_establishment);
  const opened = await session.open(hex(V.session_data));
  assert.equal(toHex(opened.deviceResponse), V.device_response);
  const end = await session.open(hex(V.session_termination));
  assert.equal(end.status, 20);
  assert.equal(end.deviceResponse, null);
});

test('Annex D: server verifies the DeviceMac and digests of the standard DeviceResponse', async () => {
  const { session } = await vectorSession();
  const [doc] = await verifyDeviceResponse(Buffer.from(V.device_response, 'hex').toString('base64url'), {
    docType: 'org.iso.18013.5.1.mDL',
    namespace: 'org.iso.18013.5.1',
    sessionTranscriptBytes: Buffer.from(session.sessionTranscript),
    readerPrivateKey: crypto.createPrivateKey({ key: readerJwk, format: 'jwk' })
  });
  assert.equal(doc.checks.issuerSignature.ok, true);
  assert.equal(doc.checks.disclosures.ok, true);
  assert.equal(doc.checks.holderBinding.ok, true, doc.checks.holderBinding.detail);
  assert.match(doc.checks.holderBinding.detail, /DeviceMac/);
  assert.equal(doc.claims.family_name, 'Doe');

  // the same response checked against another session's transcript fails
  const other = await R.createSession((await vectorSession()).engagement);
  const [replayed] = await verifyDeviceResponse(Buffer.from(V.device_response, 'hex').toString('base64url'), {
    docType: 'org.iso.18013.5.1.mDL',
    namespace: 'org.iso.18013.5.1',
    sessionTranscriptBytes: Buffer.from(other.sessionTranscript),
    readerPrivateKey: crypto.createPrivateKey({ key: readerJwk, format: 'jwk' })
  });
  assert.equal(replayed.checks.holderBinding.ok, false);
});

test('DeviceRequest asks for the PID elements with intent_to_retain = false', () => {
  const bytes = R.deviceRequest('eu.europa.ec.eudi.pid.1', 'eu.europa.ec.eudi.pid.1', { family_name: false, age_over_18: false });
  const req = CBOR.decode(bytes);
  assert.equal(req.get('version'), '1.0');
  const items = CBOR.decode(req.get('docRequests')[0].get('itemsRequest').value);
  assert.equal(items.get('docType'), 'eu.europa.ec.eudi.pid.1');
  assert.deepEqual([...items.get('nameSpaces').get('eu.europa.ec.eudi.pid.1')], [['family_name', false], ['age_over_18', false]]);
});

test('BLEIdent derivation (HKDF of EDeviceKeyBytes, "BLEIdent")', async () => {
  const e = R.parseEngagement(`mdoc:${b64u(V.device_engagement)}`);
  const expected = crypto.hkdfSync('sha256', Buffer.from(e.eDeviceKeyBytes), Buffer.alloc(0), Buffer.from('BLEIdent'), 16);
  assert.equal(toHex(await R.bleIdent(e.eDeviceKeyBytes)), Buffer.from(expected).toString('hex'));
});
