'use strict';

/**
 * Constants taken from "Benin PID / Birth Certificate Rulebook – v1.1
 * (Standard-Namespace Edition)". Keep this file the single place where the
 * relying parties learn about credential types and claim names.
 */

const config = require('./config');

const PID = {
  docType: 'eu.europa.ec.eudi.pid.1', // POC Profile: PID docType
  namespace: 'eu.europa.ec.eudi.pid.1', // POC Profile: single standard namespace
  vct: 'https://credentials.benin.example/pid' // POC Profile: PID SD-JWT vct
};

const BIRTH_CERTIFICATE = {
  docType: 'eu.europa.ec.eudi.birth_certificate.1', // POC Profile: BC docType / namespace
  namespace: 'eu.europa.ec.eudi.birth_certificate.1',
  vcts: config.BIRTH_CERT_VCTS
};

const ISSUING_COUNTRY = 'BJ';
const ISSUING_AUTHORITY = 'ANIP';

// ISO/IEC 5218 (Code Lists sheet: only M/F are approved for the POC)
const GENDER_CODES = { 1: 'male', 2: 'female' };

/**
 * Relying party profiles. Claims are chosen from the "Verifier Matrix" sheet
 * with data minimisation in mind: portrait, address and
 * personal_administrative_number are NOT requested by default.
 */
const RELYING_PARTIES = {
  bedc: {
    id: 'bedc',
    credential: 'pid',
    format: 'mso_mdoc',
    docType: PID.docType,
    namespace: PID.namespace,
    // Verifier Matrix: "Identity verification" (PID)
    useCase: 'identity_verification',
    claims: [
      'family_name',
      'given_name',
      'birth_date',
      'nationality',
      'issuing_authority',
      'issuing_country',
      'expiry_date'
    ],
    // Claims that must be present for the login to succeed
    required: ['family_name', 'given_name', 'birth_date']
  },
  fda: {
    id: 'fda',
    credential: 'birth_certificate',
    format: 'dc+sd-jwt',
    vcts: BIRTH_CERTIFICATE.vcts,
    // Verifier Matrix: "Birth-date corroboration" (Birth Certificate part)
    useCase: 'birth_date_corroboration',
    claims: [
      'family_name',
      'given_name',
      'birth_date',
      'birth_place',
      'gender',
      'birth_record_reference',
      'issuing_authority',
      'issuance_date'
    ],
    required: ['family_name', 'given_name', 'birth_date', 'birth_record_reference']
  }
};

module.exports = {
  PID,
  BIRTH_CERTIFICATE,
  ISSUING_COUNTRY,
  ISSUING_AUTHORITY,
  GENDER_CODES,
  RELYING_PARTIES
};
