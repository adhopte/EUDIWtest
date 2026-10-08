package bj.anip.proximity.pos.pid

import org.multipaz.cbor.Bstr
import org.multipaz.cbor.Cbor
import org.multipaz.cbor.CborArray
import org.multipaz.cbor.DataItem
import org.multipaz.cbor.Nint
import org.multipaz.cbor.Simple
import org.multipaz.cbor.Tagged
import org.multipaz.cbor.Tstr
import org.multipaz.cbor.Uint
import org.multipaz.crypto.AsymmetricKey
import org.multipaz.crypto.EcPrivateKey
import org.multipaz.crypto.X509Cert
import org.multipaz.mdoc.devicesigned.DeviceAuth
import org.multipaz.mdoc.response.DeviceResponse
import org.multipaz.mdoc.response.MdocDocument
import org.multipaz.trustmanagement.TrustManager
import kotlin.time.Instant

/** Result of one verification step, shown on the POS "verification details" panel. */
enum class CheckStatus { PASS, FAIL, WARN, NOT_EVALUATED, SKIPPED_ONLINE }

enum class CheckId {
    RESPONSE,          // wallet returned a PID document
    ISSUER_SIGNATURE,  // COSE_Sign1 over the MSO, with the document signer certificate
    ISSUER_TRUST,      // document signer chains to a configured ANIP IACA trust anchor
    DOC_TYPE,          // docType = eu.europa.ec.eudi.pid.1 in document and MSO
    VALIDITY,          // MSO validFrom <= now <= validUntil
    DEVICE_AUTH,       // holder/device authentication (ECDSA signature or MAC) bound to this session
    DATA_INTEGRITY,    // each disclosed element matches its MSO digest (altered data is detected)
    REQUIRED_CLAIMS,   // name present
    AGE_OVER_18,       // age_over_18 result
    BENIN_PID,         // issuing_country = BJ / issuing_authority = ANIP (rulebook POC profile)
    REVOCATION,        // status list: needs the network, never simulated
}

data class Check(val id: CheckId, val status: CheckStatus, val detail: String? = null)

sealed interface ClaimValue {
    data class Text(val value: String) : ClaimValue
    data class Bool(val value: Boolean) : ClaimValue
    data class Image(val bytes: ByteArray) : ClaimValue {
        override fun equals(other: Any?) = other is Image && other.bytes.contentEquals(bytes)
        override fun hashCode() = bytes.contentHashCode()
    }
}

data class VerificationReport(
    val checks: List<Check>,
    val claims: Map<String, ClaimValue>,
    val issuerSubject: String?,
    val issuerRootSubject: String?,
    /** PEM of the top certificate of the issuer chain, offered for "trust this issuer" in demos. */
    val issuerRootPem: String?,
    val deviceAuthType: String?,
    val validFrom: Instant?,
    val validUntil: Instant?,
) {
    /** Identity is verified when no blocking check failed. */
    val verified: Boolean get() = checks.none { it.status == CheckStatus.FAIL }
    fun check(id: CheckId): Check? = checks.firstOrNull { it.id == id }
    val ageOver18: Boolean? get() = (claims["age_over_18"] as? ClaimValue.Bool)?.value
}

data class VerificationPolicy(
    val requireTrustedIssuer: Boolean = true,
    val requireAgeOver18: Boolean = false,
)

/**
 * Verifies an ISO/IEC 18013-5 DeviceResponse carrying the Benin PID (rulebook profile).
 * Everything here runs locally: issuer trust uses provisioned trust anchors and the
 * device clock, so identity verification works with the network switched off
 * (requirement FR-12). Only revocation needs a network and it is reported, not faked.
 */
class PidVerifier(
    private val trustManager: TrustManager,
    private val policy: VerificationPolicy,
) {
    suspend fun verify(
        deviceResponseBytes: ByteArray,
        sessionTranscriptBytes: ByteArray,
        eReaderKey: EcPrivateKey?,
        now: Instant,
        networkAvailable: Boolean,
    ): VerificationReport {
        val checks = mutableListOf<Check>()
        val response = try {
            DeviceResponse.fromDataItem(Cbor.decode(deviceResponseBytes))
        } catch (e: Throwable) {
            return failed(CheckId.RESPONSE, "Malformed DeviceResponse: ${e.message}")
        }

        // The library verifies, in this order: issuer signature, docType, validity,
        // device authentication, digests — and stops at the first failure.
        val verifyError: Throwable? = try {
            response.verify(
                sessionTranscript = Cbor.decode(sessionTranscriptBytes),
                eReaderKey = eReaderKey?.let { AsymmetricKey.anonymous(it, it.curve.defaultKeyAgreementAlgorithm) },
                atTime = now,
            )
            null
        } catch (e: Throwable) {
            e.cause ?: e
        }

        val document: MdocDocument? = response.documents.firstOrNull { it.docType == PidProfile.DOC_TYPE }
            ?: response.documents.firstOrNull()
        if (document == null) {
            val reason = if (response.documentErrors.isNotEmpty()) "Wallet declined or has no PID (${response.documentErrors})"
            else "No document returned (status ${response.status})"
            return failed(CheckId.RESPONSE, reason)
        }
        checks += Check(CheckId.RESPONSE, CheckStatus.PASS, "status ${response.status}")

        val failedStage = verifyError?.let { stageOf(it.message ?: "") }
        val stages = listOf(CheckId.ISSUER_SIGNATURE, CheckId.DOC_TYPE, CheckId.VALIDITY, CheckId.DEVICE_AUTH, CheckId.DATA_INTEGRITY)
        val failedIndex = failedStage?.let { stages.indexOf(it) } ?: -1
        val stageResults = stages.mapIndexed { i, id ->
            when {
                failedIndex == -1 || i < failedIndex -> Check(id, CheckStatus.PASS, stageDetail(id, document))
                i == failedIndex -> Check(id, CheckStatus.FAIL, verifyError?.message)
                else -> Check(id, CheckStatus.NOT_EVALUATED)
            }
        }
        // Order the checks the way a person reads them: issuer first, then the credential.
        checks += stageResults.first { it.id == CheckId.ISSUER_SIGNATURE }

        val chain = runCatching { document.issuerCertChain }.getOrNull()
        val trust = chain?.let { runCatching { trustManager.verify(it.certificates, now) }.getOrNull() }
        checks += when {
            chain == null -> Check(CheckId.ISSUER_TRUST, CheckStatus.FAIL, "No x5chain in issuerAuth")
            trust?.isTrusted == true -> Check(
                CheckId.ISSUER_TRUST, CheckStatus.PASS,
                trust.trustPoints.firstOrNull()?.metadata?.displayName ?: "trusted"
            )
            policy.requireTrustedIssuer -> Check(CheckId.ISSUER_TRUST, CheckStatus.FAIL, "Issuer not in the provisioned ANIP trust list")
            else -> Check(CheckId.ISSUER_TRUST, CheckStatus.WARN, "Issuer not in the trust list (accepted: demo policy)")
        }
        checks += stageResults.filter { it.id != CheckId.ISSUER_SIGNATURE }

        val claims = extractClaims(document)
        val missing = MerchantPidRequest.elements.filter { it.required && it.identifier !in claims }.map { it.identifier }
        checks += if (missing.isEmpty()) Check(CheckId.REQUIRED_CLAIMS, CheckStatus.PASS)
        else Check(CheckId.REQUIRED_CLAIMS, CheckStatus.FAIL, "Missing: ${missing.joinToString()}")

        val age = (claims["age_over_18"] as? ClaimValue.Bool)?.value
        checks += when {
            age == true -> Check(CheckId.AGE_OVER_18, CheckStatus.PASS, "age_over_18 = true")
            policy.requireAgeOver18 -> Check(
                CheckId.AGE_OVER_18, CheckStatus.FAIL,
                if (age == null) "age_over_18 not disclosed" else "Customer is under 18"
            )
            age == false -> Check(CheckId.AGE_OVER_18, CheckStatus.WARN, "age_over_18 = false")
            else -> Check(CheckId.AGE_OVER_18, CheckStatus.WARN, "age_over_18 not disclosed")
        }

        val country = (claims["issuing_country"] as? ClaimValue.Text)?.value
        val authority = (claims["issuing_authority"] as? ClaimValue.Text)?.value
        checks += if (country == PidProfile.ISSUING_COUNTRY) {
            Check(CheckId.BENIN_PID, CheckStatus.PASS, listOfNotNull(authority, country).joinToString(" · "))
        } else {
            Check(CheckId.BENIN_PID, CheckStatus.WARN, "issuing_country = ${country ?: "?"} (expected ${PidProfile.ISSUING_COUNTRY})")
        }

        // Requirements §9: online-only checks are identified, never simulated.
        checks += Check(
            CheckId.REVOCATION, CheckStatus.SKIPPED_ONLINE,
            if (networkAvailable) "Status list check not implemented in the PoC" else "Offline: status list cannot be fetched"
        )

        val certs = chain?.certificates.orEmpty()
        return VerificationReport(
            checks = checks,
            claims = claims,
            issuerSubject = certs.firstOrNull()?.subject?.name,
            issuerRootSubject = certs.lastOrNull()?.subject?.name,
            issuerRootPem = certs.lastOrNull()?.let { pemOf(it) },
            deviceAuthType = when (document.deviceAuth) {
                is DeviceAuth.Ecdsa -> "ECDSA"
                is DeviceAuth.Mac -> "MAC"
            },
            validFrom = runCatching { document.mso.validFrom }.getOrNull(),
            validUntil = runCatching { document.mso.validUntil }.getOrNull(),
        )
    }

    private fun failed(id: CheckId, reason: String) = VerificationReport(
        checks = listOf(Check(id, CheckStatus.FAIL, reason)),
        claims = emptyMap(), issuerSubject = null, issuerRootSubject = null, issuerRootPem = null,
        deviceAuthType = null, validFrom = null, validUntil = null,
    )

    private fun stageDetail(id: CheckId, document: MdocDocument): String? = when (id) {
        CheckId.DOC_TYPE -> document.docType
        CheckId.DEVICE_AUTH -> when (document.deviceAuth) {
            is DeviceAuth.Ecdsa -> "ECDSA device signature"
            is DeviceAuth.Mac -> "MAC (ECDH with reader key)"
        }
        CheckId.DATA_INTEGRITY -> "${document.issuerNamespaces.data.values.sumOf { it.size }} elements"
        else -> null
    }

    companion object {
        fun pemOf(cert: X509Cert): String {
            val b64 = java.util.Base64.getMimeEncoder(64, "\n".toByteArray())
                .encodeToString(cert.encoded.toByteArray())
            return "-----BEGIN CERTIFICATE-----\n$b64\n-----END CERTIFICATE-----\n"
        }

        /** Maps a Multipaz verification error to the stage that failed. */
        fun stageOf(message: String): CheckId = when {
            message.contains("Signature on MSO", ignoreCase = true) -> CheckId.ISSUER_SIGNATURE
            message.contains("docType", ignoreCase = true) -> CheckId.DOC_TYPE
            message.contains("MSO is not", ignoreCase = true) -> CheckId.VALIDITY
            message.contains("Device authentication", ignoreCase = true) ||
                message.contains("eReaderKey", ignoreCase = true) -> CheckId.DEVICE_AUTH
            message.contains("digest", ignoreCase = true) -> CheckId.DATA_INTEGRITY
            else -> CheckId.ISSUER_SIGNATURE
        }

        fun extractClaims(document: MdocDocument): Map<String, ClaimValue> =
            document.issuerNamespaces.data[PidProfile.NAMESPACE].orEmpty()
                .mapValues { (_, item) -> render(item.dataElementValue) }

        fun render(value: DataItem): ClaimValue = when (value) {
            is Tstr -> ClaimValue.Text(value.value)
            is Bstr -> ClaimValue.Image(value.value)
            is Simple -> when (value) {
                Simple.TRUE -> ClaimValue.Bool(true)
                Simple.FALSE -> ClaimValue.Bool(false)
                else -> ClaimValue.Text(value.toString())
            }
            is Tagged -> render(value.taggedItem) // full-date (1004) / tdate (0)
            is Uint -> ClaimValue.Text(value.value.toString())
            is Nint -> ClaimValue.Text("-${value.value}")
            is CborArray -> ClaimValue.Text(value.items.joinToString { (render(it) as? ClaimValue.Text)?.value ?: it.toString() })
            else -> ClaimValue.Text(value.toString())
        }
    }
}
