package bj.anip.proximity.pos.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.FileUpload
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import bj.anip.proximity.pos.PosSettings
import bj.anip.proximity.pos.R
import bj.anip.proximity.pos.pid.TrustStore

@Composable
fun SettingsScreen(
    initial: PosSettings,
    trustStore: TrustStore,
    onSave: (PosSettings) -> Unit,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    var s by remember { mutableStateOf(initial) }
    var amountText by remember { mutableStateOf(initial.amount.toString()) }
    var refresh by remember { mutableIntStateOf(0) }
    var message by remember { mutableStateOf<String?>(null) }
    val importedOk = stringResource(R.string.imported_ok)
    val importFailed = stringResource(R.string.import_failed)

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        message = runCatching {
            val text = context.contentResolver.openInputStream(uri)!!.bufferedReader().readText()
            val name = uri.lastPathSegment?.substringAfterLast('/')?.substringBeforeLast('.') ?: "issuer"
            importedOk.format(trustStore.import(text, name))
        }.getOrElse { importFailed.format(it.message) }
        refresh++
    }

    Hero(badge = stringResource(R.string.badge), title = stringResource(R.string.settings))
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        AnipCard {
            CardTitle(Icons.Outlined.Tune, stringResource(R.string.settings))
            OutlinedTextField(s.merchantName, { s = s.copy(merchantName = it) }, label = { Text(stringResource(R.string.settings_merchant)) }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            Row {
                OutlinedTextField(
                    amountText, { v -> amountText = v.filter(Char::isDigit).take(9) },
                    label = { Text(stringResource(R.string.settings_amount)) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.weight(1.4f), singleLine = true,
                )
                Spacer(Modifier.width(10.dp))
                OutlinedTextField(s.currency, { s = s.copy(currency = it.uppercase().take(3)) }, label = { Text(stringResource(R.string.settings_currency)) }, modifier = Modifier.weight(1f), singleLine = true)
            }
            OutlinedTextField(
                s.demoPin, { v -> s = s.copy(demoPin = v.filter(Char::isDigit).take(8)) },
                label = { Text(stringResource(R.string.settings_demo_pin)) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                modifier = Modifier.fillMaxWidth(), singleLine = true,
            )
            ToggleRow(stringResource(R.string.settings_require_trusted), s.requireTrustedIssuer) { s = s.copy(requireTrustedIssuer = it) }
            ToggleRow(stringResource(R.string.settings_require_age), s.requireAgeOver18) { s = s.copy(requireAgeOver18 = it) }
            ToggleRow(stringResource(R.string.settings_portrait), s.includePortrait) { s = s.copy(includePortrait = it) }
            PrimaryButton(stringResource(R.string.save), {
                onSave(s.copy(amount = amountText.toLongOrNull() ?: s.amount, demoPin = s.demoPin.ifBlank { "1234" }))
            })
        }

        AnipCard {
            CardTitle(Icons.Outlined.Shield, stringResource(R.string.settings_trust))
            val anchors = remember(refresh) { trustStore.anchors() }
            if (anchors.isEmpty()) {
                Text(stringResource(R.string.no_anchors), style = MaterialTheme.typography.bodyMedium, color = Anip.InkMuted)
            }
            anchors.forEach { a ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(a.label, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold)
                        Text(a.subject, style = MaterialTheme.typography.bodySmall, color = Anip.InkMuted)
                        Text(stringResource(sourceLabel(a.source)), style = MaterialTheme.typography.labelMedium, color = Anip.Brand)
                    }
                    if (a.source == TrustStore.Source.IMPORTED) {
                        TextButton(onClick = { trustStore.remove(a); refresh++ }) { Text(stringResource(R.string.remove), color = Anip.Danger) }
                    }
                }
                HorizontalDivider(color = Anip.Line)
            }
            message?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = Anip.BrandStrong) }
            SecondaryButton(stringResource(R.string.import_anchor), { picker.launch(arrayOf("*/*")) }, icon = Icons.Outlined.FileUpload)
        }
        SecondaryButton(stringResource(R.string.back), onBack)
    }
}

private fun sourceLabel(source: TrustStore.Source) = when (source) {
    TrustStore.Source.BUNDLED -> R.string.source_BUNDLED
    TrustStore.Source.IMPORTED -> R.string.source_IMPORTED
    TrustStore.Source.DEMO -> R.string.source_DEMO
}

@Composable
private fun ToggleRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        Switch(checked, onChange, colors = SwitchDefaults.colors(checkedTrackColor = Anip.Brand))
    }
}
