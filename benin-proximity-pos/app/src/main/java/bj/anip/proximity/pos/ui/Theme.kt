package bj.anip.proximity.pos.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import bj.anip.proximity.pos.R

/** ANIP CIVIC portal design tokens (civic-portal.onrender.com, :root variables). */
object Anip {
    val BeninGreen = Color(0xFF008751)
    val BeninYellow = Color(0xFFFCD116)
    val BeninRed = Color(0xFFE8112D)
    val Brand = Color(0xFF00693E)
    val BrandStrong = Color(0xFF004D2D)
    val BrandSoft = Color(0xFFE6F2EC)
    val Accent = BeninYellow
    val Danger = Color(0xFFC0102A)
    val DangerSoft = Color(0xFFFDECEE)
    val Warn = Color(0xFF8A5A00)
    val WarnSoft = Color(0xFFFFF4D6)
    val Ink = Color(0xFF1C2321)
    val InkMuted = Color(0xFF5B6763)
    val Line = Color(0xFFDDE3E0)
    val Surface = Color.White
    val Page = Color(0xFFF4F6F5)

    /** .hero background: linear-gradient(135deg, brand-strong, brand) */
    val heroGradient = Brush.linearGradient(listOf(BrandStrong, Brand))
}

val Montserrat = FontFamily(
    Font(R.font.montserrat_semibold, FontWeight.SemiBold),
    Font(R.font.montserrat_bold, FontWeight.Bold),
    Font(R.font.montserrat_extrabold, FontWeight.ExtraBold),
)

val SourceSans = FontFamily(
    Font(R.font.source_sans_regular, FontWeight.Normal),
    Font(R.font.source_sans_semibold, FontWeight.SemiBold),
    Font(R.font.source_sans_bold, FontWeight.Bold),
)

private val typography = Typography(
    headlineLarge = TextStyle(fontFamily = Montserrat, fontWeight = FontWeight.ExtraBold, fontSize = 30.sp, lineHeight = 36.sp),
    headlineMedium = TextStyle(fontFamily = Montserrat, fontWeight = FontWeight.Bold, fontSize = 24.sp, lineHeight = 30.sp),
    headlineSmall = TextStyle(fontFamily = Montserrat, fontWeight = FontWeight.Bold, fontSize = 20.sp, lineHeight = 26.sp),
    titleLarge = TextStyle(fontFamily = Montserrat, fontWeight = FontWeight.Bold, fontSize = 18.sp, lineHeight = 24.sp),
    titleMedium = TextStyle(fontFamily = Montserrat, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 22.sp),
    titleSmall = TextStyle(fontFamily = Montserrat, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, letterSpacing = 1.sp),
    bodyLarge = TextStyle(fontFamily = SourceSans, fontWeight = FontWeight.Normal, fontSize = 17.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontFamily = SourceSans, fontWeight = FontWeight.Normal, fontSize = 15.sp, lineHeight = 21.sp),
    bodySmall = TextStyle(fontFamily = SourceSans, fontWeight = FontWeight.Normal, fontSize = 13.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontFamily = SourceSans, fontWeight = FontWeight.Bold, fontSize = 16.sp),
    labelMedium = TextStyle(fontFamily = SourceSans, fontWeight = FontWeight.SemiBold, fontSize = 13.sp),
    labelSmall = TextStyle(fontFamily = Montserrat, fontWeight = FontWeight.Bold, fontSize = 11.sp, letterSpacing = 1.2.sp),
)

@Composable
fun AnipTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = Anip.Brand,
            onPrimary = Color.White,
            primaryContainer = Anip.BrandSoft,
            onPrimaryContainer = Anip.BrandStrong,
            secondary = Anip.BrandStrong,
            tertiary = Anip.Accent,
            onTertiary = Anip.Ink,
            background = Anip.Page,
            onBackground = Anip.Ink,
            surface = Anip.Surface,
            onSurface = Anip.Ink,
            onSurfaceVariant = Anip.InkMuted,
            outline = Anip.Line,
            error = Anip.Danger,
            errorContainer = Anip.DangerSoft,
        ),
        typography = typography,
        content = content,
    )
}
