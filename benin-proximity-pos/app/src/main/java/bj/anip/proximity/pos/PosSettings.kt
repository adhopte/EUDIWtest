package bj.anip.proximity.pos

import android.content.Context

/** Terminal configuration, kept on the device (SharedPreferences). */
data class PosSettings(
    val merchantName: String = "Supermarché Étoile — Cotonou",
    val amount: Long = 15000,
    val currency: String = "XOF",
    val requireTrustedIssuer: Boolean = true,
    val requireAgeOver18: Boolean = false,
    val includePortrait: Boolean = false,
    val demoPin: String = "1234",
    /** "en" or "fr"; empty follows the device language. */
    val language: String = "",
) {
    companion object {
        private const val PREFS = "pos_settings"

        fun load(context: Context): PosSettings {
            val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val d = PosSettings()
            return PosSettings(
                merchantName = p.getString("merchantName", d.merchantName) ?: d.merchantName,
                amount = p.getLong("amount", d.amount),
                currency = p.getString("currency", d.currency) ?: d.currency,
                requireTrustedIssuer = p.getBoolean("requireTrustedIssuer", d.requireTrustedIssuer),
                requireAgeOver18 = p.getBoolean("requireAgeOver18", d.requireAgeOver18),
                includePortrait = p.getBoolean("includePortrait", d.includePortrait),
                demoPin = p.getString("demoPin", d.demoPin) ?: d.demoPin,
                language = p.getString("language", d.language) ?: d.language,
            )
        }

        fun save(context: Context, s: PosSettings) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("merchantName", s.merchantName)
                .putLong("amount", s.amount)
                .putString("currency", s.currency)
                .putBoolean("requireTrustedIssuer", s.requireTrustedIssuer)
                .putBoolean("requireAgeOver18", s.requireAgeOver18)
                .putBoolean("includePortrait", s.includePortrait)
                .putString("demoPin", s.demoPin)
                .putString("language", s.language)
                .apply()
        }
    }
}
