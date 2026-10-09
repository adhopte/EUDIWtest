'use strict';

/**
 * Turns the mdoc verification result into the POS check list — the same
 * checks, in the same order, as the Android proximity POS (PidVerifier.kt).
 *
 * Status values: PASS, FAIL, WARN, NOT_EVALUATED, NOT_CHECKED.
 * The identity is verified when no check FAILs.
 */

const profile = require('./profile');

const CHECKS = [
  'RESPONSE',
  'ISSUER_SIGNATURE',
  'ISSUER_TRUST',
  'DOC_TYPE',
  'VALIDITY',
  'DEVICE_AUTH',
  'DATA_INTEGRITY',
  'REQUIRED_CLAIMS',
  'AGE_OVER_18',
  'BENIN_PID',
  'REVOCATION'
];

const check = (id, status, detail = '') => ({ id, status, detail: detail == null ? '' : String(detail) });

/** Report when the wallet did not deliver a usable presentation. */
function failedResponse(reason) {
  return {
    verified: false,
    checks: CHECKS.map((id) => (id === 'RESPONSE' ? check(id, 'FAIL', reason) : check(id, 'NOT_EVALUATED'))),
    claims: {}
  };
}

/**
 * @param {{ results?: object[], walletError?: string, responseError?: string }} outcome
 * @param {{ requireTrustedIssuer: boolean, requireAgeOver18: boolean }} policy
 */
function buildReport(outcome, policy) {
  if (outcome.walletError) return failedResponse(`wallet_error:${outcome.walletError}`);
  if (outcome.responseError) return failedResponse(outcome.responseError);
  const results = outcome.results || [];
  const result = results.find((r) => r.docType === profile.PID.docType) || results[0];
  if (!result) return failedResponse('no_presentation');
  const fatal = result.errors.find((e) => /^(cbor_decode_failed|no_documents|issuerAuth has no x5chain|malformed)/.test(e));
  if (fatal || !result.checks.issuerSignature) return failedResponse(fatal || result.errors[0] || 'unreadable_presentation');

  const c = result.checks;
  const claims = result.claims || {};
  const pass = (x) => (x && x.ok ? 'PASS' : 'FAIL');
  const checks = [];

  checks.push(check('RESPONSE', 'PASS', `${result.format} · ${result.docType || '?'}`));
  checks.push(check('ISSUER_SIGNATURE', pass(c.issuerSignature), c.issuerSignature && c.issuerSignature.detail));
  checks.push(
    c.trustedIssuer && c.trustedIssuer.ok
      ? check('ISSUER_TRUST', 'PASS', c.trustedIssuer.detail)
      : check('ISSUER_TRUST', policy.requireTrustedIssuer ? 'FAIL' : 'WARN', (c.trustedIssuer && c.trustedIssuer.detail) || 'untrusted_issuer')
  );
  checks.push(check('DOC_TYPE', pass(c.credentialType), c.credentialType && c.credentialType.detail));
  checks.push(c.validity ? check('VALIDITY', pass(c.validity), c.validity.detail) : check('VALIDITY', 'NOT_EVALUATED'));
  checks.push(c.holderBinding ? check('DEVICE_AUTH', pass(c.holderBinding), c.holderBinding.detail) : check('DEVICE_AUTH', 'NOT_EVALUATED'));
  const altered = result.errors.filter((e) => e.startsWith('digest_mismatch')).map((e) => e.split('/').pop());
  checks.push(
    c.disclosures
      ? check('DATA_INTEGRITY', pass(c.disclosures), altered.length ? `altered: ${altered.join(', ')}` : `${c.disclosures.detail} elements`)
      : check('DATA_INTEGRITY', 'NOT_EVALUATED')
  );

  const missing = profile.REQUIRED.filter((name) => claims[name] === undefined || claims[name] === '');
  checks.push(check('REQUIRED_CLAIMS', missing.length ? 'FAIL' : 'PASS', missing.length ? `missing: ${missing.join(', ')}` : profile.REQUIRED.join(', ')));

  const age = claims.age_over_18;
  if (age === true) checks.push(check('AGE_OVER_18', 'PASS', 'age_over_18 = true'));
  else if (age === false) checks.push(check('AGE_OVER_18', policy.requireAgeOver18 ? 'FAIL' : 'WARN', 'age_over_18 = false'));
  else checks.push(check('AGE_OVER_18', policy.requireAgeOver18 ? 'FAIL' : 'NOT_EVALUATED', 'not shared'));

  const country = claims.issuing_country;
  checks.push(
    country === profile.ISSUING_COUNTRY
      ? check('BENIN_PID', 'PASS', `${claims.issuing_authority || '?'} · ${country}`)
      : check('BENIN_PID', 'WARN', country ? `issuing_country = ${country}` : 'issuing_country not shared')
  );

  // Never simulated: this PoC has no status list / revocation service to call.
  checks.push(check('REVOCATION', 'NOT_CHECKED', c.status && c.status.detail === 'not_checked_poc' ? 'status reference present' : 'no status reference'));

  const validity = c.validity && c.validity.detail ? c.validity.detail.split(' → ') : [];
  return {
    verified: !checks.some((x) => x.status === 'FAIL'),
    checks,
    claims,
    ageOver18: age === true,
    issuer: result.issuer || null,
    issuerTopPem: result.issuerTopPem || null,
    issuerTrusted: Boolean(c.trustedIssuer && c.trustedIssuer.ok),
    deviceAuth: c.holderBinding && c.holderBinding.ok ? c.holderBinding.detail : null,
    validFrom: validity[0] || null,
    validUntil: validity[1] || null
  };
}

module.exports = { buildReport, failedResponse, CHECKS };
