package bj.anip.proximity.pos.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import bj.anip.proximity.pos.R
import kotlinx.coroutines.launch
import org.multipaz.compose.camera.CameraCaptureResolution
import org.multipaz.compose.camera.CameraSelection
import org.multipaz.compose.permissions.rememberCameraPermissionState
import org.multipaz.compose.qrcode.QrCodeScanner

/** Scans the wallet's ISO 18013-5 engagement QR code ("mdoc:…"). */
@Composable
fun QrScanDialog(onScanned: (String) -> Unit, onDismiss: () -> Unit) {
    val camera = rememberCameraPermissionState()
    val scope = rememberCoroutineScope()
    var handled = false
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.qr_title), style = MaterialTheme.typography.titleLarge) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(R.string.qr_body), style = MaterialTheme.typography.bodyMedium)
                if (!camera.isGranted) {
                    PrimaryButton(stringResource(R.string.camera_needed), { scope.launch { camera.launchPermissionRequest() } })
                } else {
                    QrCodeScanner(
                        modifier = Modifier.fillMaxWidth().aspectRatio(1f).clipToBounds(),
                        cameraSelection = CameraSelection.DEFAULT_BACK_CAMERA,
                        captureResolution = CameraCaptureResolution.HIGH,
                        showCameraPreview = true,
                        onCodeScanned = { code ->
                            if (!handled && code != null && code.startsWith("mdoc:")) {
                                handled = true
                                onScanned(code)
                            }
                        },
                    )
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel), color = Anip.Brand) } },
    )
}
