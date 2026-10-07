'use strict';

const config = require('../config');
const { b64u, parseJws, verifyJws, publicKeyFromJwk, certsFromX5c, sha } = require('./jose');
const trust = require('./trust');

/**
 * Verifies an SD-JWT VC presentation (<issuer-jwt>~<disclosure>~...~<kb-jwt>)
 * per IETF SD-JWT / SD-JWT VC and OpenID4VP.
 *
 * @param {string} presentation
 * @param {{ nonce: string, audiences: string[], vcts: string[] }} expected
 */
async function verifySdJwtPresentation(presentation, expected) {
  const result = {
    format: 'dc+sd-jwt',
    claims: {},
    checks: {},
    errors: []
  };
  const fail = (msg) => {
    result.errors.push(msg);
    return result;
  };

  const parts = presentation.trim().split('~');
  if (parts.length < 2) return fail('not_an_sd_jwt');

  const issuerJwt = parts[0];
  const kbJwt = parts[parts.length - 1] || null;
  const disclosures = parts.slice(1, -1);

  let jws;
  try {
    jws = parseJws(issuerJwt);
  } catch (err) {
    return fail(`malformed_issuer_jwt: ${err.message}`);
  }
  const { header, payload } = jws;
  result.vct = payload.vct;
  result.issuer = payload.iss;

  // 1. Credential type
  result.checks.credentialType = {
    ok: Boolean(payload.vct) && expected.vcts.includes(payload.vct),
    detail: payload.vct
  };

  // 2. Issuer signature + trust
  const issuerKey = await resolveIssuerKey(header, payload);
  if (issuerKey.key) {
    let ok = false;
    try {
      ok = verifyJws(jws, issuerKey.key);
    } catch (err) {
      issuerKey.reason = err.message;
    }
    result.checks.issuerSignature = { ok, detail: issuerKey.source };
  } else {
    result.checks.issuerSignature = { ok: false, detail: issuerKey.reason };
  }
  result.checks.trustedIssuer = { ok: issuerKey.trusted === true, detail: issuerKey.trustDetail };

  // 3. Disclosures: every disclosure must hash into the payload exactly once
  const sdAlg = payload._sd_alg || 'sha-256';
  const byDigest = new Map();
  try {
    for (const d of disclosures) {
      const digest = b64u.encode(sha(sdAlg, Buffer.from(d, 'ascii')));
      if (byDigest.has(digest)) throw new Error('duplicate_disclosure');
      const arr = JSON.parse(b64u.decode(d).toString('utf8'));
      if (!Array.isArray(arr) || (arr.length !== 2 && arr.length !== 3)) throw new Error('malformed_disclosure');
      byDigest.set(digest, { arr, used: false });
    }
    const processed = reconstruct(payload, byDigest);
    const unused = [...byDigest.values()].filter((d) => !d.used).length;
    if (unused > 0) throw new Error(`${unused}_unreferenced_disclosures`);
    result.checks.disclosures = { ok: true, detail: `${disclosures.length}` };

    const { iss, iat, nbf, exp, cnf, vct, status, ...claims } = processed;
    result.claims = claims;
    result.status = status;
    result.cnf = cnf;
  } catch (err) {
    result.checks.disclosures = { ok: false, detail: err.message };
    return fail(`disclosures: ${err.message}`);
  }

  // 4. Validity period
  const now = Math.floor(Date.now() / 1000);
  const skew = 60;
  const expired = typeof payload.exp === 'number' && payload.exp + skew < now;
  const notYet = typeof payload.nbf === 'number' && payload.nbf - skew > now;
  result.checks.validity = { ok: !expired && !notYet, detail: expired ? 'expired' : notYet ? 'not_yet_valid' : undefined };

  // 5. Key binding (holder binding) — nonce + audience + sd_hash + cnf key
  result.checks.holderBinding = verifyKeyBinding(parts, kbJwt, payload.cnf, expected, sdAlg);

  // 6. Status: extensible interface only, per rulebook POC profile
  result.checks.status = { ok: true, detail: payload.status ? 'not_checked_poc' : 'none' };

  return result;
}

function reconstruct(node, byDigest) {
  if (Array.isArray(node)) {
    const out = [];
    for (const item of node) {
      if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 1 && '...' in item) {
        const d = byDigest.get(item['...']);
        if (!d) continue; // undisclosed array element
        if (d.used) throw new Error('digest_reused');
        if (d.arr.length !== 2) throw new Error('array_disclosure_expected');
        d.used = true;
        out.push(reconstruct(d.arr[1], byDigest));
      } else {
        out.push(reconstruct(item, byDigest));
      }
    }
    return out;
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '_sd' || k === '_sd_alg') continue;
      out[k] = reconstruct(v, byDigest);
    }
    for (const digest of node._sd || []) {
      const d = byDigest.get(digest);
      if (!d) continue; // decoy or undisclosed claim
      if (d.used) throw new Error('digest_reused');
      if (d.arr.length !== 3) throw new Error('object_disclosure_expected');
      const [, key, value] = d.arr;
      if (key === '_sd' || key === '...' || key in out) throw new Error(`illegal_or_duplicate_claim_${key}`);
      d.used = true;
      out[key] = reconstruct(value, byDigest);
    }
    return out;
  }
  return node;
}

function verifyKeyBinding(parts, kbJwt, cnf, expected, sdAlg) {
  if (!kbJwt) return { ok: false, detail: 'missing_kb_jwt' };
  if (!cnf || !cnf.jwk) return { ok: false, detail: 'no_cnf_jwk' };
  try {
    const kb = parseJws(kbJwt);
    if (kb.header.typ !== 'kb+jwt') return { ok: false, detail: 'wrong_typ' };
    if (!verifyJws(kb, publicKeyFromJwk(cnf.jwk))) return { ok: false, detail: 'bad_signature' };
    if (kb.payload.nonce !== expected.nonce) return { ok: false, detail: 'nonce_mismatch' };
    if (!expected.audiences.includes(kb.payload.aud)) return { ok: false, detail: 'audience_mismatch' };
    const presented = `${parts.slice(0, -1).join('~')}~`;
    const sdHash = b64u.encode(sha(sdAlg, Buffer.from(presented, 'ascii')));
    if (kb.payload.sd_hash !== sdHash) return { ok: false, detail: 'sd_hash_mismatch' };
    const age = Math.abs(Date.now() / 1000 - kb.payload.iat);
    if (!(age < 600)) return { ok: false, detail: 'stale_kb_jwt' };
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

async function resolveIssuerKey(header, payload) {
  if (Array.isArray(header.x5c) && header.x5c.length > 0) {
    try {
      const chain = certsFromX5c(header.x5c);
      const t = trust.evaluateChain(chain);
      return {
        key: chain[0].publicKey,
        source: 'x5c',
        trusted: t.trusted,
        trustDetail: t.trusted ? t.anchor : t.reason
      };
    } catch (err) {
      return { reason: `bad_x5c: ${err.message}` };
    }
  }

  // SD-JWT VC issuer metadata: <origin>/.well-known/jwt-vc-issuer<path>
  if (typeof payload.iss === 'string' && payload.iss.startsWith('https://')) {
    const listed = config.TRUSTED_ISSUERS.includes(payload.iss);
    try {
      const u = new URL(payload.iss);
      const metaUrl = `${u.origin}/.well-known/jwt-vc-issuer${u.pathname.replace(/\/$/, '')}`;
      const meta = await fetchJson(metaUrl);
      const jwks = meta.jwks || (meta.jwks_uri ? await fetchJson(meta.jwks_uri) : null);
      const keys = (jwks && jwks.keys) || [];
      const jwk = keys.find((k) => !header.kid || k.kid === header.kid);
      if (!jwk) return { reason: 'issuer_key_not_found', trustDetail: 'issuer_key_not_found' };
      return {
        key: publicKeyFromJwk(jwk),
        source: 'jwt-vc-issuer metadata',
        trusted: listed,
        trustDetail: listed ? 'TRUSTED_ISSUERS' : 'issuer_not_in_TRUSTED_ISSUERS'
      };
    } catch (err) {
      return { reason: `metadata_unreachable: ${err.message}`, trustDetail: 'metadata_unreachable' };
    }
  }
  return { reason: 'no_issuer_key', trustDetail: 'no_issuer_key' };
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

module.exports = { verifySdJwtPresentation };
