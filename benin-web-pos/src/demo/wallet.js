'use strict';

/**
 * DEMO ONLY — a simulated ANIP issuer and citizen wallet ("Demo without a phone").
 *
 * Issues a rulebook-conformant PID mdoc (persona KOSSI Jean) signed by an
 * ephemeral demo IACA / document signer generated at start-up, and presents the
 * requested elements exactly like a wallet: DeviceResponse with DeviceAuth over
 * the OpenID4VP SessionTranscript, encrypted to the terminal's key
 * (direct_post.jwt). The POS verifies it with the same code as a real wallet.
 *
 * Tamper modes reproduce the Android app's simulations:
 *   NONE         genuine PID
 *   ALTERED_NAME family_name changed after the issuer signed it → data integrity fails
 *   EXPIRED      validity period in the past → validity fails
 */

const crypto = require('crypto');
require('reflect-metadata');
const x509 = require('@peculiar/x509');
const { Tag } = require('cbor-x');
const { encode, sessionTranscripts } = require('../verify/mdoc');
const { b64u, sign, sha } = require('../verify/jose');
const jwe = require('../verify/jwe');
const trust = require('../verify/trust');
const profile = require('../profile');

x509.cryptoProvider.set(crypto.webcrypto);

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
const DEMO_ANCHOR = 'DEMO ANIP IACA (simulated)';

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

const tdate = (d) => new Tag(d.toISOString().replace(/\.\d{3}Z$/, 'Z'), 0);
const mdocValue = (name, value) => (FULL_DATES.includes(name) ? new Tag(value, 1004) : value);
const itemBytes = (digestID, name, value, random) =>
  new Tag(encode({ digestID, random, elementIdentifier: name, elementValue: mdocValue(name, value) }), 24);

/** Issues the PID mdoc and presents `requested` as a base64url DeviceResponse. */
function presentPid({ requested, clientId, nonce, responseUri, jwkThumbprint = null, tamper = 'NONE' }) {
  if (!issuer) throw new Error('demo issuer not initialised');
  const { namespace, docType } = profile.PID;
  const device = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = device.publicKey.export({ format: 'jwk' });
  const now = new Date();

  const items = Object.entries(PERSONA).map(([name, value], i) => {
    const random = crypto.randomBytes(16);
    return { name, random, tagged: itemBytes(i, name, value, random) };
  });
  const digests = new Map(items.map((it, i) => [i, sha('SHA-256', encode(it.tagged))]));

  const expired = tamper === 'EXPIRED';
  const day = 24 * 3600 * 1000;
  const mso = {
    version: '1.0',
    digestAlgorithm: 'SHA-256',
    valueDigests: { [namespace]: digests },
    deviceKeyInfo: { deviceKey: new Map([[1, 2], [-1, 1], [-2, b64u.decode(jwk.x)], [-3, b64u.decode(jwk.y)]]) },
    docType,
    validityInfo: expired
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
  const [st] = sessionTranscripts({ clientId, nonce, responseUri, jwkThumbprint });
  const deviceAuthBytes = encode(new Tag(encode(['DeviceAuthentication', st.value, docType, deviceNameSpaces]), 24));
  const devProtected = encode(new Map([[1, -7]]));
  const devSig = sign('ES256', device.privateKey, encode(['Signature1', devProtected, Buffer.alloc(0), deviceAuthBytes]));

  const deviceResponse = {
    version: '1.0',
    documents: [
      {
        docType,
        issuerSigned: { nameSpaces: { [namespace]: items.filter((it) => requested.includes(it.name)).map((it) => it.tagged) }, issuerAuth },
        deviceSigned: { nameSpaces: deviceNameSpaces, deviceAuth: { deviceSignature: [devProtected, new Map(), null, devSig] } }
      }
    ],
    status: 0
  };
  return Buffer.from(encode(deviceResponse)).toString('base64url');
}

/**
 * The body the wallet would POST to response_uri for this transaction
 * (JWE-encrypted to the terminal's key with direct_post.jwt).
 */
function respond(tx, { tamper = 'NONE' } = {}) {
  const jwkThumbprint = tx.encryption ? jwe.thumbprint(tx.encryption.jwk) : null;
  const requested = profile.elements(tx.pos.policy.includePortrait).map((e) => e.id);
  const presentation = presentPid({ requested, clientId: tx.clientId, nonce: tx.nonce, responseUri: tx.responseUri, jwkThumbprint, tamper });
  const vpToken = { pid: [presentation] };
  if (!tx.encryption) return { state: tx.state, vp_token: JSON.stringify(vpToken) };
  const payload = JSON.stringify({ state: tx.state, vp_token: vpToken });
  return { response: jwe.encrypt(payload, tx.encryption.jwk, { apv: Buffer.from(tx.nonce), apu: crypto.randomBytes(16) }) };
}

module.exports = { init, presentPid, respond, PERSONA, DEMO_ANCHOR, TAMPER: ['NONE', 'ALTERED_NAME', 'EXPIRED'] };
