'use strict';

const crypto = require('crypto');

const b64u = {
  encode: (buf) => Buffer.from(buf).toString('base64url'),
  decode: (str) => Buffer.from(str, 'base64url'),
  json: (str) => JSON.parse(Buffer.from(str, 'base64url').toString('utf8'))
};

// JOSE / COSE algorithm -> node crypto parameters
const ALGS = {
  ES256: { hash: 'sha256', dsaEncoding: 'ieee-p1363' },
  ES384: { hash: 'sha384', dsaEncoding: 'ieee-p1363' },
  ES512: { hash: 'sha512', dsaEncoding: 'ieee-p1363' },
  RS256: { hash: 'sha256' },
  RS384: { hash: 'sha384' },
  RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
  PS384: { hash: 'sha384', padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 },
  EdDSA: { hash: null }
};

const COSE_ALGS = { '-7': 'ES256', '-35': 'ES384', '-36': 'ES512', '-8': 'EdDSA', '-37': 'PS256', '-257': 'RS256' };

function verifySignature(alg, publicKey, data, signature) {
  const params = ALGS[alg];
  if (!params) throw new Error(`Unsupported algorithm ${alg}`);
  const key = { key: publicKey };
  if (params.dsaEncoding) key.dsaEncoding = params.dsaEncoding;
  if (params.padding) {
    key.padding = params.padding;
    key.saltLength = params.saltLength;
  }
  return crypto.verify(params.hash, data, key, signature);
}

function sign(alg, privateKey, data) {
  const params = ALGS[alg];
  const key = { key: privateKey };
  if (params.dsaEncoding) key.dsaEncoding = params.dsaEncoding;
  return crypto.sign(params.hash, data, key);
}

function parseJws(compact) {
  const parts = compact.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWS (expected 3 parts)');
  return {
    header: b64u.json(parts[0]),
    payload: b64u.json(parts[1]),
    signingInput: Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'),
    signature: b64u.decode(parts[2])
  };
}

function verifyJws(parsed, publicKey) {
  if (!parsed.header.alg || parsed.header.alg === 'none') return false;
  return verifySignature(parsed.header.alg, publicKey, parsed.signingInput, parsed.signature);
}

function signJws(header, payload, privateKey) {
  const h = b64u.encode(JSON.stringify(header));
  const p = b64u.encode(JSON.stringify(payload));
  const sig = sign(header.alg, privateKey, Buffer.from(`${h}.${p}`, 'ascii'));
  return `${h}.${p}.${b64u.encode(sig)}`;
}

function publicKeyFromJwk(jwk) {
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

/** x5c entries are standard base64 DER (RFC 7515 §4.1.6). */
function certsFromX5c(x5c) {
  return (x5c || []).map((der) => new crypto.X509Certificate(Buffer.from(der, 'base64')));
}

function sha(alg, data) {
  const map = { 'sha-256': 'sha256', 'sha-384': 'sha384', 'sha-512': 'sha512', 'SHA-256': 'sha256', 'SHA-384': 'sha384', 'SHA-512': 'sha512' };
  const node = map[alg];
  if (!node) throw new Error(`Unsupported hash algorithm ${alg}`);
  return crypto.createHash(node).update(data).digest();
}

module.exports = {
  b64u,
  COSE_ALGS,
  verifySignature,
  sign,
  parseJws,
  verifyJws,
  signJws,
  publicKeyFromJwk,
  certsFromX5c,
  sha
};
