package bj.anip.proximity.pos.demo

import bj.anip.proximity.pos.pid.PidProfile
import org.multipaz.asn1.ASN1Integer
import org.multipaz.cbor.Bstr
import org.multipaz.cbor.Cbor
import org.multipaz.cbor.DataItem
import org.multipaz.cbor.Tagged
import org.multipaz.cbor.Tstr
import org.multipaz.cbor.buildCborArray
import org.multipaz.cbor.toDataItem
import org.multipaz.cose.Cose
import org.multipaz.cose.CoseLabel
import org.multipaz.cose.CoseNumberLabel
import org.multipaz.crypto.Algorithm
import org.multipaz.crypto.AsymmetricKey
import org.multipaz.crypto.Crypto
import org.multipaz.crypto.EcCurve
import org.multipaz.crypto.X500Name
import org.multipaz.crypto.X509Cert
import org.multipaz.crypto.X509CertChain
import org.multipaz.mdoc.devicesigned.DeviceNamespaces
import org.multipaz.mdoc.issuersigned.IssuerNamespaces
import org.multipaz.mdoc.issuersigned.IssuerSignedItem
import org.multipaz.mdoc.issuersigned.buildIssuerNamespaces
import org.multipaz.mdoc.mso.MobileSecurityObject
import org.multipaz.mdoc.response.DeviceResponse
import org.multipaz.mdoc.response.MdocDocument
import org.multipaz.mdoc.response.buildDeviceResponse
import org.multipaz.mdoc.util.MdocUtil
import kotlin.time.Clock
import kotlin.time.Duration.Companion.days
import kotlin.time.Instant

/**
 * DEMO ONLY: a simulated ANIP issuer plus holder wallet, so the full POS flow can
 * be shown (and tested) without a phone. It signs a rulebook-conformant PID mdoc
 * for the demo persona of the rulebook's "Benin Display Simulation" sheet and
 * presents it exactly as a wallet would (issuer-signed MSO, ECDSA DeviceAuth over
 * the session transcript). The presentation is done in-process, not over BLE.
 */
class DemoAnipIssuer private constructor(
    val iacaCert: X509Cert,
    private val dsKey: AsymmetricKey.X509Certified,
) {
    enum class Tamper { NONE, ALTERED_NAME, EXPIRED }

    /** Persona "KOSSI Jean" (rulebook Benin Display Simulation). */
    val persona: Map<String, DataItem> = linkedMapOf(
        "family_name" to Tstr("KOSSI"),
        "given_name" to Tstr("Jean"),
        "birth_date" to fullDate("1988-04-12"),
        "age_over_18" to true.toDataItem(),
        "nationality" to buildCborArray { add("BJ") },
        "document_number" to Tstr("CNIB123456789"),
        "issuance_date" to fullDate("2024-01-15"),
        "expiry_date" to fullDate("2034-01-14"),
        "issuing_authority" to Tstr(PidProfile.ISSUING_AUTHORITY),
        "issuing_country" to Tstr(PidProfile.ISSUING_COUNTRY),
        "personal_administrative_number" to Tstr("1234567890123"),
    )

    /**
     * Issues the PID and presents the requested elements as an encoded DeviceResponse
     * bound to [sessionTranscript]. [tamper] produces the negative cases of the
     * acceptance criteria ("invalid or altered credential data produces a failed result").
     */
    suspend fun present(
        itemsToRequest: Map<String, Map<String, Boolean>>,
        sessionTranscript: ByteArray,
        tamper: Tamper = Tamper.NONE,
        now: Instant = Clock.System.now(),
    ): ByteArray {
        val holderKey = Crypto.createEcPrivateKey(EcCurve.P256)
        val all = buildIssuerNamespaces {
            addNamespace(PidProfile.NAMESPACE) {
                persona.forEach { (name, value) -> addDataElement(name, value) }
            }
        }
        // MSO timestamps must be whole seconds (ISO 18013-5 tdate without fractions).
        val base = Instant.fromEpochSeconds(now.epochSeconds)
        val (validFrom, validUntil) = if (tamper == Tamper.EXPIRED) {
            (base - 400.days) to (base - 30.days)
        } else {
            (base - 1.days) to (base + 365.days)
        }
        val mso = MobileSecurityObject(
            version = "1.0",
            docType = PidProfile.DOC_TYPE,
            signedAt = validFrom,
            validFrom = validFrom,
            validUntil = validUntil,
            expectedUpdate = null,
            digestAlgorithm = Algorithm.SHA256,
            valueDigests = all.getValueDigests(Algorithm.SHA256),
            deviceKey = holderKey.publicKey,
        )
        val issuerAuth = Cose.coseSign1Sign(
            signingKey = dsKey,
            message = Cbor.encode(Tagged(Tagged.ENCODED_CBOR, Bstr(Cbor.encode(mso.toDataItem())))),
            includeMessageInPayload = true,
            protectedHeaders = mapOf<CoseLabel, DataItem>(
                CoseNumberLabel(Cose.COSE_LABEL_ALG) to Algorithm.ES256.coseAlgorithmIdentifier!!.toDataItem()
            ),
            unprotectedHeaders = mapOf<CoseLabel, DataItem>(
                CoseNumberLabel(Cose.COSE_LABEL_X5CHAIN) to dsKey.certChain.toDataItem()
            ),
        )
        // Selective disclosure: only the requested elements leave the "wallet".
        val disclosed = IssuerNamespaces(
            all.data.mapValues { (ns, items) ->
                items.filterKeys { itemsToRequest[ns]?.containsKey(it) == true }
                    .mapValues { (name, item) ->
                        if (tamper == Tamper.ALTERED_NAME && name == "family_name") {
                            IssuerSignedItem(item.digestId, item.random, item.dataElementIdentifier, Tstr("IMPOSTOR"))
                        } else item
                    }
            }.filterValues { it.isNotEmpty() }
        )
        val transcript = Cbor.decode(sessionTranscript)
        val document = MdocDocument.fromNamespaces(
            sessionTranscript = transcript,
            docType = PidProfile.DOC_TYPE,
            issuerAuth = issuerAuth,
            issuerNamespaces = disclosed,
            deviceNamespaces = DeviceNamespaces(emptyMap()),
            deviceKey = AsymmetricKey.anonymous(holderKey),
        )
        val response = buildDeviceResponse(sessionTranscript = transcript, status = DeviceResponse.STATUS_OK) {
            addDocument(document)
        }
        return Cbor.encode(response.toDataItem())
    }

    companion object {
        private fun fullDate(iso: String): DataItem = Tagged(1004, Tstr(iso))

        suspend fun create(): DemoAnipIssuer {
            val now = Instant.fromEpochSeconds(Clock.System.now().epochSeconds)
            val iacaKey = Crypto.createEcPrivateKey(EcCurve.P256)
            val iacaCert = MdocUtil.generateIacaCertificate(
                iacaKey = AsymmetricKey.AnonymousExplicit(iacaKey),
                subject = X500Name.fromName("C=BJ,O=ANIP (DEMO),CN=DEMO ANIP IACA (simulated)"),
                serial = ASN1Integer.fromRandom(128),
                validFrom = now - 1.days,
                validUntil = now + 3650.days,
                issuerAltNameUrl = "https://anip.bj",
                crlUrl = "https://anip.bj/crl",
            )
            val dsPrivate = Crypto.createEcPrivateKey(EcCurve.P256)
            val dsCert = MdocUtil.generateDsCertificate(
                iacaKey = AsymmetricKey.X509CertifiedExplicit(X509CertChain(listOf(iacaCert)), iacaKey),
                dsKey = dsPrivate.publicKey,
                subject = X500Name.fromName("C=BJ,O=ANIP (DEMO),CN=DEMO ANIP PID Document Signer"),
                serial = ASN1Integer.fromRandom(128),
                validFrom = now - 1.days,
                validUntil = now + 1825.days,
            )
            return DemoAnipIssuer(
                iacaCert = iacaCert,
                dsKey = AsymmetricKey.X509CertifiedExplicit(X509CertChain(listOf(dsCert)), dsPrivate),
            )
        }
    }
}
