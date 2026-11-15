package com.example.mocon.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.mocon.ble.BlePeripheral.Status
import com.example.mocon.controller.ControllerLayout
import com.example.mocon.sensor.Quaternion
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.min
import kotlin.math.sqrt

@Composable
fun ControllerScreen(
    status: Status,
    layout: ControllerLayout,
    orientation: Quaternion,
    hasMotionSensor: Boolean,
    permissionsGranted: Boolean,
    onRequestPermissions: () -> Unit,
    onEnableBluetooth: () -> Unit,
    onRetry: () -> Unit,
    onButton: (index: Int, pressed: Boolean) -> Unit,
    onRecenter: (held: Boolean) -> Unit,
    onJoystick: (x: Float, y: Float) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxSize().padding(16.dp)) {
        Text(layout.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(4.dp))
        StatusLine(status, permissionsGranted)
        Spacer(Modifier.height(4.dp))
        OrientationLine(orientation)
        if (!hasMotionSensor) {
            Text(
                "This phone has no motion sensor, so only buttons will work.",
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Spacer(Modifier.height(16.dp))

        when {
            !permissionsGranted -> Notice(
                "Mocon needs Bluetooth permission to connect to games.",
                "Grant permission", onRequestPermissions,
            )
            status is Status.BluetoothOff -> Notice("Bluetooth is off.", "Turn on Bluetooth", onEnableBluetooth)
            status is Status.Failed -> Notice(status.reason, "Retry", onRetry)
            status is Status.Unsupported -> Notice(status.reason, null, null)
            else -> Controls(layout, onButton, onRecenter, onJoystick, Modifier.weight(1f))
        }
    }
}

@Composable
private fun StatusLine(status: Status, permissionsGranted: Boolean) {
    val (color, text) = when {
        !permissionsGranted -> Color(0xFF9E9E9E) to "Waiting for permission"
        status is Status.Connected -> Color(0xFF2E7D32) to "Connected to ${status.deviceName}"
        status is Status.Advertising -> Color(0xFFF9A825) to "Waiting for a game… open it and press Connect"
        status is Status.Stopped -> Color(0xFF9E9E9E) to "Starting…"
        else -> MaterialTheme.colorScheme.error to "Not available"
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(10.dp).clip(CircleShape).background(color))
        Spacer(Modifier.width(8.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun OrientationLine(q: Quaternion) {
    // Rough angles in the phone's axes, only for a "sensor is alive" readout.
    val pitch = Math.toDegrees(atan2(2.0 * (q.w * q.x + q.y * q.z), 1.0 - 2.0 * (q.x * q.x + q.y * q.y)))
    val roll = Math.toDegrees(asin((2.0 * (q.w * q.y - q.z * q.x)).coerceIn(-1.0, 1.0)))
    val yaw = Math.toDegrees(atan2(2.0 * (q.w * q.z + q.x * q.y), 1.0 - 2.0 * (q.y * q.y + q.z * q.z)))
    Text(
        "pitch %4.0f°   roll %4.0f°   yaw %4.0f°".format(pitch, roll, yaw),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun Notice(message: String, action: String?, onAction: (() -> Unit)?) {
    Column(Modifier.fillMaxWidth().padding(top = 32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(message, textAlign = TextAlign.Center)
        if (action != null && onAction != null) {
            Spacer(Modifier.height(16.dp))
            Button(onClick = onAction) { Text(action) }
        }
    }
}

@Composable
private fun Controls(
    layout: ControllerLayout,
    onButton: (Int, Boolean) -> Unit,
    onRecenter: (Boolean) -> Unit,
    onJoystick: (Float, Float) -> Unit,
    modifier: Modifier,
) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        val labels = layout.buttonLabels
        if (labels.isEmpty() && !layout.joystick) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text("Motion only", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        // Two columns of large buttons that share the available height.
        labels.indices.chunked(2).forEach { row ->
            Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                row.forEach { i ->
                    HoldButton(labels[i], Modifier.weight(1f).fillMaxSize()) { onButton(i, it) }
                }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
        if (layout.joystick) {
            Box(Modifier.fillMaxWidth().weight(1.4f), contentAlignment = Alignment.Center) {
                Joystick(onJoystick)
            }
        }
        if (layout.showRecenter) {
            HoldButton(
                "Recenter (point forward, then tap)",
                Modifier.fillMaxWidth().height(64.dp),
                primary = false,
                onPress = onRecenter,
            )
        }
    }
}

/** Reports press and release separately, so games can use hold-to-act controls. */
@Composable
private fun HoldButton(label: String, modifier: Modifier, primary: Boolean = true, onPress: (Boolean) -> Unit) {
    var pressed by remember { mutableStateOf(false) }
    val haptics = LocalHapticFeedback.current
    val scheme = MaterialTheme.colorScheme
    val bg = when {
        pressed -> scheme.primary
        primary -> scheme.primaryContainer
        else -> scheme.surfaceVariant
    }
    val fg = when {
        pressed -> scheme.onPrimary
        primary -> scheme.onPrimaryContainer
        else -> scheme.onSurfaceVariant
    }
    Box(
        modifier
            .clip(RoundedCornerShape(20.dp))
            .background(bg)
            .pointerInput(onPress) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    pressed = true
                    haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    onPress(true)
                    try {
                        do {
                            val event = awaitPointerEvent()
                        } while (event.changes.any { it.pressed })
                    } finally {
                        pressed = false
                        onPress(false)
                    }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Text(label, color = fg, fontSize = if (primary) 28.sp else 16.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun Joystick(onMove: (Float, Float) -> Unit) {
    var knob by remember { mutableStateOf(Offset.Zero) } // normalized, -1..1, +y = down on screen
    val scheme = MaterialTheme.colorScheme
    Canvas(
        Modifier
            .fillMaxSize()
            .aspectRatio(1f)
            .border(2.dp, scheme.outline, CircleShape)
            .pointerInput(onMove) {
                val radius = min(size.width, size.height) / 2f
                val center = Offset(size.width / 2f, size.height / 2f)
                fun update(pos: Offset) {
                    var v = (pos - center) / radius
                    val len = sqrt(v.x * v.x + v.y * v.y)
                    if (len > 1f) v /= len
                    knob = v
                    onMove(v.x, -v.y)
                }
                awaitEachGesture {
                    update(awaitFirstDown(requireUnconsumed = false).position)
                    try {
                        while (true) {
                            val change = awaitPointerEvent().changes.firstOrNull() ?: break
                            if (!change.pressed) break
                            update(change.position)
                        }
                    } finally {
                        knob = Offset.Zero
                        onMove(0f, 0f)
                    }
                }
            }
    ) {
        val radius = min(size.width, size.height) / 2f
        drawCircle(scheme.surfaceVariant, radius)
        drawCircle(scheme.primary, radius * 0.3f, center + knob * (radius * 0.7f))
    }
}
