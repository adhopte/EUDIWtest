'use strict';

/**
 * PID constants from the "Benin PID / Birth Certificate Rulebook v1.1
 * (Standard-Namespace Edition)" — sheets "POC Profile" and "PID mdoc" — and
 * the minimum data for the merchant scenario (requirements §3 step 2).
 * Same request as the Android proximity POS (benin-proximity-pos).
 */
const PID = {
  docType: 'eu.europa.ec.eudi.pid.1',
  namespace: 'eu.europa.ec.eudi.pid.1'
};

const ISSUING_COUNTRY = 'BJ';
const ISSUING_AUTHORITY = 'ANIP';

/**
 * Name, age-over-18 result and national-ID confirmation. Following the
 * rulebook Verifier Matrix ("Age > 18: prefer age_over_18 rather than
 * birth_date"), birth_date, address and the NPI are NOT requested.
 */
const ELEMENTS = [
  { id: 'family_name', required: true },
  { id: 'given_name', required: true },
  { id: 'age_over_18', required: false },
  { id: 'document_number', required: false },
  { id: 'issuing_authority', required: false },
  { id: 'issuing_country', required: false },
  { id: 'expiry_date', required: false }
];

/** Optional, off by default (data minimisation): face match by the cashier. */
const PORTRAIT = { id: 'portrait', required: false };

const elements = (includePortrait) => (includePortrait ? [...ELEMENTS, PORTRAIT] : ELEMENTS);
const REQUIRED = ELEMENTS.filter((e) => e.required).map((e) => e.id);

module.exports = { PID, ISSUING_COUNTRY, ISSUING_AUTHORITY, ELEMENTS, PORTRAIT, elements, REQUIRED };
