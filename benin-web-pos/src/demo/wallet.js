'use strict';

/**
 * DEMO ONLY — a simulated ANIP issuer and a simulated citizen wallet acting as
 * an ISO/IEC 18013-5 mdoc ("Demo without a phone").
 *
 * The wallet publishes a real DeviceEngagement ("mdoc:" QR text, EDeviceKey,
 * BLE peripheral-server option), then answers the reader's SessionEstablishment
 * exactly like a phone would: ECDH + HKDF session keys, AES-256-GCM, a
 * DeviceResponse with the requested PID elements and DeviceAuth over the
 * reader's SessionTranscript. Only the transport differs: HTTPS instead of BLE.
 * The browser runs the same reader code (mdoc-reader.js) and the server the
 * same verification as for a real wallet.
 *
 * Tamper modes reproduce the Android app's simulations:
 *   NONE         genuine PID
 *   ALTERED_NAME family_name changed after the issuer signed it → data integrity fails
 *   EXPIRED      validity period in the past → validity fails
 */

const crypto = require('crypto');
require('reflect-metadata');
const x509 = require('@peculiar/x509');
const { Decoder, Tag } = require('cbor-x');
const { encode, deviceAuthenticationBytes, eMacKey } = require('../verify/mdoc');
const { b64u, sign, sha } = require('../verify/jose');
const trust = require('../verify/trust');
const profile = require('../profile');

x509.cryptoProvider.set(crypto.webcrypto);

const decoder = new Decoder({ mapsAsObjects: false, useRecords: false });
const decode = (bytes) => decoder.decode(bytes);
const get = (m, k) => (m instanceof Map ? m.get(k) : m && m[k]);

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
const DEMO_ANCHOR = 'DEMO ANIP IACA (simulated)';
const TAMPER = ['NONE', 'ALTERED_NAME', 'EXPIRED'];

/** Demo persona from the rulebook "Benin Display Simulation" sheet. */
const PERSONA = {
  family_name: 'KOSSI',
  given_name: 'Jean',
  birth_date: '1988-04-12',
  age_over_18: true,
  birth_place: 'Cotonou',
  nationality: ['BJ'],
  resident_address: 'Lot 214, Quartier Haie Vive, 01 BP 1234 Cotonou',
  document_number: 'CNIB123456789',
  issuance_date: '2024-01-15',
  expiry_date: '2034-01-14',
  issuing_authority: profile.ISSUING_AUTHORITY,
  issuing_country: profile.ISSUING_COUNTRY,
  personal_administrative_number: '1234567890123'
};
const FULL_DATES = ['birth_date', 'issuance_date', 'expiry_date'];

let issuer = null;
const devices = new Map(); // simulated wallets waiting for a reader
setInterval(() => {
  const now = Date.now();
  for (const [id, d] of devices) if (now - d.createdAt > 5 * 60 * 1000) devices.delete(id);
}, 60 * 1000).unref();

async function init() {
  if (issuer) return issuer;
  const notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  const notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const iacaKeys = await crypto.webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const iaca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=DEMO ANIP IACA (simulated), O=Republique du Benin - ANIP, C=BJ',
    notBefore,
    notAfter,
    signingAlgorithm: ALG,
    keys: iacaKeys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true)
    ]
  });
  const dsKeys = await crypto.webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const ds = await x509.X509CertificateGenerator.create({
    serialNumber: '02',
    subject: 'CN=DEMO ANIP Document Signer (simulated), O=Republique du Benin - ANIP, C=BJ',
    issuer: iaca.subject,
    notBefore,
    notAfter,
    signingAlgorithm: ALG,
    publicKey: dsKeys.publicKey,
    signingKey: iacaKeys.privateKey,
    extensions: [new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true)]
  });
  const iacaNode = new crypto.X509Certificate(Buffer.from(iaca.rawData));
  trust.addAnchor(iacaNode, DEMO_ANCHOR);
  issuer = { iacaCert: iacaNode, dsDer: Buffer.from(ds.rawData), dsKey: crypto.KeyObject.from(dsKeys.privateKey) };
  return issuer;
}

const coseKey = (publicKey) => {
  const jwk = publicKey.export({ format: 'jwk' });
  return new Map([[1, 2], [-1, 1], [-2, b64u.decode(jwk.x)], [-3, b64u.decode(jwk.y)]]);
};
const keyFromCose = (m) => crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u.encode(get(m, -2)), y: b64u.encode(get(m, -3)) }, format: 'jwk' });
const tdate = (d) => new Tag(d.toISOString().replace(/\.\d{3}Z$/, 'Z'), 0);
const mdocValue = (name, value) => (FULL_DATES.includes(name) ? new Tag(value, 1004) : value);
const itemBytes = (digestID, name, value, random) =>
  new Tag(encode({ digestID, random, elementIdentifier: name, elementValue: mdocValue(name, value) }), 24);
const gcmIv = (identifier, counter) => {
  const iv = Buffer.alloc(12);
  iv[7] = identifier;
  iv.writeUInt32BE(counter, 8);
  return iv;
};

/* ------------------------------------------------- device engagement */

/**
 * A simulated wallet showing its proximity QR code.
 * @returns {{ id: string, qr: string }}
 */
function createDevice({ tamper = 'NONE', deviceAuth = 'signature' } = {}) {
  if (!issuer) throw new Error('demo issuer not initialised');
  const eDevice = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const bleOptions = new Map([[0, true], [1, false], [10, crypto.randomBytes(16)]]);
  const engagement = new Map([
    [0, '1.0'],
    [1, [1, new Tag(encode(coseKey(eDevice.publicKey)), 24)]],
    [2, [[2, 1, bleOptions]]]
  ]);
  const engagementBytes = encode(engagement);
  const id = crypto.randomUUID();
  devices.set(id, { id, createdAt: Date.now(), eDevice, engagementBytes, tamper: TAMPER.includes(tamper) ? tamper : 'NONE', deviceAuth });
  return { id, qr: `mdoc:${b64u.encode(engagementBytes)}` };
}

/* --------------------------------------------------------- the PID */

/** Issues the PID mdoc and returns the Document for the requested elements. */
function presentPid({ requested, sessionTranscriptBytes, readerKey, tamper, deviceAuth }) {
  const { namespace, docType } = profile.PID;
  const device = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const now = new Date();
  const day = 24 * 3600 * 1000;

  const items = Object.entries(PERSONA).map(([name, value], i) => {
    const random = crypto.randomBytes(16);
    return { name, random, tagged: itemBytes(i, name, value, random) };
  });
  const digests = new Map(items.map((it, i) => [i, sha('SHA-256', encode(it.tagged))]));
  const mso = {
    version: '1.0',
    digestAlgorithm: 'SHA-256',
    valueDigests: { [namespace]: digests },
    deviceKeyInfo: { deviceKey: coseKey(device.publicKey) },
    docType,
    validityInfo: tamper === 'EXPIRED'
      ? { signed: tdate(new Date(now - 400 * day)), validFrom: tdate(new Date(now - 400 * day)), validUntil: tdate(new Date(now - 30 * day)) }
      : { signed: tdate(now), validFrom: tdate(new Date(now - 3600 * 1000)), validUntil: tdate(new Date(now.getTime() + 365 * day)) }
  };
  const protectedBytes = encode(new Map([[1, -7]]));
  const payload = encode(new Tag(encode(mso), 24));
  const issuerAuth = [protectedBytes, new Map([[33, issuer.dsDer]]), payload, sign('ES256', issuer.dsKey, encode(['Signature1', protectedBytes, Buffer.alloc(0), payload]))];

  if (tamper === 'ALTERED_NAME') {
    // Someone edits the name after issuance: the value no longer matches the signed digest
    const i = items.findIndex((it) => it.name === 'family_name');
    items[i].tagged = itemBytes(i, 'family_name', 'KOSSOU', items[i].random);
  }

  const deviceNameSpaces = new Tag(encode(new Map()), 24);
  const daBytes = deviceAuthenticationBytes(sessionTranscriptBytes, docType, deviceNameSpaces);
  let auth;
  if (deviceAuth === 'mac') {
    const macProtected = encode(new Map([[1, 5]]));
    const key = eMacKey(device.privateKey, readerKey, sessionTranscriptBytes);
    const tag = crypto.createHmac('sha256', key).update(encode(['MAC0', macProtected, Buffer.alloc(0), daBytes])).digest();
    auth = { deviceMac: [macProtected, new Map(), null, tag] };
  } else {
    const devProtected = encode(new Map([[1, -7]]));
    auth = { deviceSignature: [devProtected, new Map(), null, sign('ES256', device.privateKey, encode(['Signature1', devProtected, Buffer.alloc(0), daBytes]))] };
  }

  return {
    version: '1.0',
    documents: [
      {
        docType,
        issuerSigned: { nameSpaces: { [namespace]: items.filter((it) => requested.includes(it.name)).map((it) => it.tagged) }, issuerAuth },
        deviceSigned: { nameSpaces: deviceNameSpaces, deviceAuth: auth }
      }
    ],
    status: 0
  };
}

/* ----------------------------------------------------- data retrieval */

/**
 * The wallet receives the reader's SessionEstablishment and answers with
 * SessionData (encrypted DeviceResponse) — ISO/IEC 18013-5 §9.1.1.
 */
function handleMessage(id, establishmentBytes) {
  const dev = devices.get(id);
  if (!dev) throw Object.assign(new Error('unknown_demo_wallet'), { status: 404 });
  devices.delete(id); // one presentation per engagement

  const est = decode(establishmentBytes);
  const eReaderKeyBytes = Buffer.from(get(est, 'eReaderKey').value);
  const readerKey = keyFromCose(decode(eReaderKeyBytes));
  const sessionTranscriptBytes = encode([new Tag(dev.engagementBytes, 24), new Tag(eReaderKeyBytes, 24), null]);
  const salt = sha('SHA-256', encode(new Tag(sessionTranscriptBytes, 24)));
  const z = crypto.diffieHellman({ privateKey: dev.eDevice.privateKey, publicKey: readerKey });
  const skReader = Buffer.from(crypto.hkdfSync('sha256', z, salt, Buffer.from('SKReader'), 32));
  const skDevice = Buffer.from(crypto.hkdfSync('sha256', z, salt, Buffer.from('SKDevice'), 32));

  const data = Buffer.from(get(est, 'data'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', skReader, gcmIv(0, 1));
  decipher.setAuthTag(data.subarray(data.length - 16));
  const deviceRequest = decode(Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]));

  const itemsRequest = decode(Buffer.from(get(get(deviceRequest, 'docRequests')[0], 'itemsRequest').value));
  const requested = [...(get(get(itemsRequest, 'nameSpaces'), profile.PID.namespace) || new Map()).keys()];
  const deviceResponse = presentPid({ requested, sessionTranscriptBytes, readerKey, tamper: dev.tamper, deviceAuth: dev.deviceAuth });

  const cipher = crypto.createCipheriv('aes-256-gcm', skDevice, gcmIv(1, 1));
  const encrypted = Buffer.concat([cipher.update(encode(deviceResponse)), cipher.final(), cipher.getAuthTag()]);
  return encode(new Map([['data', encrypted]]));
}

module.exports = { init, createDevice, handleMessage, PERSONA, DEMO_ANCHOR, TAMPER };
