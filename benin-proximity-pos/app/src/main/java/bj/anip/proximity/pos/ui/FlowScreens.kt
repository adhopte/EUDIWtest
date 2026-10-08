package bj.anip.proximity.pos.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Cancel
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Payments
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.ReportProblem
import androidx.compose.material.icons.outlined.Verified
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import bj.anip.proximity.pos.IdentityOutcome
import bj.anip.proximity.pos.R
import bj.anip.proximity.pos.payment.PaymentRequest
import bj.anip.proximity.pos.payment.PaymentResult
import bj.anip.proximity.pos.pid.CheckId
import bj.anip.proximity.pos.pid.CheckStatus
import bj.anip.proximity.pos.pid.ClaimValue
import bj.anip.proximity.pos.pid.MerchantPidRequest
import bj.anip.proximity.pos.pid.ReaderStep

/* ------------------------------------------------------------------ reading */

@Composable
fun ReadingScreen(steps: List<ReaderStep>, verifying: Boolean, onCancel: () -> Unit) {
    Hero(badge = stringResource(R.string.badge), title = stringResource(R.string.progress_title))
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        AnipCard {
            val all = ReaderStep.entries.map { stringResource(stepLabel(it)) } + stringResource(R.string.step_VERIFYING)
            val doneCount = steps.size
            all.forEachIndexed { i, label ->
                val done = i < doneCount || (verifying && i < all.size - 1)
                val current = !done && (i == doneCount || (verifying && i == all.size - 1))
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 4.dp)) {
                    when {
                        done -> Icon(Icons.Outlined.CheckCircle, null, tint = Anip.Brand, modifier = Modifier.size(26.dp))
                        current -> CircularProgressIndicator(color = Anip.Brand, strokeWidth = 3.dp, modifier = Modifier.size(24.dp))
                        else -> StepDot({ Text("${i + 1}", style = MaterialTheme.typography.labelSmall) }, color = Anip.Line)
                    }
                    Spacer(Modifier.width(14.dp))
                    Text(
                        label, style = MaterialTheme.typography.bodyLarge,
                        fontWeight = if (current) FontWeight.Bold else FontWeight.Normal,
                        color = if (done || current) Anip.Ink else Anip.InkMuted,
                    )
                }
            }
        }
        SecondaryButton(stringResource(R.string.cancel), onCancel)
    }
}

private fun stepLabel(step: ReaderStep) = when (step) {
    ReaderStep.ENGAGEMENT -> R.string.step_ENGAGEMENT
    ReaderStep.CONNECTING -> R.string.step_CONNECTING
    ReaderStep.REQUEST_SENT -> R.string.step_REQUEST_SENT
    ReaderStep.WAITING_CONSENT -> R.string.step_WAITING_CONSENT
    ReaderStep.RESPONSE_RECEIVED -> R.string.step_RESPONSE_RECEIVED
}

/* ------------------------------------------------------------ identity result */

@Composable
fun IdentityResultScreen(
    outcome: IdentityOutcome,
    onContinue: () -> Unit,
    onTrustIssuer: () -> Unit,
    onRetry: () -> Unit,
    issuerJustTrusted: Boolean,
) {
    val report = outcome.report
    StatusBanner(ok = report.verified, text = stringResource(if (report.verified) R.string.identity_verified else R.string.identity_failed))
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        if (report.claims.isNotEmpty()) PersonCard(report.claims, verified = report.verified)
        if (report.verified) {
            PrimaryButton(stringResource(R.string.continue_payment), onContinue, icon = Icons.Outlined.Payments)
        }
        ChecksCard(outcome)
        val trustFailed = report.check(CheckId.ISSUER_TRUST)?.status == CheckStatus.FAIL
        if (trustFailed && report.issuerRootPem != null) {
            AnipCard {
                Text(stringResource(R.string.trust_this_issuer_note), style = MaterialTheme.typography.bodySmall, color = Anip.InkMuted)
                Text(report.issuerRootSubject ?: "", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
                if (issuerJustTrusted) {
                    Text(stringResource(R.string.issuer_trusted_now), color = Anip.Brand, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
                } else {
                    SecondaryButton(stringResource(R.string.trust_this_issuer), onTrustIssuer)
                }
            }
        }
        if (!report.verified) SecondaryButton(stringResource(R.string.retry), onRetry)
    }
}

@Composable
fun StatusBanner(ok: Boolean, text: String) {
    Row(
        Modifier.fillMaxWidth().background(if (ok) Anip.heroGradient else androidx.compose.ui.graphics.SolidColor(Anip.Danger))
            .padding(horizontal = 16.dp, vertical = 22.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(if (ok) Icons.Outlined.Verified else Icons.Outlined.ReportProblem, null, tint = if (ok) Anip.Accent else Color.White, modifier = Modifier.size(40.dp))
        Spacer(Modifier.width(14.dp))
        Text(text, style = MaterialTheme.typography.headlineMedium, color = Color.White)
    }
}

@Composable
fun PersonCard(claims: Map<String, ClaimValue>, verified: Boolean = true) {
    AnipCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            val portrait = (claims["portrait"] as? ClaimValue.Image)?.bytes?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
            if (portrait != null) {
                Image(portrait.asImageBitmap(), null, modifier = Modifier.size(72.dp).clip(RoundedCornerShape(10.dp)))
            } else {
                IconTile(Icons.Outlined.Person, 56.dp)
            }
            Spacer(Modifier.width(14.dp))
            Column {
                Text(
                    stringResource(if (verified) R.string.verified_person else R.string.presented_person),
                    style = MaterialTheme.typography.labelSmall, color = if (verified) Anip.InkMuted else Anip.Danger,
                )
                val given = (claims["given_name"] as? ClaimValue.Text)?.value.orEmpty()
                val family = (claims["family_name"] as? ClaimValue.Text)?.value.orEmpty()
                Text("$given $family".trim(), style = MaterialTheme.typography.headlineSmall)
            }
        }
        HorizontalDivider(color = Anip.Line)
        MerchantPidRequest.elements(includePortrait = false)
            .filter { it.identifier !in setOf("family_name", "given_name") && it.identifier in claims }
            .forEach { el -> KeyValue(stringResource(el.labelRes), claimText(claims.getValue(el.identifier))) }
    }
}

@Composable
private fun claimText(value: ClaimValue): String = when (value) {
    is ClaimValue.Bool -> stringResource(if (value.value) R.string.yes else R.string.no)
    is ClaimValue.Text -> value.value
    is ClaimValue.Image -> "[image ${value.bytes.size} B]"
}

@Composable
fun KeyValue(key: String, value: String) {
    Row(Modifier.fillMaxWidth()) {
        Text(key, style = MaterialTheme.typography.bodyMedium, color = Anip.InkMuted, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.End, modifier = Modifier.weight(1.2f))
    }
}

@Composable
fun ChecksCard(outcome: IdentityOutcome) {
    AnipCard {
        Text(stringResource(R.string.verification_details), style = MaterialTheme.typography.titleMedium)
        outcome.report.checks.forEach { check ->
            Row(verticalAlignment = Alignment.Top, modifier = Modifier.padding(vertical = 3.dp)) {
                StatusIcon(check.status)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(stringResource(checkLabel(check.id)), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold)
                    Text(
                        listOfNotNull(stringResource(statusLabel(check.status)), check.detail).joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall, color = Anip.InkMuted,
                    )
                }
            }
        }
        HorizontalDivider(color = Anip.Line)
        KeyValue(stringResource(R.string.engagement_label), outcome.engagement)
        KeyValue(stringResource(R.string.transport_label), outcome.transport)
        outcome.duration?.let { KeyValue(stringResource(R.string.duration_label), "${it.inWholeMilliseconds} ms") }
        outcome.report.issuerSubject?.let { KeyValue(stringResource(R.string.issuer_label), it) }
        if (outcome.report.validFrom != null && outcome.report.validUntil != null) {
            KeyValue(stringResource(R.string.valid_label), "${outcome.report.validFrom.toString().take(10)} → ${outcome.report.validUntil.toString().take(10)}")
        }
        if (outcome.offline && outcome.report.verified) {
            Text(stringResource(R.string.offline_note), style = MaterialTheme.typography.bodySmall, color = Anip.Brand, fontWeight = FontWeight.SemiBold)
        }
    }
}

fun checkLabel(id: CheckId) = when (id) {
    CheckId.RESPONSE -> R.string.check_RESPONSE
    CheckId.ISSUER_SIGNATURE -> R.string.check_ISSUER_SIGNATURE
    CheckId.ISSUER_TRUST -> R.string.check_ISSUER_TRUST
    CheckId.DOC_TYPE -> R.string.check_DOC_TYPE
    CheckId.VALIDITY -> R.string.check_VALIDITY
    CheckId.DEVICE_AUTH -> R.string.check_DEVICE_AUTH
    CheckId.DATA_INTEGRITY -> R.string.check_DATA_INTEGRITY
    CheckId.REQUIRED_CLAIMS -> R.string.check_REQUIRED_CLAIMS
    CheckId.AGE_OVER_18 -> R.string.check_AGE_OVER_18
    CheckId.BENIN_PID -> R.string.check_BENIN_PID
    CheckId.REVOCATION -> R.string.check_REVOCATION
}

fun statusLabel(status: CheckStatus) = when (status) {
    CheckStatus.PASS -> R.string.status_PASS
    CheckStatus.FAIL -> R.string.status_FAIL
    CheckStatus.WARN -> R.string.status_WARN
    CheckStatus.NOT_EVALUATED -> R.string.status_NOT_EVALUATED
    CheckStatus.SKIPPED_ONLINE -> R.string.status_SKIPPED_ONLINE
}

/* ------------------------------------------------------------------ payment */

@Composable
fun PaymentScreen(
    request: PaymentRequest,
    providerName: String,
    demoPin: String,
    language: String,
    error: String?,
    busy: Boolean,
    onAuthorize: (String) -> Unit,
    onDecline: () -> Unit,
) {
    var pin by remember(request.reference) { mutableStateOf("") }
    Hero(badge = stringResource(R.string.result_identity) + " ✓", title = stringResource(R.string.payment_title), subtitle = stringResource(R.string.payment_body))
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        AnipCard {
            Text(request.merchantName, style = MaterialTheme.typography.titleMedium)
            Text(formatAmount(request.amount, request.currency, language), style = MaterialTheme.typography.headlineLarge, color = Anip.BrandStrong)
            KeyValue(stringResource(R.string.reference), request.reference)
            KeyValue(stringResource(R.string.payment_provider), providerName)
            Text(stringResource(R.string.payment_context), style = MaterialTheme.typography.bodySmall, color = Anip.InkMuted)
        }
        AnipCard {
            Text(stringResource(R.string.enter_pin), style = MaterialTheme.typography.titleMedium)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                repeat(maxOf(4, demoPin.length)) { i ->
                    Box(
                        Modifier.padding(6.dp).size(18.dp).clip(CircleShape)
                            .background(if (i < pin.length) Anip.Brand else Anip.Line)
                    )
                }
            }
            error?.let {
                val left = it.substringAfter("wrong_pin:", "").toIntOrNull()
                Text(
                    if (left != null) stringResource(R.string.wrong_pin, left) else it,
                    color = Anip.Danger, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold,
                )
            }
            PinPad(
                enabled = !busy,
                onDigit = { if (pin.length < 8) pin += it },
                onDelete = { pin = pin.dropLast(1) },
            )
            Text(stringResource(R.string.pin_hint, demoPin), style = MaterialTheme.typography.bodySmall, color = Anip.InkMuted)
            if (busy) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(color = Anip.Brand, strokeWidth = 3.dp, modifier = Modifier.size(22.dp))
                    Spacer(Modifier.width(10.dp))
                    Text(stringResource(R.string.authorizing), style = MaterialTheme.typography.bodyLarge)
                }
            } else {
                PrimaryButton(stringResource(R.string.authorize), { onAuthorize(pin); pin = "" }, enabled = pin.length >= 4)
                TextButton(onClick = onDecline, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.decline), color = Anip.Danger, style = MaterialTheme.typography.labelLarge)
                }
            }
        }
    }
}

@Composable
private fun PinPad(enabled: Boolean, onDigit: (String) -> Unit, onDelete: () -> Unit) {
    val rows = listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9"), listOf("", "0", "⌫"))
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        rows.forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { key ->
                    Box(Modifier.weight(1f).height(56.dp)) {
                        if (key.isNotEmpty()) {
                            Surface(
                                onClick = { if (key == "⌫") onDelete() else onDigit(key) },
                                enabled = enabled,
                                shape = RoundedCornerShape(10.dp),
                                color = Anip.BrandSoft,
                                modifier = Modifier.fillMaxWidth().height(56.dp),
                            ) {
                                Box(contentAlignment = Alignment.Center) {
                                    Text(key, fontSize = 22.sp, fontWeight = FontWeight.Bold, color = Anip.BrandStrong)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/* --------------------------------------------------------------- completed */

@Composable
fun CompletedScreen(outcome: IdentityOutcome, request: PaymentRequest, payment: PaymentResult, onNew: () -> Unit) {
    var showDetails by remember { mutableStateOf(false) }
    val paid = payment is PaymentResult.Authorized
    Column(
        Modifier.fillMaxWidth().background(if (paid) Anip.heroGradient else androidx.compose.ui.graphics.SolidColor(Anip.BrandStrong))
            .padding(horizontal = 16.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        ResultLine(true, stringResource(R.string.result_identity))
        ResultLine(paid, stringResource(if (paid) R.string.result_payment else R.string.result_payment_failed))
        ResultLine(paid, stringResource(if (paid) R.string.result_complete else R.string.result_not_complete))
    }
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        AnipCard {
            Text(request.merchantName, style = MaterialTheme.typography.titleMedium)
            Text(formatAmount(request.amount, request.currency, ""), style = MaterialTheme.typography.headlineMedium, color = Anip.BrandStrong)
            val name = listOfNotNull(
                (outcome.report.claims["given_name"] as? ClaimValue.Text)?.value,
                (outcome.report.claims["family_name"] as? ClaimValue.Text)?.value,
            ).joinToString(" ")
            KeyValue(stringResource(R.string.verified_person), name)
            KeyValue(stringResource(R.string.reference), request.reference)
            when (payment) {
                is PaymentResult.Authorized -> {
                    KeyValue(stringResource(R.string.authorization_code), payment.authorizationCode)
                    KeyValue(stringResource(R.string.payment_provider), payment.provider)
                }
                is PaymentResult.Declined -> Text(payment.reason, color = Anip.Danger, style = MaterialTheme.typography.bodyMedium)
            }
        }
        SecondaryButton(stringResource(if (showDetails) R.string.details_hide else R.string.details_show), { showDetails = !showDetails })
        if (showDetails) ChecksCard(outcome)
        PrimaryButton(stringResource(R.string.new_transaction), onNew)
    }
}

@Composable
private fun ResultLine(ok: Boolean, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(44.dp).clip(CircleShape).background(if (ok) Anip.Accent else Anip.Danger), contentAlignment = Alignment.Center) {
            Icon(if (ok) Icons.Outlined.CheckCircle else Icons.Outlined.Cancel, null, tint = if (ok) Anip.BrandStrong else Color.White, modifier = Modifier.size(30.dp))
        }
        Spacer(Modifier.width(14.dp))
        Text("$text ${if (ok) "✓" else "✗"}", style = MaterialTheme.typography.headlineSmall, color = Color.White)
    }
}

/* ------------------------------------------------------------------- error */

@Composable
fun ErrorScreen(message: String, onRetry: () -> Unit) {
    StatusBanner(ok = false, text = stringResource(R.string.error_title))
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        AnipCard { Text(message, style = MaterialTheme.typography.bodyLarge) }
        PrimaryButton(stringResource(R.string.retry), onRetry)
    }
}
