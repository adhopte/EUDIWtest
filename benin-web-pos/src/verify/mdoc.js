'use strict';

const crypto = require('crypto');
const { Encoder, decode, Tag } = require('cbor-x');
const { COSE_ALGS, verifySignature, sha, publicKeyFromJwk } = require('./jose');
const trust = require('./trust');

const cbor = new Encoder({ useRecords: false, variableMapSize: true, tagUint8Array: false, mapsAsObjects: false });
const encode = (v) => cbor.encode(v);

/** Reads a key from a CBOR map decoded either as Map or plain object. */
function get(m, key) {
  if (m instanceof Map) return m.get(key);
  if (m && typeof m === 'object') return m[key];
  return undefined;
}

function entries(m) {
  if (m instanceof Map) return [...m.entries()];
  return Object.entries(m || {});
}

function untag(v, tag) {
  if (v instanceof Tag) {
    if (tag !== undefined && v.tag !== tag) throw new Error(`unexpected CBOR tag ${v.tag}`);
    return v.value;
  }
  return v;
}

/** Tag 24 "encoded CBOR data item": returns [decodedValue, fullTaggedBytes]. */
function decodeTag24(v) {
  const bytes = untag(v, 24);
  return [decode(bytes), encode(new Tag(Buffer.from(bytes), 24))];
}

function toDate(v) {
  if (v instanceof Date) return v;
  if (v instanceof Tag) return new Date(v.value);
  return new Date(v);
}

/** Converts CBOR values into JSON-friendly values for display. */
function plain(v) {
  if (v instanceof Tag) {
    if (v.tag === 1004 || v.tag === 0) return String(v.value);
    if (v.tag === 1) return new Date(v.value * 1000).toISOString();
    return plain(v.value);
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { bytes: Buffer.from(v).toString('base64') };
  if (Array.isArray(v)) return v.map(plain);
  if (v instanceof Map || (v && typeof v === 'object')) {
    const o = {};
    for (const [k, val] of entries(v)) o[String(k)] = plain(val);
    return o;
  }
  return v;
}

function parseCoseSign1(v) {
  const arr = untag(v, 18);
  if (!Array.isArray(arr) || arr.length !== 4) throw new Error('malformed COSE_Sign1');
  const [protectedBytes, unprotected, payload, signature] = arr;
  const protectedHeader = protectedBytes && protectedBytes.length ? decode(protectedBytes) : new Map();
  const algId = get(protectedHeader, 1) ?? get(unprotected, 1);
  return {
    protectedBytes: Buffer.from(protectedBytes || []),
    protectedHeader,
    unprotected,
    payload: payload == null ? null : Buffer.from(payload),
    signature: Buffer.from(signature),
    alg: COSE_ALGS[String(algId)]
  };
}

function verifyCoseSign1(cose, publicKey, detachedPayload) {
  const payload = detachedPayload || cose.payload;
  const sigStructure = encode(['Signature1', cose.protectedBytes, Buffer.alloc(0), payload]);
  return verifySignature(cose.alg, publicKey, sigStructure, cose.signature);
}

function coseKeyToJwk(coseKey) {
  const kty = get(coseKey, 1);
  if (kty === 2) {
    const crv = { 1: 'P-256', 2: 'P-384', 3: 'P-521' }[get(coseKey, -1)];
    return { kty: 'EC', crv, x: Buffer.from(get(coseKey, -2)).toString('base64url'), y: Buffer.from(get(coseKey, -3)).toString('base64url') };
  }
  if (kty === 1) {
    return { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(get(coseKey, -2)).toString('base64url') };
  }
  throw new Error(`unsupported COSE key type ${kty}`);
}

/**
 * Verifies a base64url-encoded ISO/IEC 18013-5 DeviceResponse.
 *
 * @param {string} token
 * @param {{ docType: string, namespace: string, sessionTranscriptBytes: Buffer, readerPrivateKey?: crypto.KeyObject }} expected
 * @returns {Promise<object[]>} one result per document
 */
async function verifyDeviceResponse(token, expected) {
  let response;
  try {
    response = decode(Buffer.from(token, 'base64url'));
  } catch (err) {
    return [{ format: 'mso_mdoc', claims: {}, checks: {}, errors: [`cbor_decode_failed: ${err.message}`] }];
  }
  const documents = get(response, 'documents') || [];
  if (documents.length === 0) {
    return [{ format: 'mso_mdoc', claims: {}, checks: {}, errors: [`no_documents (status ${get(response, 'status')})`] }];
  }
  return documents.map((doc) => verifyDocument(doc, expected));
}

function verifyDocument(doc, expected) {
  const result = { format: 'mso_mdoc', claims: {}, checks: {}, errors: [] };
  try {
    const docType = get(doc, 'docType');
    result.docType = docType;
    const issuerSigned = get(doc, 'issuerSigned');

    // 1. Issuer authentication (COSE_Sign1 over the MSO)
    const issuerAuth = parseCoseSign1(get(issuerSigned, 'issuerAuth'));
    let x5chain = get(issuerAuth.unprotected, 33) ?? get(issuerAuth.protectedHeader, 33);
    if (x5chain && !Array.isArray(x5chain)) x5chain = [x5chain];
    const chain = (x5chain || []).map((der) => new crypto.X509Certificate(Buffer.from(der)));
    if (chain.length === 0) throw new Error('issuerAuth has no x5chain');
    // Top certificate of the presented chain, for the demo "trust this issuer" action
    result.issuerTopPem = chain[chain.length - 1].toString();

    let sigOk = false;
    try {
      sigOk = verifyCoseSign1(issuerAuth, chain[0].publicKey);
    } catch (err) {
      result.errors.push(`issuer_signature: ${err.message}`);
    }
    result.checks.issuerSignature = { ok: sigOk, detail: issuerAuth.alg };
    const t = trust.evaluateChain(chain);
    result.checks.trustedIssuer = { ok: t.trusted, detail: t.trusted ? t.anchor : t.reason };
    result.issuer = t.subject;

    const [mso] = decodeTag24(decode(issuerAuth.payload));

    // 2. Credential type
    const msoDocType = get(mso, 'docType');
    result.checks.credentialType = {
      ok: docType === expected.docType && msoDocType === docType,
      detail: docType
    };

    // 3. Validity
    const validity = get(mso, 'validityInfo');
    const now = new Date();
    const validFrom = toDate(get(validity, 'validFrom'));
    const validUntil = toDate(get(validity, 'validUntil'));
    result.checks.validity = {
      ok: validFrom <= now && now <= validUntil,
      detail: `${validFrom.toISOString().slice(0, 10)} → ${validUntil.toISOString().slice(0, 10)}`
    };

    // 4. Value digests of every disclosed data element
    const digestAlg = get(mso, 'digestAlgorithm');
    const valueDigests = get(mso, 'valueDigests');
    let count = 0;
    let digestsOk = true;
    for (const [ns, items] of entries(get(issuerSigned, 'nameSpaces'))) {
      const nsDigests = get(valueDigests, ns);
      for (const tagged of items) {
        const [item, taggedBytes] = decodeTag24(tagged);
        const digestId = get(item, 'digestID');
        const expectedDigest = get(nsDigests, digestId);
        const actual = sha(digestAlg, taggedBytes);
        if (!expectedDigest || !actual.equals(Buffer.from(expectedDigest))) {
          digestsOk = false;
          result.errors.push(`digest_mismatch: ${ns}/${get(item, 'elementIdentifier')}`);
          continue;
        }
        count += 1;
        if (ns === expected.namespace || !expected.namespace) {
          result.claims[get(item, 'elementIdentifier')] = plain(get(item, 'elementValue'));
        }
      }
    }
    result.checks.disclosures = { ok: digestsOk, detail: `${count}` };

    // 5. Device authentication (holder binding bound to this request)
    result.checks.holderBinding = verifyDeviceAuth(doc, docType, mso, expected);
    result.checks.status = { ok: true, detail: get(mso, 'status') ? 'not_checked_poc' : 'none' };
  } catch (err) {
    result.errors.push(err.message);
  }
  return result;
}

/**
 * DeviceAuthenticationBytes = #6.24(bstr .cbor ["DeviceAuthentication", SessionTranscript,
 * DocType, DeviceNameSpacesBytes]). The SessionTranscript is embedded as the exact
 * bytes the reader used (ISO/IEC 18013-5 §9.1.3.4).
 */
function deviceAuthenticationBytes(sessionTranscriptBytes, docType, deviceNameSpaces) {
  const da = Buffer.concat([Buffer.from([0x84]), encode('DeviceAuthentication'), Buffer.from(sessionTranscriptBytes), encode(docType), encode(deviceNameSpaces)]);
  return encode(new Tag(da, 24));
}

/** EMacKey = HKDF-SHA256(ECDH(EReaderKey, SDeviceKey), SHA-256(SessionTranscriptBytes), "EMacKey") */
function eMacKey(readerPrivateKey, deviceKey, sessionTranscriptBytes) {
  const z = crypto.diffieHellman({ privateKey: readerPrivateKey, publicKey: deviceKey });
  const salt = sha('sha-256', encode(new Tag(Buffer.from(sessionTranscriptBytes), 24)));
  return Buffer.from(crypto.hkdfSync('sha256', z, salt, Buffer.from('EMacKey'), 32));
}

function verifyDeviceAuth(doc, docType, mso, expected) {
  try {
    if (!expected.sessionTranscriptBytes) return { ok: false, detail: 'no_session_transcript' };
    const deviceSigned = get(doc, 'deviceSigned');
    if (!deviceSigned) return { ok: false, detail: 'missing_device_signed' };
    const deviceAuth = get(deviceSigned, 'deviceAuth');
    const deviceKeyJwk = coseKeyToJwk(get(get(mso, 'deviceKeyInfo'), 'deviceKey'));
    const deviceNameSpaces = new Tag(Buffer.from(untag(get(deviceSigned, 'nameSpaces'), 24)), 24);
    const daBytes = deviceAuthenticationBytes(expected.sessionTranscriptBytes, docType, deviceNameSpaces);

    const sig = get(deviceAuth, 'deviceSignature');
    if (sig) {
      const ok = verifyCoseSign1(parseCoseSign1(sig), publicKeyFromJwk(deviceKeyJwk), daBytes);
      return ok ? { ok: true, detail: 'DeviceSignature · ISO 18013-5 SessionTranscript' } : { ok: false, detail: 'session_transcript_mismatch' };
    }
    const mac = get(deviceAuth, 'deviceMac');
    if (mac) {
      if (!expected.readerPrivateKey) return { ok: false, detail: 'device_mac_without_reader_key' };
      const [protectedBytes, , , tag] = untag(mac, 17);
      const alg = get(decode(protectedBytes), 1);
      if (alg !== 5) return { ok: false, detail: `unsupported_mac_alg_${alg}` };
      const key = eMacKey(expected.readerPrivateKey, publicKeyFromJwk(deviceKeyJwk), expected.sessionTranscriptBytes);
      const macStructure = encode(['MAC0', Buffer.from(protectedBytes), Buffer.alloc(0), daBytes]);
      const expectedTag = crypto.createHmac('sha256', key).update(macStructure).digest();
      const ok = Buffer.from(tag).length === expectedTag.length && crypto.timingSafeEqual(Buffer.from(tag), expectedTag);
      return ok ? { ok: true, detail: 'DeviceMac (HMAC-SHA256) · ISO 18013-5 SessionTranscript' } : { ok: false, detail: 'device_mac_mismatch' };
    }
    return { ok: false, detail: 'missing_device_auth' };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

module.exports = { verifyDeviceResponse, encode, deviceAuthenticationBytes, eMacKey, coseKeyToJwk };
