'use strict';

/**
 * Minimal SD-JWT VC decoder for a DUMMY / PoC verifier.
 *
 * IMPORTANT: This does NOT verify the issuer's signature, the issuer's
 * trust chain, revocation status, or key binding. It only parses the
 * compact SD-JWT+KB serialization and reconstructs the disclosed claims
 * so a demo UI can show "here is what the wallet presented".
 *
 * For a production verifier you MUST additionally:
 *  - resolve the issuer's public key (e.g. via x5c in the JWT header,
 *    or the issuer's .well-known/jwt-vc-issuer metadata)
 *  - verify the JWT signature (ES256/ES384 etc.)
 *  - verify each disclosure hashes into the `_sd` array it claims to
 *  - verify the Key Binding JWT (audience = verifier, nonce matches,
 *    signed with the cnf.jwk from the SD-JWT)
 *  - check `exp` / `nbf` / `iat` and any revocation status list
 */

function b64urlToBuffer(input) {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64');
}

function decodeJwtPart(part) {
  return JSON.parse(b64urlToBuffer(part).toString('utf8'));
}

function decodeDisclosure(disclosure) {
  const arr = JSON.parse(b64urlToBuffer(disclosure).toString('utf8'));
  // Object property disclosure: [salt, key, value]
  // Array element disclosure: [salt, value]
  if (arr.length === 3) {
    return { type: 'object', salt: arr[0], key: arr[1], value: arr[2], raw: disclosure };
  }
  return { type: 'array', salt: arr[0], value: arr[1], raw: disclosure };
}

/**
 * Recursively walk an object/array, replacing `_sd` digest references
 * is NOT possible without hashing — since we skip hash verification in
 * this dummy decoder, we instead just flatten all disclosed key/value
 * pairs we found (regardless of nesting) into a single claims map, which
 * is good enough for a demo screen. Nested structures are preserved
 * where the disclosure value itself is an object.
 */
function decodeSdJwtVc(presentation) {
  const parts = presentation.split('~');
  if (parts.length < 2) {
    throw new Error('Not a valid SD-JWT (expected at least "<jwt>~")');
  }

  const jwt = parts[0];
  const [headerB64, payloadB64] = jwt.split('.');
  if (!headerB64 || !payloadB64) {
    throw new Error('Malformed JWT in SD-JWT');
  }
  const header = decodeJwtPart(headerB64);
  const payload = decodeJwtPart(payloadB64);

  // Last segment after the final '~' is the Key Binding JWT if the
  // original string did NOT end in '~'. If it ends in '~', there is
  // no KB-JWT (issuer-signed only, not presented with holder binding).
  let kbJwt = null;
  let disclosureParts = parts.slice(1);
  if (presentation.trim().slice(-1) !== '~' && disclosureParts.length > 0) {
    const last = disclosureParts[disclosureParts.length - 1];
    if (last.includes('.') && last.split('.').length === 3) {
      kbJwt = last;
      disclosureParts = disclosureParts.slice(0, -1);
    }
  }
  disclosureParts = disclosureParts.filter((p) => p.length > 0);

  const disclosures = disclosureParts.map(decodeDisclosure);

  const disclosedClaims = {};
  for (const d of disclosures) {
    if (d.type === 'object') {
      disclosedClaims[d.key] = d.value;
    }
  }

  let kbPayload = null;
  if (kbJwt) {
    const [, kbPayloadB64] = kbJwt.split('.');
    kbPayload = decodeJwtPart(kbPayloadB64);
  }

  return {
    header,
    payload, // includes non-selectively-disclosed claims + `_sd`, `_sd_alg`, `vct`, `iss`, etc.
    disclosures,
    disclosedClaims,
    keyBinding: kbPayload, // { aud, nonce, iat, ... } if present
    signatureVerified: false, // this decoder never verifies signatures
  };
}

module.exports = { decodeSdJwtVc };
