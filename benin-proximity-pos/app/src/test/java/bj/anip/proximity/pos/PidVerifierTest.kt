package bj.anip.proximity.pos

import bj.anip.proximity.pos.demo.DemoAnipIssuer
import bj.anip.proximity.pos.demo.DemoAnipIssuer.Tamper
import bj.anip.proximity.pos.pid.CheckId
import bj.anip.proximity.pos.pid.CheckStatus
import bj.anip.proximity.pos.pid.ClaimValue
import bj.anip.proximity.pos.pid.MerchantPidRequest
import bj.anip.proximity.pos.pid.PidVerifier
import bj.anip.proximity.pos.pid.ProximityReader
import bj.anip.proximity.pos.pid.VerificationPolicy
import bj.anip.proximity.pos.pid.VerificationReport
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.multipaz.cbor.Bstr
import org.multipaz.cbor.Cbor
import org.multipaz.cbor.Simple
import org.multipaz.crypto.Crypto
import org.multipaz.crypto.EcCurve
import org.multipaz.storage.ephemeral.EphemeralStorage
import org.multipaz.trustmanagement.TrustManager
import org.multipaz.trustmanagement.TrustManagerLocal
import org.multipaz.trustmanagement.TrustMetadata
import kotlin.time.Clock

/**
 * Acceptance criteria of the Proximity PID + Payment requirements:
 * "POS produces a cryptographic verification result" and
 * "Invalid or altered credential data produces a failed verification result".
 */
class PidVerifierTest {

    private val request = MerchantPidRequest.itemsToRequest(includePortrait = false)

    private suspend fun transcript(): ByteArray {
        // A real reader transcript: [DeviceEngagementBytes, EReaderKeyBytes, Handover]
        val engagement = Cbor.encode(Bstr(Crypto.createEcPrivateKey(EcCurve.P256).publicKey.toCoseKey().toDataItem().let { Cbor.encode(it) }))
        return ProximityReader.sessionTranscript(engagement, Simple.NULL, Crypto.createEcPrivateKey(EcCurve.P256))
    }

    private suspend fun trust(issuer: DemoAnipIssuer?): TrustManager = TrustManagerLocal(EphemeralStorage()).apply {
        if (issuer != null) addX509Cert(issuer.iacaCert, TrustMetadata(displayName = "DEMO ANIP IACA"))
    }

    private suspend fun verify(
        issuer: DemoAnipIssuer,
        tamper: Tamper = Tamper.NONE,
        trusted: Boolean = true,
        policy: VerificationPolicy = VerificationPolicy(),
        presentedTranscript: ByteArray? = null,
    ): VerificationReport {
        val sessionTranscript = transcript()
        val response = issuer.present(request, presentedTranscript ?: sessionTranscript, tamper)
        return PidVerifier(trust(if (trusted) issuer else null), policy).verify(
            deviceResponseBytes = response,
            sessionTranscriptBytes = sessionTranscript,
            eReaderKey = null,
            now = Clock.System.now(),
            networkAvailable = false,
        )
    }

    private fun VerificationReport.status(id: CheckId) = check(id)?.status

    @Test
    fun genuinePidIsVerifiedOffline() = runTest {
        val report = verify(DemoAnipIssuer.create())
        assertTrue(report.checks.toString(), report.verified)
        for (id in listOf(
            CheckId.RESPONSE, CheckId.ISSUER_SIGNATURE, CheckId.ISSUER_TRUST, CheckId.DOC_TYPE,
            CheckId.VALIDITY, CheckId.DEVICE_AUTH, CheckId.DATA_INTEGRITY, CheckId.REQUIRED_CLAIMS,
            CheckId.AGE_OVER_18, CheckId.BENIN_PID,
        )) assertEquals(id.name, CheckStatus.PASS, report.status(id))
        // Online-only check is reported, never simulated
        assertEquals(CheckStatus.SKIPPED_ONLINE, report.status(CheckId.REVOCATION))
        assertEquals(ClaimValue.Text("KOSSI"), report.claims["family_name"])
        assertEquals(true, report.ageOver18)
        assertEquals("ECDSA", report.deviceAuthType)
    }

    @Test
    fun onlyRequestedAttributesAreDisclosed() = runTest {
        val report = verify(DemoAnipIssuer.create())
        assertEquals(MerchantPidRequest.elements.map { it.identifier }.toSet(), report.claims.keys)
        assertNull("NPI must not be disclosed", report.claims["personal_administrative_number"])
        assertNull("birth date must not be disclosed", report.claims["birth_date"])
    }

    @Test
    fun alteredDataFailsIntegrity() = runTest {
        val report = verify(DemoAnipIssuer.create(), tamper = Tamper.ALTERED_NAME)
        assertFalse(report.verified)
        assertEquals(CheckStatus.FAIL, report.status(CheckId.DATA_INTEGRITY))
    }

    @Test
    fun expiredCredentialFailsValidity() = runTest {
        val report = verify(DemoAnipIssuer.create(), tamper = Tamper.EXPIRED)
        assertFalse(report.verified)
        assertEquals(CheckStatus.FAIL, report.status(CheckId.VALIDITY))
        // Later stages are reported as not evaluated rather than passed
        assertEquals(CheckStatus.NOT_EVALUATED, report.status(CheckId.DEVICE_AUTH))
    }

    @Test
    fun untrustedIssuerFailsWhenRequired() = runTest {
        val strict = verify(DemoAnipIssuer.create(), trusted = false)
        assertFalse(strict.verified)
        assertEquals(CheckStatus.FAIL, strict.status(CheckId.ISSUER_TRUST))
        assertTrue(strict.issuerRootPem!!.startsWith("-----BEGIN CERTIFICATE-----"))

        val lenient = verify(DemoAnipIssuer.create(), trusted = false, policy = VerificationPolicy(requireTrustedIssuer = false))
        assertTrue(lenient.verified)
        assertEquals(CheckStatus.WARN, lenient.status(CheckId.ISSUER_TRUST))
    }

    @Test
    fun presentationForAnotherSessionFailsDeviceAuth() = runTest {
        // A response captured in another session (replay) is not bound to this session transcript.
        val report = verify(DemoAnipIssuer.create(), presentedTranscript = transcript())
        assertFalse(report.verified)
        assertEquals(CheckStatus.FAIL, report.status(CheckId.DEVICE_AUTH))
    }

    @Test
    fun ageRequirementIsEnforcedWhenEnabled() = runTest {
        val report = verify(DemoAnipIssuer.create(), policy = VerificationPolicy(requireAgeOver18 = true))
        assertTrue(report.verified)
        assertEquals(CheckStatus.PASS, report.status(CheckId.AGE_OVER_18))
    }

    @Test
    fun malformedResponseFailsCleanly() = runTest {
        val report = PidVerifier(trust(null), VerificationPolicy()).verify(
            byteArrayOf(1, 2, 3), transcript(), null, Clock.System.now(), networkAvailable = true,
        )
        assertFalse(report.verified)
        assertEquals(CheckStatus.FAIL, report.status(CheckId.RESPONSE))
    }
}
