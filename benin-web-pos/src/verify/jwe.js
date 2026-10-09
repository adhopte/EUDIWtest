'use strict';

/**
 * Minimal JWE (RFC 7516) support for OpenID4VP encrypted responses
 * (response_mode=direct_post.jwt, HAIP): key agreement "ECDH-ES" (direct,
 * RFC 7518 §4.6) with content encryption A128GCM / A256GCM.
 */

const crypto = require('crypto');
const { b64u } = require('./jose');

const ENC = { A128GCM: 16, A256GCM: 32 };
const CURVES = { 'P-256': 'prime256v1', 'P-384': 'secp384r1', 'P-521': 'secp521r1' };

function lengthPrefixed(buf) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
}

/** Concat KDF (NIST SP 800-56A, RFC 7518 §4.6.2) with SHA-256. */
function concatKdf(z, enc, apu, apv) {
  const keyLen = ENC[enc];
  const suppPub = Buffer.alloc(4);
  suppPub.writeUInt32BE(keyLen * 8);
  const otherInfo = Buffer.concat([
    lengthPrefixed(Buffer.from(enc, 'ascii')),
    lengthPrefixed(apu),
    lengthPrefixed(apv),
    suppPub
  ]);
  const out = [];
  for (let counter = 1; Buffer.concat(out).length < keyLen; counter += 1) {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter);
    out.push(crypto.createHash('sha256').update(Buffer.concat([c, z, otherInfo])).digest());
  }
  return Buffer.concat(out).subarray(0, keyLen);
}

function ecdh(privateKey, publicKey) {
  return crypto.diffieHellman({ privateKey, publicKey });
}

/** Generates a response-encryption key pair; the public JWK goes into client_metadata.jwks. */
function generateEncryptionKey(kid) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ECDH-ES' };
  return { privateKey, jwk };
}

/** RFC 7638 JWK SHA-256 thumbprint (raw bytes). */
function thumbprint(jwk) {
  const canonical = jwk.kty === 'EC'
    ? JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
    : JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  return crypto.createHash('sha256').update(canonical).digest();
}

function parseHeader(compact) {
  const parts = compact.split('.');
  if (parts.length !== 5) throw new Error('not a compact JWE');
  return b64u.json(parts[0]);
}

/** Decrypts a compact JWE and returns { header, payload (Buffer) }. */
function decrypt(compact, privateKey) {
  const [protectedB64, encryptedKey, ivB64, ciphertextB64, tagB64] = compact.split('.');
  const header = b64u.json(protectedB64);
  if (header.alg !== 'ECDH-ES') throw new Error(`unsupported JWE alg ${header.alg}`);
  if (!ENC[header.enc]) throw new Error(`unsupported JWE enc ${header.enc}`);
  if (encryptedKey) throw new Error('ECDH-ES (direct) must not carry an encrypted key');
  if (!header.epk || !CURVES[header.epk.crv]) throw new Error('missing or unsupported epk');

  const epk = crypto.createPublicKey({ key: header.epk, format: 'jwk' });
  const cek = concatKdf(
    ecdh(privateKey, epk),
    header.enc,
    header.apu ? b64u.decode(header.apu) : Buffer.alloc(0),
    header.apv ? b64u.decode(header.apv) : Buffer.alloc(0)
  );
  const decipher = crypto.createDecipheriv(`aes-${ENC[header.enc] * 8}-gcm`, cek, b64u.decode(ivB64));
  decipher.setAAD(Buffer.from(protectedB64, 'ascii'));
  decipher.setAuthTag(b64u.decode(tagB64));
  const payload = Buffer.concat([decipher.update(b64u.decode(ciphertextB64)), decipher.final()]);
  return { header, payload };
}

/** Encrypts to a recipient EC JWK (used by the demo wallet and tests). */
function encrypt(payload, recipientJwk, { enc = 'A128GCM', apu, apv } = {}) {
  const recipient = crypto.createPublicKey({ key: recipientJwk, format: 'jwk' });
  const eph = crypto.generateKeyPairSync('ec', { namedCurve: CURVES[recipientJwk.crv] });
  const { d, ...epk } = eph.privateKey.export({ format: 'jwk' });
  const header = { alg: 'ECDH-ES', enc, kid: recipientJwk.kid, epk };
  if (apu) header.apu = b64u.encode(apu);
  if (apv) header.apv = b64u.encode(apv);
  const protectedB64 = b64u.encode(JSON.stringify(header));
  const cek = concatKdf(ecdh(eph.privateKey, recipient), enc, apu || Buffer.alloc(0), apv || Buffer.alloc(0));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(`aes-${ENC[enc] * 8}-gcm`, cek, iv);
  cipher.setAAD(Buffer.from(protectedB64, 'ascii'));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(payload)), cipher.final()]);
  return [protectedB64, '', b64u.encode(iv), b64u.encode(ciphertext), b64u.encode(cipher.getAuthTag())].join('.');
}

module.exports = { concatKdf, generateEncryptionKey, thumbprint, parseHeader, decrypt, encrypt, SUPPORTED_ENC: Object.keys(ENC) };
