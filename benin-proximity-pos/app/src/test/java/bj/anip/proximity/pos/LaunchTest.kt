package bj.anip.proximity.pos

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Starts the real MainActivity, as the launcher does, and runs the in-app demo
 * end to end (genuine PID → payment → completed), so start-up and flow crashes
 * are caught on the JVM.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "en-w412dp-h900dp-xxhdpi")
class LaunchTest {

    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private fun click(text: String) =
        compose.onNodeWithText(text, substring = true).performScrollTo().performClick()

    private fun waitFor(text: String) =
        compose.waitUntilAtLeastOneExists(hasText(text, substring = true), timeoutMillis = 20_000)

    @Test fun launchesAndCompletesDemoTransaction() {
        waitFor(compose.activity.getString(R.string.btn_demo_valid))
        click(compose.activity.getString(R.string.btn_demo_valid))

        waitFor(compose.activity.getString(R.string.continue_payment))
        click(compose.activity.getString(R.string.continue_payment))

        waitFor(compose.activity.getString(R.string.authorize))
        "1234".forEach { d -> compose.onNodeWithText(d.toString()).performScrollTo().performClick() }
        click(compose.activity.getString(R.string.authorize))

        waitFor(compose.activity.getString(R.string.new_transaction))
        compose.onNodeWithText(compose.activity.getString(R.string.result_payment), substring = true).assertExists()
    }

    @Test fun opensSettings() {
        compose.onNodeWithContentDescriptionCompat(compose.activity.getString(R.string.settings))
        waitFor(compose.activity.getString(R.string.save))
    }

    private fun androidx.compose.ui.test.junit4.AndroidComposeTestRule<*, *>.onNodeWithContentDescriptionCompat(desc: String) =
        onNode(androidx.compose.ui.test.hasContentDescription(desc)).performClick()
}
