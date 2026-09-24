'use strict';

/**
 * DEMO ONLY — a simulated ANIP issuer and holder wallet.
 *
 * Produces rulebook-conformant credentials (PID mdoc, Birth Certificate
 * SD-JWT VC) signed by an ephemeral demo IACA / document signer generated at
 * start-up, and presents them exactly like a wallet would (DeviceResponse
 * with DeviceAuth, SD-JWT with KB-JWT). Lets the relying parties be demoed
 * and tested end to end without a physical wallet.
 */

const crypto = require('crypto');
require('reflect-metadata');
const x509 = require('@peculiar/x509');
const { Tag } = require('cbor-x');
const { encode, sessionTranscripts } = require('../verify/mdoc');
const { b64u, sign, signJws, sha } = require('../verify/jose');
const jwe = require('../verify/jwe');
const trust = require('../verify/trust');
const { PID, BIRTH_CERTIFICATE, ISSUING_AUTHORITY, ISSUING_COUNTRY } = require('../rulebook');

x509.cryptoProvider.set(crypto.webcrypto);

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };

// Demo personas from the rulebook "Benin Display Simulation" sheet.
const PERSONAS = {
  pid: {
    family_name: 'KOSSI',
    given_name: 'Jean',
    birth_date: '1988-04-12',
    age_over_18: true,
    birth_place: 'Cotonou',
    birth_country: 'BJ',
    birth_state: 'Littoral',
    birth_city: 'Cotonou',
    nationality: ['BJ'],
    gender: 1,
    resident_address: 'Lot 214, Quartier Haie Vive, 01 BP 1234 Cotonou',
    document_number: 'CNIB123456789',
    issuance_date: '2024-01-15',
    expiry_date: '2034-01-14',
    issuing_authority: ISSUING_AUTHORITY,
    issuing_country: ISSUING_COUNTRY,
    personal_administrative_number: '1234567890123'
  },
  birth_certificate: {
    family_name: 'HOUNGBEDJI',
    given_name: 'Angélique',
    birth_date: '1995-09-03',
    birth_place: 'Porto-Novo',
    birth_country: 'BJ',
    birth_state: 'Oueme',
    birth_city: 'Porto-Novo',
    gender: 2,
    mother_family_name: 'AGBOSSOU',
    mother_given_name: 'Marie',
    father_family_name: 'HOUNGBEDJI',
    father_given_name: 'Paul',
    birth_record_reference: 'BJ-PN-1995-004518',
    registration_date: '1995-09-10',
    registration_place: 'Mairie de Porto-Novo',
    document_number: 'AN-2025-778120',
    issuance_date: '2025-06-01',
    issuing_authority: ISSUING_AUTHORITY
  }
};

// SD-JWT: metadata claims that are never selectively disclosable (rulebook "SD = No")
const SD_JWT_PLAIN = ['issuance_date', 'issuing_authority'];
const FULL_DATES = ['birth_date', 'issuance_date', 'expiry_date', 'registration_date'];

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
  trust.addAnchor(iacaNode, 'DEMO ANIP IACA (simulated)');

  issuer = {
    iacaCert: iacaNode,
    dsDer: Buffer.from(ds.rawData),
    dsKey: crypto.KeyObject.from(dsKeys.privateKey)
  };
  return issuer;
}

function newDeviceKey() {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
}

/* ---------------------------------------------------------------- mdoc */

function mdocValue(name, value) {
  if (FULL_DATES.includes(name)) return new Tag(value, 1004);
  return value;
}

/**
 * Issues an mdoc and immediately presents the requested elements as a
 * base64url DeviceResponse bound to the verifier's request.
 */
function presentMdoc({ docType, namespace, persona, requested, clientId, nonce, responseUri, jwkThumbprint = null, overrides = {} }) {
  const data = { ...persona, ...overrides };
  const device = newDeviceKey();
  const jwk = device.publicKey.export({ format: 'jwk' });
  const now = new Date();
  const tdate = (d) => new Tag(d.toISOString().replace(/\.\d{3}Z$/, 'Z'), 0);

  const items = Object.entries(data).map(([name, value], i) => {
    const item = { digestID: i, random: crypto.randomBytes(16), elementIdentifier: name, elementValue: mdocValue(name, value) };
    return { name, tagged: new Tag(encode(item), 24) };
  });

  const digests = new Map(items.map((it, i) => [i, sha('SHA-256', encode(it.tagged))]));
  const mso = {
    version: '1.0',
    digestAlgorithm: 'SHA-256',
    valueDigests: { [namespace]: digests },
    deviceKeyInfo: {
      deviceKey: new Map([[1, 2], [-1, 1], [-2, b64u.decode(jwk.x)], [-3, b64u.decode(jwk.y)]])
    },
    docType: docType,
    validityInfo: {
      signed: tdate(now),
      validFrom: tdate(new Date(now.getTime() - 3600 * 1000)),
      validUntil: tdate(new Date(now.getTime() + 365 * 24 * 3600 * 1000))
    }
  };

  const protectedBytes = encode(new Map([[1, -7]]));
  const payload = encode(new Tag(encode(mso), 24));
  const sigStructure = encode(['Signature1', protectedBytes, Buffer.alloc(0), payload]);
  const issuerAuth = [protectedBytes, new Map([[33, issuer.dsDer]]), payload, sign('ES256', issuer.dsKey, sigStructure)];

  // DeviceAuth over the OpenID4VP SessionTranscript
  const deviceNameSpaces = new Tag(encode(new Map()), 24);
  const [st] = sessionTranscripts({ clientId, nonce, responseUri, jwkThumbprint });
  const deviceAuthBytes = encode(new Tag(encode(['DeviceAuthentication', st.value, docType, deviceNameSpaces]), 24));
  const devProtected = encode(new Map([[1, -7]]));
  const devSig = sign('ES256', device.privateKey, encode(['Signature1', devProtected, Buffer.alloc(0), deviceAuthBytes]));

  const deviceResponse = {
    version: '1.0',
    documents: [
      {
        docType: docType,
        issuerSigned: {
          nameSpaces: { [namespace]: items.filter((it) => requested.includes(it.name)).map((it) => it.tagged) },
          issuerAuth
        },
        deviceSigned: {
          nameSpaces: deviceNameSpaces,
          deviceAuth: { deviceSignature: [devProtected, new Map(), null, devSig] }
        }
      }
    ],
    status: 0
  };
  return Buffer.from(encode(deviceResponse)).toString('base64url');
}

/** PID mdoc (eu.europa.ec.eudi.pid.1) for the BEDC relying party. */
function presentPidMdoc(args) {
  return presentMdoc({ docType: PID.docType, namespace: PID.namespace, persona: PERSONAS.pid, ...args });
}

/** Birth certificate as mdoc (rulebook: "mdoc optional, same trimmed shape"). */
function presentBirthCertificateMdoc(args) {
  return presentMdoc({ docType: BIRTH_CERTIFICATE.docType, namespace: BIRTH_CERTIFICATE.namespace, persona: PERSONAS.birth_certificate, ...args });
}

/* -------------------------------------------------------------- SD-JWT */

/**
 * Issues a Birth Certificate SD-JWT VC and presents the requested claims
 * with a Key Binding JWT.
 */
function presentBirthCertificateSdJwt({ requested, clientId, nonce, overrides = {} }) {
  const data = { ...PERSONAS.birth_certificate, ...overrides };
  const holder = newDeviceKey();
  const now = Math.floor(Date.now() / 1000);

  const disclosures = {};
  const sd = [];
  const payload = {
    iss: 'https://issuer.benin.example/anip',
    iat: now,
    exp: now + 365 * 24 * 3600,
    vct: BIRTH_CERTIFICATE.vcts[0],
    cnf: { jwk: holder.publicKey.export({ format: 'jwk' }) },
    _sd_alg: 'sha-256'
  };
  for (const [name, value] of Object.entries(data)) {
    if (SD_JWT_PLAIN.includes(name)) {
      payload[name] = value;
      continue;
    }
    const disclosure = b64u.encode(JSON.stringify([crypto.randomBytes(16).toString('base64url'), name, value]));
    disclosures[name] = disclosure;
    sd.push(b64u.encode(sha('sha-256', Buffer.from(disclosure, 'ascii'))));
  }
  // decoy digests so the number of claims is not revealed
  for (let i = 0; i < 3; i += 1) sd.push(b64u.encode(crypto.randomBytes(32)));
  payload._sd = sd.sort();

  const header = { alg: 'ES256', typ: 'dc+sd-jwt', x5c: [issuer.dsDer.toString('base64')] };
  const issuerJwt = signJws(header, payload, issuer.dsKey);

  const selected = requested.filter((c) => disclosures[c]).map((c) => disclosures[c]);
  const presented = `${[issuerJwt, ...selected].join('~')}~`;
  const kbJwt = signJws(
    { alg: 'ES256', typ: 'kb+jwt' },
    { iat: now, aud: clientId, nonce, sd_hash: b64u.encode(sha('sha-256', Buffer.from(presented, 'ascii'))) },
    holder.privateKey
  );
  return presented + kbJwt;
}

/**
 * Presents the relying party's requested credential for a transaction and
 * returns the body the wallet would POST to response_uri (encrypted with the
 * verifier's key when response_mode=direct_post.jwt).
 */
function respond(tx, rp, { vpOverride, presentationArgs = {} } = {}) {
  const jwkThumbprint = tx.encryption ? jwe.thumbprint(tx.encryption.jwk) : null;
  const args = { requested: rp.claims, clientId: tx.clientId, nonce: tx.nonce, responseUri: tx.responseUri, jwkThumbprint, ...presentationArgs };
  const presentation = vpOverride || (rp.format === 'mso_mdoc' ? presentPidMdoc(args) : presentBirthCertificateSdJwt(args));
  const vpToken = tx.profile.queryLanguage === 'dcql' ? { [rp.credential]: [presentation] } : presentation;
  if (!tx.encryption) {
    return { state: tx.state, vp_token: typeof vpToken === 'string' ? vpToken : JSON.stringify(vpToken) };
  }
  const payload = JSON.stringify({ state: tx.state, vp_token: vpToken });
  return { response: jwe.encrypt(payload, tx.encryption.jwk, { apv: Buffer.from(tx.nonce), apu: crypto.randomBytes(16) }) };
}

module.exports = { init, presentPidMdoc, presentBirthCertificateMdoc, presentBirthCertificateSdJwt, respond, PERSONAS };
