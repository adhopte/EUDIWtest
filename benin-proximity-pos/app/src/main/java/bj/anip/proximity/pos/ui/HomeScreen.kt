package bj.anip.proximity.pos.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Badge
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Contactless
import androidx.compose.material.icons.outlined.Nfc
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Science
import androidx.compose.material.icons.outlined.Storefront
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import bj.anip.proximity.pos.PosSettings
import bj.anip.proximity.pos.R
import bj.anip.proximity.pos.demo.DemoAnipIssuer.Tamper
import bj.anip.proximity.pos.pid.MerchantPidRequest

@Composable
fun HomeScreen(
    settings: PosSettings,
    online: Boolean,
    onNfc: () -> Unit,
    onQr: () -> Unit,
    onDemo: (Tamper) -> Unit,
) {
    Hero(
        badge = stringResource(R.string.badge),
        title = stringResource(R.string.header_title),
        subtitle = stringResource(R.string.header_subtitle),
        trailing = { NetworkChip(online) },
    )
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        // Merchant name + purchase amount
        AnipCard {
            CardTitle(Icons.Outlined.Storefront, stringResource(R.string.merchant_label), settings.merchantName)
            HorizontalDivider(color = Anip.Line)
            Text(stringResource(R.string.amount_label), style = MaterialTheme.typography.bodyMedium, color = Anip.InkMuted)
            Text(formatAmount(settings.amount, settings.currency, settings.language), style = MaterialTheme.typography.headlineLarge, color = Anip.BrandStrong)
        }

        // Identity required + requested PID attributes
        AnipCard {
            CardTitle(Icons.Outlined.Badge, stringResource(R.string.identity_required))
            Text(stringResource(R.string.identity_required_body), style = MaterialTheme.typography.bodyMedium)
            MerchantPidRequest.elements(settings.includePortrait).forEach { el ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.CheckCircle, null, tint = Anip.Brand, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(10.dp))
                    Text(stringResource(el.labelRes), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                    if (el.required) Text(stringResource(R.string.required_mark), style = MaterialTheme.typography.bodySmall, color = Anip.InkMuted)
                }
            }
            Text(stringResource(R.string.intent_note), style = MaterialTheme.typography.bodySmall, color = Anip.InkMuted)
        }

        // Tap / bring phone near POS
        AnipCard {
            CardTitle(Icons.Outlined.Contactless, stringResource(R.string.instruction_title))
            Text(stringResource(R.string.instruction_body), style = MaterialTheme.typography.bodyMedium)
            PrimaryButton(stringResource(R.string.btn_tap_nfc), onNfc, icon = Icons.Outlined.Nfc)
            SecondaryButton(stringResource(R.string.btn_scan_qr), onQr, icon = Icons.Outlined.QrCodeScanner)
        }

        // Demo without a phone (simulated issuer + wallet)
        AnipCard {
            CardTitle(Icons.Outlined.Science, stringResource(R.string.demo_section))
            Text(stringResource(R.string.demo_note), style = MaterialTheme.typography.bodySmall, color = Anip.InkMuted)
            Column(Modifier.fillMaxWidth()) {
                TextButton(onClick = { onDemo(Tamper.NONE) }) { Text(stringResource(R.string.btn_demo_valid), fontWeight = FontWeight.Bold, color = Anip.Brand) }
                TextButton(onClick = { onDemo(Tamper.ALTERED_NAME) }) { Text(stringResource(R.string.btn_demo_altered), color = Anip.Danger) }
                TextButton(onClick = { onDemo(Tamper.EXPIRED) }) { Text(stringResource(R.string.btn_demo_expired), color = Anip.Danger) }
            }
        }
    }
}

/** "15 000 FCFA" (XOF is shown as FCFA, the name used in Benin). */
fun formatAmount(amount: Long, currency: String, language: String): String {
    val grouped = java.text.NumberFormat.getIntegerInstance(java.util.Locale.FRANCE).format(amount).replace(' ', ' ').replace(' ', ' ')
    val unit = if (currency.equals("XOF", ignoreCase = true)) "FCFA" else currency
    return "$grouped $unit"
}
