package bj.anip.proximity.pos

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import bj.anip.proximity.pos.demo.DemoAnipIssuer
import bj.anip.proximity.pos.payment.IdentityContext
import bj.anip.proximity.pos.payment.PaymentRequest
import bj.anip.proximity.pos.payment.PaymentResult
import bj.anip.proximity.pos.pid.MerchantPidRequest
import bj.anip.proximity.pos.pid.PidVerifier
import bj.anip.proximity.pos.pid.ProximityReader
import bj.anip.proximity.pos.pid.ReaderStep
import bj.anip.proximity.pos.pid.VerificationPolicy
import bj.anip.proximity.pos.ui.Anip
import bj.anip.proximity.pos.ui.AnipTheme
import bj.anip.proximity.pos.ui.CompletedScreen
import bj.anip.proximity.pos.ui.GovernmentBar
import bj.anip.proximity.pos.ui.HomeScreen
import bj.anip.proximity.pos.ui.IdentityResultScreen
import bj.anip.proximity.pos.ui.PaymentScreen
import bj.anip.proximity.pos.ui.ReadingScreen
import bj.anip.proximity.pos.ui.SiteFooter
import bj.anip.proximity.pos.ui.SiteHeader
import bj.anip.proximity.pos.ui.TricolourStripe
import com.github.takahirom.roborazzi.captureRoboImage
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.multipaz.cbor.Bstr
import org.multipaz.cbor.Cbor
import org.multipaz.cbor.Simple
import org.multipaz.crypto.Crypto
import org.multipaz.crypto.EcCurve
import org.multipaz.storage.ephemeral.EphemeralStorage
import org.multipaz.trustmanagement.TrustManagerLocal
import org.multipaz.trustmanagement.TrustMetadata
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.time.Clock
import kotlin.time.Duration.Companion.milliseconds

/**
 * Renders every POS screen with the real ANIP theme (fonts, logos, colours) on the JVM,
 * using demo-issuer data, so the UI can be reviewed without a device.
 * Output: app/screenshots/<name>.png
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w412dp-h2600dp-xxhdpi")
class ScreenshotTest {

    @get:Rule val compose = createComposeRule()

    private val settings = PosSettings()

    private fun outcome(tamper: DemoAnipIssuer.Tamper, trusted: Boolean = true): IdentityOutcome = runBlocking {
        val issuer = DemoAnipIssuer.create()
        val eReaderKey = Crypto.createEcPrivateKey(EcCurve.P256)
        val transcript = ProximityReader.sessionTranscript(Cbor.encode(Bstr(byteArrayOf(1))), Simple.NULL, eReaderKey)
        val items = MerchantPidRequest.itemsToRequest(false)
        val trust = TrustManagerLocal(EphemeralStorage()).apply {
            if (trusted) addX509Cert(issuer.iacaCert, TrustMetadata(displayName = "DEMO ANIP IACA (simulated)"))
        }
        val report = PidVerifier(trust, VerificationPolicy()).verify(
            issuer.present(items, transcript, tamper), transcript, eReaderKey, Clock.System.now(), networkAvailable = false,
        )
        IdentityOutcome(report, "NFC", "BLE (central client mode)", 1840.milliseconds, offline = true)
    }

    private val request = PaymentRequest("TX-7F3A91C2", settings.merchantName, settings.amount, settings.currency, IdentityContext(true, true))

    private fun shoot(name: String, language: String = "en", content: @Composable () -> Unit) {
        compose.setContent {
            AnipTheme {
                Column(Modifier.fillMaxWidth().background(Anip.Page)) {
                    TricolourStripe()
                    GovernmentBar(language) {}
                    SiteHeader(onSettings = {})
                    content()
                    SiteFooter()
                }
            }
        }
        compose.onRoot().captureRoboImage("screenshots/$name.png")
    }

    @Test fun home() = shoot("1-home") { HomeScreen(settings, online = false, onNfc = {}, onQr = {}, onDemo = {}) }

    @Test fun reading() = shoot("2-reading") {
        ReadingScreen(listOf(ReaderStep.ENGAGEMENT, ReaderStep.CONNECTING, ReaderStep.REQUEST_SENT), verifying = false, onCancel = {})
    }

    @Test fun identityVerified() {
        val o = outcome(DemoAnipIssuer.Tamper.NONE)
        shoot("3-identity-verified") { IdentityResultScreen(o, {}, {}, {}, issuerJustTrusted = false) }
    }

    @Test fun identityAltered() {
        val o = outcome(DemoAnipIssuer.Tamper.ALTERED_NAME)
        shoot("3b-identity-altered") { IdentityResultScreen(o, {}, {}, {}, issuerJustTrusted = false) }
    }

    @Test fun identityUntrusted() {
        val o = outcome(DemoAnipIssuer.Tamper.NONE, trusted = false)
        shoot("3c-identity-untrusted") { IdentityResultScreen(o, {}, {}, {}, issuerJustTrusted = false) }
    }

    @Test fun payment() = shoot("4-payment") {
        PaymentScreen(request, "Simulated payment (demo)", "1234", "en", error = null, busy = false, onAuthorize = {}, onDecline = {})
    }

    @Test fun completed() {
        val o = outcome(DemoAnipIssuer.Tamper.NONE)
        shoot("5-completed") { CompletedScreen(o, request, PaymentResult.Authorized("K7QM2P", "Simulated payment (demo)"), onNew = {}) }
    }

    @Test @Config(qualifiers = "fr-w412dp-h2600dp-xxhdpi")
    fun homeFrench() = shoot("6-home-fr", language = "fr") { HomeScreen(settings.copy(language = "fr"), online = true, onNfc = {}, onQr = {}, onDemo = {}) }

    @Test @Config(qualifiers = "fr-w412dp-h2600dp-xxhdpi")
    fun completedFrench() {
        val o = outcome(DemoAnipIssuer.Tamper.NONE)
        shoot("7-completed-fr", language = "fr") { CompletedScreen(o, request, PaymentResult.Authorized("K7QM2P", "Paiement simulé (démo)"), onNew = {}) }
    }
}
