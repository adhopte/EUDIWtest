package bj.anip.proximity.pos.pid

import kotlinx.coroutines.withTimeout
import kotlinx.io.bytestring.ByteString
import org.multipaz.cbor.Bstr
import org.multipaz.cbor.Cbor
import org.multipaz.cbor.DataItem
import org.multipaz.cbor.RawCbor
import org.multipaz.cbor.Simple
import org.multipaz.cbor.Tagged
import org.multipaz.cbor.buildCborArray
import org.multipaz.crypto.Crypto
import org.multipaz.crypto.EcPrivateKey
import org.multipaz.mdoc.connectionmethod.MdocConnectionMethod
import org.multipaz.mdoc.connectionmethod.MdocConnectionMethodBle
import org.multipaz.mdoc.engagement.DeviceEngagement
import org.multipaz.mdoc.nfc.scanMdocReader
import org.multipaz.mdoc.request.buildDeviceRequest
import org.multipaz.mdoc.role.MdocRole
import org.multipaz.mdoc.sessionencryption.SessionEncryption
import org.multipaz.mdoc.transport.MdocTransport
import org.multipaz.mdoc.transport.MdocTransportFactory
import org.multipaz.mdoc.transport.MdocTransportOptions
import org.multipaz.nfc.NfcTagReader
import org.multipaz.util.Constants
import org.multipaz.util.UUID
import org.multipaz.util.fromBase64Url
import kotlin.time.Clock
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

/** Progress of the proximity session, shown live on the POS. */
enum class ReaderStep { ENGAGEMENT, CONNECTING, REQUEST_SENT, WAITING_CONSENT, RESPONSE_RECEIVED }

/** What the transport layer hands to the verifier (no PID semantics here). */
class ProximityResult(
    val deviceResponse: ByteArray,
    val sessionTranscript: ByteArray,
    val eReaderKey: EcPrivateKey,
    val engagement: String,
    val transport: String,
    val engagementToResponse: Duration,
)

class ProximityException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * ISO/IEC 18013-5 mdoc reader (requirements FR-01 … FR-03):
 * device engagement by QR code (wallet shows "mdoc:…") or NFC tap, session
 * establishment with an ephemeral reader key (ECDH + HKDF + AES-GCM session
 * encryption), DeviceRequest for the merchant PID subset, DeviceResponse.
 */
class ProximityReader(
    private val options: MdocTransportOptions = MdocTransportOptions(bleUseL2CAP = false),
    private val consentTimeout: Duration = 90.seconds,
) {
    /** Engagement from the QR code shown by the wallet. */
    suspend fun readFromQr(
        qrText: String,
        itemsToRequest: Map<String, Map<String, Boolean>>,
        onStep: (ReaderStep) -> Unit,
    ): ProximityResult {
        if (!qrText.startsWith("mdoc:")) throw ProximityException("Not an ISO 18013-5 engagement QR code")
        val encodedEngagement = ByteString(qrText.removePrefix("mdoc:").fromBase64Url())
        onStep(ReaderStep.ENGAGEMENT)
        val engagement = DeviceEngagement.fromDataItem(Cbor.decode(encodedEngagement.toByteArray()))
        val methods = MdocConnectionMethod.disambiguate(engagement.connectionMethods, MdocRole.MDOC_READER)
        // Prefer BLE (what EUDI wallets offer for QR engagement).
        val method = methods.firstOrNull { it is MdocConnectionMethodBle } ?: methods.firstOrNull()
            ?: throw ProximityException("The wallet offered no supported transport")
        val transport = MdocTransportFactory.Default.createTransport(method, MdocRole.MDOC_READER, options)
        return exchange(transport, encodedEngagement, Simple.NULL, itemsToRequest, "QR code", onStep)
    }

    /** Engagement by NFC tap (static or negotiated handover), data transfer over BLE. */
    suspend fun readFromNfc(
        message: String,
        itemsToRequest: Map<String, Map<String, Boolean>>,
        onStep: (ReaderStep) -> Unit,
    ): ProximityResult? {
        val reader = NfcTagReader.getReaders().firstOrNull()
            ?: throw ProximityException("This device has no NFC reader")
        val uuid = UUID.randomUUID()
        val negotiated = listOf(
            MdocConnectionMethodBle(
                supportsPeripheralServerMode = false, supportsCentralClientMode = true,
                peripheralServerModeUuid = null, centralClientModeUuid = uuid,
            ),
            MdocConnectionMethodBle(
                supportsPeripheralServerMode = true, supportsCentralClientMode = false,
                peripheralServerModeUuid = uuid, centralClientModeUuid = null,
            ),
        )
        val scan = reader.scanMdocReader(
            message = message,
            options = options,
            selectConnectionMethod = { methods -> methods.firstOrNull { it is MdocConnectionMethodBle } ?: methods.firstOrNull() },
            negotiatedHandoverConnectionMethods = negotiated,
        ) ?: return null
        onStep(ReaderStep.ENGAGEMENT)
        return exchange(scan.transport, scan.encodedDeviceEngagement, scan.handover, itemsToRequest, "NFC", onStep)
    }

    private suspend fun exchange(
        transport: MdocTransport,
        encodedEngagement: ByteString,
        handover: DataItem,
        itemsToRequest: Map<String, Map<String, Boolean>>,
        engagementType: String,
        onStep: (ReaderStep) -> Unit,
    ): ProximityResult {
        val engagement = DeviceEngagement.fromDataItem(Cbor.decode(encodedEngagement.toByteArray()))
        val eDeviceKey = engagement.eDeviceKey
        val eReaderKey = Crypto.createEcPrivateKey(eDeviceKey.curve)
        val sessionTranscript = sessionTranscript(encodedEngagement.toByteArray(), handover, eReaderKey)
        val session = SessionEncryption(MdocRole.MDOC_READER, eReaderKey, eDeviceKey, sessionTranscript)
        val deviceRequest = Cbor.encode(
            buildDeviceRequest(sessionTranscript = RawCbor(sessionTranscript)) {
                addDocRequest(
                    docType = PidProfile.DOC_TYPE,
                    nameSpaces = itemsToRequest,
                    docRequestInfo = null,
                )
            }.toDataItem()
        )
        val t0 = Clock.System.now()
        try {
            onStep(ReaderStep.CONNECTING)
            transport.open(eDeviceKey)
            transport.sendMessage(session.encryptMessage(deviceRequest, statusCode = null))
            onStep(ReaderStep.REQUEST_SENT)
            onStep(ReaderStep.WAITING_CONSENT)
            val sessionData = withTimeout(consentTimeout) { transport.waitForMessage() }
            if (sessionData.isEmpty()) throw ProximityException("The wallet closed the session")
            val (message, status) = session.decryptMessage(sessionData)
            if (message == null) {
                throw ProximityException(
                    if (status == Constants.SESSION_DATA_STATUS_SESSION_TERMINATION) "The citizen declined or cancelled"
                    else "No response from the wallet (status $status)"
                )
            }
            onStep(ReaderStep.RESPONSE_RECEIVED)
            runCatching {
                transport.sendMessage(SessionEncryption.encodeStatus(Constants.SESSION_DATA_STATUS_SESSION_TERMINATION))
            }
            return ProximityResult(
                deviceResponse = message,
                sessionTranscript = sessionTranscript,
                eReaderKey = eReaderKey,
                engagement = engagementType,
                transport = transport.connectionMethod.toString(),
                engagementToResponse = Clock.System.now() - t0,
            )
        } catch (e: ProximityException) {
            throw e
        } catch (e: Throwable) {
            throw ProximityException(e.message ?: e::class.simpleName ?: "Transport error", e)
        } finally {
            runCatching { transport.close() }
        }
    }

    companion object {
        /** SessionTranscript = [DeviceEngagementBytes, EReaderKeyBytes, Handover] (ISO 18013-5 §9.1.5.1). */
        fun sessionTranscript(encodedEngagement: ByteArray, handover: DataItem, eReaderKey: EcPrivateKey): ByteArray {
            val encodedEReaderKey = Cbor.encode(eReaderKey.publicKey.toCoseKey().toDataItem())
            return Cbor.encode(
                buildCborArray {
                    add(Tagged(Tagged.ENCODED_CBOR, Bstr(encodedEngagement)))
                    add(Tagged(Tagged.ENCODED_CBOR, Bstr(encodedEReaderKey)))
                    add(handover)
                }
            )
        }
    }
}
