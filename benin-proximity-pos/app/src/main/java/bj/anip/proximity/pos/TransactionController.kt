package bj.anip.proximity.pos

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import bj.anip.proximity.pos.demo.DemoAnipIssuer
import bj.anip.proximity.pos.payment.CustomerAuthorization
import bj.anip.proximity.pos.payment.IdentityContext
import bj.anip.proximity.pos.payment.PaymentGateway
import bj.anip.proximity.pos.payment.PaymentRequest
import bj.anip.proximity.pos.payment.PaymentResult
import bj.anip.proximity.pos.payment.SimulatedPaymentGateway
import bj.anip.proximity.pos.pid.MerchantPidRequest
import bj.anip.proximity.pos.pid.PidVerifier
import bj.anip.proximity.pos.pid.ProximityException
import bj.anip.proximity.pos.pid.ProximityReader
import bj.anip.proximity.pos.pid.ProximityResult
import bj.anip.proximity.pos.pid.ReaderStep
import bj.anip.proximity.pos.pid.TrustStore
import bj.anip.proximity.pos.pid.VerificationPolicy
import bj.anip.proximity.pos.pid.VerificationReport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.multipaz.cbor.Bstr
import org.multipaz.cbor.Cbor
import org.multipaz.cbor.Simple
import org.multipaz.crypto.Crypto
import org.multipaz.crypto.EcCurve
import java.security.SecureRandom
import kotlin.time.Clock
import kotlin.time.Duration

/** The POS screens (requirements §3 user journey and §6 demo UI). */
sealed interface Screen {
    data object Home : Screen
    data class Reading(val steps: List<ReaderStep>, val verifying: Boolean) : Screen
    data class IdentityResult(val outcome: IdentityOutcome) : Screen
    data class Payment(val outcome: IdentityOutcome, val request: PaymentRequest, val error: String? = null, val busy: Boolean = false) : Screen
    data class Completed(val outcome: IdentityOutcome, val request: PaymentRequest, val payment: PaymentResult) : Screen
    data class Error(val message: String) : Screen
    data object Settings : Screen
}

data class IdentityOutcome(
    val report: VerificationReport,
    val engagement: String,
    val transport: String,
    val duration: Duration?,
    val offline: Boolean,
)

class TransactionController(private val context: Context, private val scope: CoroutineScope) {
    var settings by mutableStateOf(PosSettings.load(context)); private set
    var screen by mutableStateOf<Screen>(Screen.Home); private set
    var online by mutableStateOf(isOnline()); private set

    val trustStore = TrustStore(context)
    private val reader = ProximityReader()
    private var demoIssuer: DemoAnipIssuer? = null
    private var gateway: PaymentGateway = SimulatedPaymentGateway(settings.demoPin)
    private var job: Job? = null
    private val random = SecureRandom()

    init {
        context.getSystemService(ConnectivityManager::class.java)?.registerDefaultNetworkCallback(
            object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) { online = isOnline() }
                override fun onLost(network: Network) { online = isOnline() }
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) { online = isOnline() }
            }
        )
    }

    private fun isOnline(): Boolean {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    fun updateSettings(s: PosSettings) {
        settings = s
        PosSettings.save(context, s)
        gateway = SimulatedPaymentGateway(s.demoPin)
    }

    fun openSettings() { screen = Screen.Settings }
    fun showError(message: String) { screen = Screen.Error(message) }
    fun home() { job?.cancel(); screen = Screen.Home }

    private val items get() = MerchantPidRequest.itemsToRequest(settings.includePortrait)

    /** Engagement from the wallet's QR code ("mdoc:…"). */
    fun startQr(qrText: String) = run { onStep -> reader.readFromQr(qrText, items, onStep) }

    /** Engagement by NFC tap. Must run with the Multipaz prompt model in the coroutine context. */
    fun startNfc(scopeWithPrompt: CoroutineScope, message: String) =
        run(scopeWithPrompt) { onStep -> reader.readFromNfc(message, items, onStep) }

    /** Demo without a phone: simulated ANIP issuer + wallet, same verifier. */
    fun startDemo(tamper: DemoAnipIssuer.Tamper) = run { onStep ->
        val issuer = demoIssuer ?: DemoAnipIssuer.create().also {
            demoIssuer = it
            trustStore.addDemoAnchor(PidVerifier.pemOf(it.iacaCert), "DEMO ANIP IACA (simulated)")
        }
        onStep(ReaderStep.ENGAGEMENT)
        val eReaderKey = Crypto.createEcPrivateKey(EcCurve.P256)
        val engagement = Cbor.encode(Bstr(byteArrayOf(1, 2, 3)))
        val transcript = ProximityReader.sessionTranscript(engagement, Simple.NULL, eReaderKey)
        onStep(ReaderStep.CONNECTING); onStep(ReaderStep.REQUEST_SENT); onStep(ReaderStep.WAITING_CONSENT)
        val response = issuer.present(items, transcript, tamper)
        onStep(ReaderStep.RESPONSE_RECEIVED)
        ProximityResult(response, transcript, eReaderKey, "Demo (simulated wallet)", "In-app", engagementToResponse = Duration.ZERO)
    }

    private fun run(
        launchScope: CoroutineScope = scope,
        read: suspend (onStep: (ReaderStep) -> Unit) -> ProximityResult?,
    ) {
        job?.cancel()
        val steps = mutableListOf<ReaderStep>()
        screen = Screen.Reading(emptyList(), verifying = false)
        job = launchScope.launch {
            try {
                val result = read { step ->
                    if (step !in steps) steps += step
                    screen = Screen.Reading(steps.toList(), verifying = false)
                } ?: run { screen = Screen.Home; return@launch }
                screen = Screen.Reading(steps.toList(), verifying = true)
                val offline = !online
                val report = PidVerifier(
                    trustStore.trustManager(),
                    VerificationPolicy(settings.requireTrustedIssuer, settings.requireAgeOver18),
                ).verify(result.deviceResponse, result.sessionTranscript, result.eReaderKey, Clock.System.now(), networkAvailable = !offline)
                screen = Screen.IdentityResult(
                    IdentityOutcome(report, result.engagement, result.transport,
                        result.engagementToResponse.takeIf { it > Duration.ZERO }, offline)
                )
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: ProximityException) {
                screen = Screen.Error(e.message ?: "Error")
            } catch (e: Throwable) {
                screen = Screen.Error(e.message ?: e::class.simpleName ?: "Error")
            }
        }
    }

    /** Demo only: trust the issuer root presented in the last transaction. */
    fun trustIssuerOf(outcome: IdentityOutcome): Boolean {
        val pem = outcome.report.issuerRootPem ?: return false
        return runCatching { trustStore.import(pem, outcome.report.issuerRootSubject ?: "issuer") > 0 }.getOrDefault(false)
    }

    /** FR-09: identity verified → payment hand-off with the minimum context only. */
    fun startPayment(outcome: IdentityOutcome) {
        if (!outcome.report.verified) return
        val reference = "TX-" + (1..8).map { "0123456789ABCDEF"[random.nextInt(16)] }.joinToString("")
        screen = Screen.Payment(
            outcome,
            PaymentRequest(
                reference = reference,
                merchantName = settings.merchantName,
                amount = settings.amount,
                currency = settings.currency,
                identity = IdentityContext(identityVerified = true, ageOver18 = outcome.report.ageOver18),
            ),
        )
    }

    val paymentProviderName get() = gateway.displayName

    /** FR-10: called only after the customer explicitly confirmed with their PIN. */
    fun authorize(pin: String) {
        val current = screen as? Screen.Payment ?: return
        screen = current.copy(busy = true, error = null)
        job = scope.launch {
            when (val result = gateway.authorize(current.request, CustomerAuthorization(pin))) {
                is PaymentResult.Authorized -> screen = Screen.Completed(current.outcome, current.request, result)
                is PaymentResult.Declined -> screen = if ((result.attemptsLeft ?: 0) > 0) {
                    current.copy(busy = false, error = "wrong_pin:${result.attemptsLeft}")
                } else {
                    Screen.Completed(current.outcome, current.request, result)
                }
            }
        }
    }

    fun declinePayment() {
        val current = screen as? Screen.Payment ?: return
        screen = Screen.Completed(current.outcome, current.request, PaymentResult.Declined("Declined by customer"))
    }
}
