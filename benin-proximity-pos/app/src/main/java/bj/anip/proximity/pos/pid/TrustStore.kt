package bj.anip.proximity.pos.pid

import android.content.Context
import org.multipaz.crypto.X509Cert
import org.multipaz.storage.ephemeral.EphemeralStorage
import org.multipaz.trustmanagement.TrustManager
import org.multipaz.trustmanagement.TrustManagerLocal
import org.multipaz.trustmanagement.TrustMetadata
import java.io.File

/**
 * Issuer trust anchors (IACA certificates) for offline PID verification.
 *
 * Sources, all available without network once provisioned (requirement FR-12):
 *  - PEM files in the `assets/trust` folder of the APK (e.g. the ANIP IACA);
 *  - certificates imported on the device from Settings (stored in app storage);
 *  - the simulated ANIP demo issuer, when demo mode is used.
 */
class TrustStore(private val context: Context) {

    data class Anchor(val label: String, val subject: String, val source: Source, val pem: String)
    enum class Source { BUNDLED, IMPORTED, DEMO }

    private val importDir = File(context.filesDir, "trust").apply { mkdirs() }
    private val extra = mutableListOf<Anchor>()

    fun anchors(): List<Anchor> {
        val bundled = context.assets.list("trust").orEmpty()
            .filter { it.endsWith(".pem") || it.endsWith(".crt") }
            .flatMap { name ->
                splitPem(context.assets.open("trust/$name").bufferedReader().readText())
                    .map { anchorOf(it, name.substringBeforeLast('.'), Source.BUNDLED) }
            }
        val imported = importDir.listFiles().orEmpty().sortedBy { it.name }.flatMap { f ->
            splitPem(f.readText()).map { anchorOf(it, f.nameWithoutExtension, Source.IMPORTED) }
        }
        return (bundled + imported + extra).distinctBy { it.pem }
    }

    /** Imports one or more PEM certificates; returns how many were added. */
    fun import(pemText: String, label: String): Int {
        val certs = splitPem(pemText)
        require(certs.isNotEmpty()) { "No PEM certificate found" }
        certs.forEach { X509Cert.fromPem(it) } // validate before saving
        val safe = label.replace(Regex("[^A-Za-z0-9._-]"), "_").ifBlank { "issuer" }
        File(importDir, "${safe}_${System.currentTimeMillis()}.pem").writeText(certs.joinToString("\n"))
        return certs.size
    }

    fun remove(anchor: Anchor) {
        if (anchor.source != Source.IMPORTED) return
        importDir.listFiles().orEmpty().filter { it.readText().contains(anchor.pem.trim()) }.forEach { it.delete() }
    }

    /** Registers the in-memory demo issuer (never persisted). */
    fun addDemoAnchor(pem: String, label: String) {
        if (extra.none { it.pem == pem }) extra += anchorOf(pem, label, Source.DEMO)
    }

    suspend fun trustManager(): TrustManager {
        val tm = TrustManagerLocal(EphemeralStorage())
        for (a in anchors()) {
            runCatching {
                tm.addX509Cert(X509Cert.fromPem(a.pem), TrustMetadata(displayName = a.label, testOnly = a.source == Source.DEMO))
            }
        }
        return tm
    }

    private fun anchorOf(pem: String, label: String, source: Source): Anchor {
        val subject = runCatching { X509Cert.fromPem(pem).subject.name }.getOrDefault("?")
        return Anchor(label, subject, source, pem.trim() + "\n")
    }

    companion object {
        private val PEM = Regex("-----BEGIN CERTIFICATE-----[\\s\\S]+?-----END CERTIFICATE-----")
        fun splitPem(text: String): List<String> = PEM.findAll(text).map { it.value }.toList()
    }
}
