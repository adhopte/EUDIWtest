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
 * SessionTranscript candidates for OpenID4VP (no response encryption).
 *  - OpenID4VP 1.0 Appendix B.2.6.1 (OpenID4VPHandover)
 *  - ISO/IEC 18013-7 Annex B (OID4VPHandover), when an mdocGeneratedNonce is known
 */
function sessionTranscripts({ clientId, nonce, responseUri, mdocGeneratedNonce, jwkThumbprint }) {
  const out = [];
  const handover = (thumb) => [null, null, ['OpenID4VPHandover', sha('sha-256', encode([clientId, nonce, thumb, responseUri]))]];
  // With an encrypted response the handover carries the verifier key's JWK thumbprint
  if (jwkThumbprint) out.push({ name: 'OpenID4VP-1.0 (encrypted)', value: handover(Buffer.from(jwkThumbprint)) });
  out.push({ name: 'OpenID4VP-1.0', value: handover(null) });
  if (mdocGeneratedNonce) {
    const clientIdHash = sha('sha-256', encode([clientId, mdocGeneratedNonce]));
    const responseUriHash = sha('sha-256', encode([responseUri, mdocGeneratedNonce]));
    out.push({ name: 'ISO-18013-7', value: [null, null, [clientIdHash, responseUriHash, nonce]] });
  }
  return out;
}

/**
 * Verifies a base64url-encoded ISO/IEC 18013-5 DeviceResponse.
 *
 * @param {string} token
 * @param {{ docType: string, clientId: string, nonce: string, responseUri: string, mdocGeneratedNonce?: string, jwkThumbprint?: Buffer }} expected
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

function verifyDeviceAuth(doc, docType, mso, expected) {
  try {
    const deviceSigned = get(doc, 'deviceSigned');
    if (!deviceSigned) return { ok: false, detail: 'missing_device_signed' };
    const deviceAuth = get(deviceSigned, 'deviceAuth');
    const sig = get(deviceAuth, 'deviceSignature');
    if (!sig) return { ok: false, detail: get(deviceAuth, 'deviceMac') ? 'device_mac_unsupported' : 'missing_device_signature' };
    const cose = parseCoseSign1(sig);
    const deviceKey = publicKeyFromJwk(coseKeyToJwk(get(get(mso, 'deviceKeyInfo'), 'deviceKey')));
    const nameSpacesBytes = get(deviceSigned, 'nameSpaces');
    const deviceNameSpaces = new Tag(Buffer.from(untag(nameSpacesBytes, 24)), 24);

    for (const st of sessionTranscripts(expected)) {
      const deviceAuthentication = ['DeviceAuthentication', st.value, docType, deviceNameSpaces];
      const bytes = encode(new Tag(encode(deviceAuthentication), 24));
      if (verifyCoseSign1(cose, deviceKey, bytes)) return { ok: true, detail: st.name };
    }
    return { ok: false, detail: 'session_transcript_mismatch' };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

module.exports = { verifyDeviceResponse, encode, sessionTranscripts, coseKeyToJwk };
