package bj.anip.proximity.pos.payment

import kotlinx.coroutines.delay
import java.security.SecureRandom

/*
 * Payment integration boundary (requirements §8).
 *
 * The proximity/PID component never talks to a payment network. After a successful
 * identity check, the POS builds a [PaymentRequest] that carries only the minimum
 * transaction context ([IdentityContext]: verified yes/no and the age-over-18
 * result, no PID attributes) and hands it to a [PaymentGateway]. Mobile money,
 * bank or card rails are added by implementing [PaymentGateway]; nothing in the
 * PID verification code changes.
 */

/** Minimum identity context the payment layer is allowed to see. */
data class IdentityContext(
    val identityVerified: Boolean,
    val ageOver18: Boolean?,
)

data class PaymentRequest(
    val reference: String,
    val merchantName: String,
    /** Amount in minor units is not used for XOF (no decimals); kept as a whole number. */
    val amount: Long,
    val currency: String,
    val identity: IdentityContext,
)

/** The customer's explicit approval, collected by the payment method's own authentication. */
data class CustomerAuthorization(val pin: String)

sealed interface PaymentResult {
    data class Authorized(val authorizationCode: String, val provider: String) : PaymentResult
    data class Declined(val reason: String, val attemptsLeft: Int? = null) : PaymentResult
}

interface PaymentGateway {
    /** Name shown on the POS ("Simulated", "MTN MoMo", …). */
    val displayName: String

    /**
     * Authorizes the payment. Called only after the customer explicitly confirmed it
     * (requirement FR-10); implementations must also refuse requests whose identity
     * context is not verified.
     */
    suspend fun authorize(request: PaymentRequest, authorization: CustomerAuthorization): PaymentResult
}

/**
 * First executive demo: simulated authorization (allowed by the requirements, §8).
 * The customer confirms with a demo PIN; three wrong PINs decline the payment.
 */
class SimulatedPaymentGateway(
    private val demoPin: String,
    private val maxAttempts: Int = 3,
) : PaymentGateway {
    override val displayName = "Simulated payment (demo)"
    private val attempts = mutableMapOf<String, Int>()
    private val random = SecureRandom()

    override suspend fun authorize(request: PaymentRequest, authorization: CustomerAuthorization): PaymentResult {
        if (!request.identity.identityVerified) return PaymentResult.Declined("Identity not verified")
        delay(900) // simulated network round trip to the payment provider
        val used = (attempts[request.reference] ?: 0) + 1
        attempts[request.reference] = used
        if (authorization.pin != demoPin) {
            val left = maxAttempts - used
            return PaymentResult.Declined(if (left > 0) "Incorrect PIN" else "Too many attempts", left.coerceAtLeast(0))
        }
        val code = (1..6).map { "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[random.nextInt(32)] }.joinToString("")
        return PaymentResult.Authorized(code, displayName)
    }
}
