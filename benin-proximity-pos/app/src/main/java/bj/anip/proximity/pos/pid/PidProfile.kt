package bj.anip.proximity.pos.pid

import bj.anip.proximity.pos.R

/**
 * PID constants from the "Benin PID / Birth Certificate Rulebook v1.1
 * (Standard-Namespace Edition)" — sheets "POC Profile" and "PID mdoc".
 */
object PidProfile {
    /** POC Profile: single standard EUDI PID docType. */
    const val DOC_TYPE = "eu.europa.ec.eudi.pid.1"

    /** POC Profile: single standard namespace. */
    const val NAMESPACE = "eu.europa.ec.eudi.pid.1"

    /** POC Profile: issuing_country claim value. */
    const val ISSUING_COUNTRY = "BJ"

    /** POC Profile: issuing_authority claim value. */
    const val ISSUING_AUTHORITY = "ANIP"
}

/** One data element the POS requests from the wallet. */
data class RequestedElement(
    val identifier: String,
    val labelRes: Int,
    /** Must be present for identity verification to succeed. */
    val required: Boolean,
)

/**
 * The minimum PID data for the merchant scenario (requirements §3 step 2):
 * name, age-over-18 result and national-ID confirmation. Following the rulebook
 * Verifier Matrix ("Age > 18: prefer age_over_18 rather than birth_date"), the
 * birth date, address and personal_administrative_number (NPI) are NOT requested.
 * National-ID confirmation uses the CNIB document number plus the issuing
 * authority / country of the ANIP-issued PID.
 */
object MerchantPidRequest {
    val elements: List<RequestedElement> = listOf(
        RequestedElement("family_name", R.string.claim_family_name, required = true),
        RequestedElement("given_name", R.string.claim_given_name, required = true),
        RequestedElement("age_over_18", R.string.claim_age_over_18, required = false),
        RequestedElement("document_number", R.string.claim_document_number, required = false),
        RequestedElement("issuing_authority", R.string.claim_issuing_authority, required = false),
        RequestedElement("issuing_country", R.string.claim_issuing_country, required = false),
        RequestedElement("expiry_date", R.string.claim_expiry_date, required = false),
    )

    /** Optional: the cashier can match the customer's face (off by default, data minimisation). */
    val portrait = RequestedElement("portrait", R.string.claim_portrait, required = false)

    fun elements(includePortrait: Boolean): List<RequestedElement> =
        if (includePortrait) elements + portrait else elements

    /** Namespace → (element → intent_to_retain). The POS never retains PID data. */
    fun itemsToRequest(includePortrait: Boolean): Map<String, Map<String, Boolean>> =
        mapOf(PidProfile.NAMESPACE to elements(includePortrait).associate { it.identifier to false })
}
