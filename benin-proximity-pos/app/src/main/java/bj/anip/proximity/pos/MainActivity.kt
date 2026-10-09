package bj.anip.proximity.pos

import android.content.res.Configuration
import android.os.Bundle
import androidx.fragment.app.FragmentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import bj.anip.proximity.pos.ui.Anip
import bj.anip.proximity.pos.ui.AnipTheme
import bj.anip.proximity.pos.ui.CompletedScreen
import bj.anip.proximity.pos.ui.ErrorScreen
import bj.anip.proximity.pos.ui.GovernmentBar
import bj.anip.proximity.pos.ui.HomeScreen
import bj.anip.proximity.pos.ui.IdentityResultScreen
import bj.anip.proximity.pos.ui.PaymentScreen
import bj.anip.proximity.pos.ui.QrScanDialog
import bj.anip.proximity.pos.ui.ReadingScreen
import bj.anip.proximity.pos.ui.SettingsScreen
import bj.anip.proximity.pos.ui.SiteFooter
import bj.anip.proximity.pos.ui.SiteHeader
import bj.anip.proximity.pos.ui.TricolourStripe
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.multipaz.compose.permissions.rememberBluetoothEnabledState
import org.multipaz.compose.permissions.rememberBluetoothPermissionState
import org.multipaz.compose.prompt.PromptDialogs
import org.multipaz.context.initializeApplication
import org.multipaz.nfc.NfcTagReader
import org.multipaz.prompt.AndroidPromptModel
import org.multipaz.prompt.PromptModel
import java.util.Locale

// FragmentActivity (not ComponentActivity): Multipaz PromptDialogs hosts a BiometricPrompt and casts to it.
class MainActivity : FragmentActivity() {

    private val promptModel: PromptModel by lazy {
        AndroidPromptModel.Builder().apply { addCommonDialogs() }.build()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        initializeApplication(applicationContext)
        val controller = TransactionController(applicationContext, lifecycleScope)
        // NFC scanning finds the Multipaz prompt model in the coroutine context.
        val nfcScope = CoroutineScope(lifecycleScope.coroutineContext + promptModel)
        setContent {
            AnipTheme {
                Localized(controller.settings.language) {
                    PromptDialogs(promptModel = promptModel)
                    PosApp(controller, nfcScope)
                }
            }
        }
    }
}

/** EN / FR switch inside the app (falls back to the device language). */
@Composable
private fun Localized(language: String, content: @Composable () -> Unit) {
    val base = LocalContext.current
    if (language.isBlank()) return content()
    val locale = Locale.forLanguageTag(language)
    val config = Configuration(base.resources.configuration).apply { setLocale(locale) }
    val localized = remember(language) { base.createConfigurationContext(config) }
    CompositionLocalProvider(LocalContext provides localized, LocalConfiguration provides config) { content() }
}

@Composable
private fun PosApp(controller: TransactionController, nfcScope: CoroutineScope) {
    val scope = rememberCoroutineScope()
    val blePermission = rememberBluetoothPermissionState()
    val bleEnabled = rememberBluetoothEnabledState()
    var showQr by remember { mutableStateOf(false) }
    var pendingAction by remember { mutableStateOf<(() -> Unit)?>(null) }
    var issuerJustTrusted by remember { mutableStateOf(false) }
    val nfcMessage = stringResource(R.string.nfc_message)
    val noNfc = stringResource(R.string.error_no_nfc)
    val settings = controller.settings
    val language = settings.language.ifBlank { LocalConfiguration.current.locales[0].language }

    // Proximity needs Bluetooth permission + Bluetooth on (ISO 18013-5 BLE data transfer).
    fun withBluetooth(action: () -> Unit) {
        if (blePermission.isGranted && bleEnabled.isEnabled) action() else pendingAction = action
    }
    LaunchedEffect(blePermission.isGranted, bleEnabled.isEnabled) {
        if (blePermission.isGranted && bleEnabled.isEnabled) pendingAction?.let { pendingAction = null; it() }
    }

    val screen = controller.screen
    BackHandler(enabled = screen !is Screen.Home) { controller.home() }

    Column(
        Modifier.fillMaxSize().background(Anip.Page).systemBarsPadding().verticalScroll(rememberScrollState())
    ) {
        TricolourStripe()
        GovernmentBar(language) { code -> controller.updateSettings(settings.copy(language = code)) }
        SiteHeader(onSettings = if (screen is Screen.Home) ({ controller.openSettings() }) else null)
        when (screen) {
            Screen.Home -> HomeScreen(
                settings = settings,
                online = controller.online,
                onNfc = {
                    if (NfcTagReader.getReaders().isEmpty()) controller.showError(noNfc)
                    else withBluetooth { controller.startNfc(nfcScope, nfcMessage) }
                },
                onQr = { withBluetooth { showQr = true } },
                onDemo = { tamper -> issuerJustTrusted = false; controller.startDemo(tamper) },
            )
            is Screen.Reading -> ReadingScreen(screen.steps, screen.verifying, onCancel = { controller.home() })
            is Screen.IdentityResult -> IdentityResultScreen(
                outcome = screen.outcome,
                onContinue = { controller.startPayment(screen.outcome) },
                onTrustIssuer = { issuerJustTrusted = controller.trustIssuerOf(screen.outcome) },
                onRetry = { issuerJustTrusted = false; controller.home() },
                issuerJustTrusted = issuerJustTrusted,
            )
            is Screen.Payment -> PaymentScreen(
                request = screen.request,
                providerName = controller.paymentProviderName,
                demoPin = settings.demoPin,
                language = language,
                error = screen.error,
                busy = screen.busy,
                onAuthorize = { pin -> controller.authorize(pin) },
                onDecline = { controller.declinePayment() },
            )
            is Screen.Completed -> CompletedScreen(screen.outcome, screen.request, screen.payment, onNew = { controller.home() })
            is Screen.Error -> ErrorScreen(screen.message, onRetry = { controller.home() })
            Screen.Settings -> SettingsScreen(
                initial = settings,
                trustStore = controller.trustStore,
                onSave = { controller.updateSettings(it); controller.home() },
                onBack = { controller.home() },
            )
        }
        SiteFooter()
    }

    if (showQr) {
        QrScanDialog(
            onScanned = { code -> showQr = false; controller.startQr(code) },
            onDismiss = { showQr = false },
        )
    }

    if (pendingAction != null && !(blePermission.isGranted && bleEnabled.isEnabled)) {
        AlertDialog(
            onDismissRequest = { pendingAction = null },
            title = { Text(stringResource(R.string.perm_title), style = MaterialTheme.typography.titleLarge) },
            text = { Text(stringResource(R.string.perm_body)) },
            confirmButton = {
                TextButton(onClick = {
                    scope.launch {
                        if (!blePermission.isGranted) blePermission.launchPermissionRequest()
                        else bleEnabled.enable()
                    }
                }) {
                    Text(
                        stringResource(if (!blePermission.isGranted) R.string.grant else R.string.enable_bt),
                        color = Anip.Brand, modifier = Modifier.padding(4.dp),
                    )
                }
            },
            dismissButton = { TextButton(onClick = { pendingAction = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}
