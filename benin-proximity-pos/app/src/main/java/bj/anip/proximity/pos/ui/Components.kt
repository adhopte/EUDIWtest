package bj.anip.proximity.pos.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Cancel
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Cloud
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.RemoveCircleOutline
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import bj.anip.proximity.pos.R
import bj.anip.proximity.pos.pid.CheckStatus

/** var(--tricolour): green | yellow | red, as at the top and bottom of the CIVIC portal. */
@Composable
fun TricolourStripe(height: Dp = 5.dp) {
    Row(Modifier.fillMaxWidth().height(height)) {
        Box(Modifier.weight(1f).height(height).background(Anip.BeninGreen))
        Box(Modifier.weight(1f).height(height).background(Anip.BeninYellow))
        Box(Modifier.weight(1f).height(height).background(Anip.BeninRed))
    }
}

/** Dark green government bar with the EN / FR switch. */
@Composable
fun GovernmentBar(language: String, onLanguage: (String) -> Unit) {
    Row(
        Modifier.fillMaxWidth().background(Anip.BrandStrong).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(stringResource(R.string.republic), color = Color.White, style = MaterialTheme.typography.labelSmall, modifier = Modifier.weight(1f))
        listOf("en" to "EN", "fr" to "FR").forEach { (code, label) ->
            val active = language == code
            Surface(
                onClick = { onLanguage(code) },
                shape = RoundedCornerShape(6.dp),
                color = if (active) Anip.Accent else Color.Transparent,
                border = if (active) null else BorderStroke(1.dp, Color.White.copy(alpha = 0.6f)),
                modifier = Modifier.padding(start = 6.dp),
            ) {
                Text(
                    label, style = MaterialTheme.typography.labelSmall,
                    color = if (active) Anip.Ink else Color.White,
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                )
            }
        }
    }
}

/** White site header: ANIP logo + terminal title (as .site-header on the CIVIC portal). */
@Composable
fun SiteHeader(onSettings: (() -> Unit)?) {
    Row(
        Modifier.fillMaxWidth().background(Color.White).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Image(
            painterResource(R.drawable.anip_logo), contentDescription = "ANIP — Agence Nationale d’Identification des Personnes",
            modifier = Modifier.height(40.dp).weight(1f, fill = false), contentScale = ContentScale.Fit, alignment = Alignment.CenterStart,
        )
        Spacer(Modifier.weight(1f))
        if (onSettings != null) {
            IconButton(onClick = onSettings) {
                Icon(Icons.Outlined.Settings, contentDescription = stringResource(R.string.settings), tint = Anip.Brand)
            }
        }
    }
}

/** .hero: green gradient band with the yellow badge. */
@Composable
fun Hero(badge: String, title: String, subtitle: String? = null, trailing: @Composable (() -> Unit)? = null) {
    Column(
        Modifier.fillMaxWidth().background(Anip.heroGradient).padding(horizontal = 16.dp, vertical = 20.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            badge.uppercase(), style = MaterialTheme.typography.labelSmall, color = Anip.Ink,
            modifier = Modifier.clip(RoundedCornerShape(50)).background(Anip.Accent).padding(horizontal = 10.dp, vertical = 4.dp),
        )
        Text(title, style = MaterialTheme.typography.headlineMedium, color = Color.White)
        subtitle?.let { Text(it, style = MaterialTheme.typography.bodyLarge, color = Color.White.copy(alpha = 0.92f)) }
        trailing?.invoke()
    }
}

@Composable
fun NetworkChip(online: Boolean) {
    Row(
        Modifier.clip(RoundedCornerShape(50)).background(Color.White.copy(alpha = 0.16f)).padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(if (online) Icons.Outlined.Cloud else Icons.Outlined.CloudOff, null, tint = if (online) Color.White else Anip.Accent, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(6.dp))
        Text(
            stringResource(if (online) R.string.online else R.string.offline),
            color = if (online) Color.White else Anip.Accent, style = MaterialTheme.typography.labelMedium,
        )
    }
}

/** White card with the portal's border, radius and soft shadow. */
@Composable
fun AnipCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(10.dp),
        color = Anip.Surface,
        border = BorderStroke(1.dp, Anip.Line),
        shadowElevation = 1.dp,
    ) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp), content = content)
    }
}

/** .use-case__icon: mint tile with a brand-green icon. */
@Composable
fun IconTile(icon: ImageVector, size: Dp = 48.dp) {
    Box(Modifier.size(size).clip(RoundedCornerShape(12.dp)).background(Anip.BrandSoft), contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = Anip.Brand, modifier = Modifier.size(size * 0.55f))
    }
}

@Composable
fun CardTitle(icon: ImageVector, title: String, subtitle: String? = null) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        IconTile(icon)
        Spacer(Modifier.width(14.dp))
        Column {
            Text(title, style = MaterialTheme.typography.titleLarge)
            subtitle?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = Anip.InkMuted) }
        }
    }
}

@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, icon: ImageVector? = null) {
    Button(
        onClick = onClick, enabled = enabled, modifier = modifier.fillMaxWidth().height(54.dp),
        shape = RoundedCornerShape(10.dp),
        colors = ButtonDefaults.buttonColors(containerColor = Anip.Brand, contentColor = Color.White),
    ) { ButtonContent(text, icon) }
}

@Composable
fun SecondaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = null) {
    OutlinedButton(
        onClick = onClick, modifier = modifier.fillMaxWidth().height(54.dp),
        shape = RoundedCornerShape(10.dp), border = BorderStroke(1.5.dp, Anip.Brand),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = Anip.Brand),
    ) { ButtonContent(text, icon) }
}

@Composable
private fun RowScope.ButtonContent(text: String, icon: ImageVector?) {
    icon?.let { Icon(it, null, modifier = Modifier.size(20.dp)); Spacer(Modifier.width(8.dp)) }
    Text(text, style = MaterialTheme.typography.labelLarge)
}

/** Numbered yellow step dot, as in "How it works". */
@Composable
fun StepDot(content: @Composable () -> Unit, color: Color = Anip.Accent) {
    Box(Modifier.size(30.dp).clip(CircleShape).background(color), contentAlignment = Alignment.Center) { content() }
}

@Composable
fun StatusIcon(status: CheckStatus, size: Dp = 22.dp) {
    val (icon, tint) = when (status) {
        CheckStatus.PASS -> Icons.Outlined.CheckCircle to Anip.Brand
        CheckStatus.FAIL -> Icons.Outlined.Cancel to Anip.Danger
        CheckStatus.WARN -> Icons.Outlined.WarningAmber to Anip.Warn
        CheckStatus.NOT_EVALUATED -> Icons.Outlined.RemoveCircleOutline to Anip.InkMuted
        CheckStatus.SKIPPED_ONLINE -> Icons.Outlined.Info to Anip.InkMuted
    }
    Icon(icon, null, tint = tint, modifier = Modifier.size(size))
}

/** Footer: dark green band with the arms, agency name and motto. */
@Composable
fun SiteFooter() {
    Column(Modifier.fillMaxWidth()) {
        Column(
            Modifier.fillMaxWidth().background(Anip.BrandStrong).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Image(
                    painterResource(R.drawable.benin_arms), null,
                    modifier = Modifier.size(44.dp).clip(CircleShape).background(Color.White).border(2.dp, Color.White, CircleShape).padding(3.dp),
                )
                Spacer(Modifier.width(12.dp))
                Column {
                    Text(stringResource(R.string.footer_agency), color = Color.White, style = MaterialTheme.typography.titleMedium)
                    Text(stringResource(R.string.republic), color = Color.White.copy(alpha = 0.85f), style = MaterialTheme.typography.bodySmall)
                }
            }
            Text(stringResource(R.string.footer_motto), color = Anip.Accent, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.ExtraBold)
            Text(stringResource(R.string.footer_demo), color = Color.White.copy(alpha = 0.75f), style = MaterialTheme.typography.bodySmall)
        }
        TricolourStripe()
    }
}
