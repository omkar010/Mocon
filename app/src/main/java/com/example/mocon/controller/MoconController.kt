package com.example.mocon.controller

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import com.example.mocon.ble.BlePeripheral
import com.example.mocon.protocol.Command
import com.example.mocon.protocol.InputPacket
import com.example.mocon.protocol.MoconProtocol
import com.example.mocon.protocol.MotionPacket
import com.example.mocon.sensor.MotionSensor
import com.example.mocon.sensor.Quaternion
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** What the game has asked the phone to show. Reset whenever a game disconnects. */
data class ControllerLayout(
    val title: String = "Mocon",
    val buttonLabels: List<String> = listOf("A", "B"),
    val joystick: Boolean = false,
    val showRecenter: Boolean = true,
) {
    fun withButtonCount(count: Int) = copy(
        buttonLabels = List(count) { buttonLabels.getOrNull(it) ?: ('A' + it).toString() }
    )
}

/**
 * Ties sensors, BLE and UI together. Game-agnostic: it only streams raw data and
 * applies layout commands; all game logic lives in the browser.
 */
class MoconController(context: Context) : BlePeripheral.Listener {
    private val appContext = context.applicationContext
    private val sensor = MotionSensor(appContext)
    private val ble = BlePeripheral(
        appContext,
        MoconProtocol.encodeInfo(capabilities(), "${Build.MANUFACTURER} ${Build.MODEL}"),
        this,
    )

    private val _status = MutableStateFlow<BlePeripheral.Status>(BlePeripheral.Status.Stopped)
    val status: StateFlow<BlePeripheral.Status> = _status.asStateFlow()

    private val _layout = MutableStateFlow(ControllerLayout())
    val layout: StateFlow<ControllerLayout> = _layout.asStateFlow()

    /** Orientation preview for the UI, updated ~15 times a second. */
    private val _orientation = MutableStateFlow(Quaternion.IDENTITY)
    val orientation: StateFlow<Quaternion> = _orientation.asStateFlow()

    val hasMotionSensor: Boolean get() = sensor.isAvailable

    private var thread: HandlerThread? = null
    private var handler: Handler? = null

    // Touched only on the handler thread.
    private var rateHz = MoconProtocol.DEFAULT_RATE_HZ
    private var motionSeq = 0
    private var inputSeq = 0
    private var ticks = 0
    private var buttons = 0
    private var joyX = 0f
    private var joyY = 0f
    private var inputDirty = false

    fun start() {
        if (thread != null) return
        val t = HandlerThread("mocon-io").apply { start() }
        val h = Handler(t.looper)
        thread = t
        handler = h
        sensor.start(h)
        h.post {
            ble.start()
            scheduleTick()
        }
    }

    fun stop() {
        val h = handler ?: return
        h.removeCallbacksAndMessages(null)
        h.post {
            sensor.stop()
            ble.stop()
            thread?.quitSafely()
        }
        thread = null
        handler = null
        _layout.value = ControllerLayout()
    }

    /** Safe to call from the UI thread. */
    fun setButton(index: Int, pressed: Boolean) = post {
        val bit = 1 shl index
        val next = if (pressed) buttons or bit else buttons and bit.inv()
        if (next != buttons) {
            buttons = next
            inputDirty = true
            flushInput()
        }
    }

    fun setRecenterHeld(held: Boolean) {
        if (held) sensor.recenter()
        post {
            val next = if (held) buttons or MoconProtocol.BUTTON_RECENTER
            else buttons and MoconProtocol.BUTTON_RECENTER.inv()
            if (next != buttons) {
                buttons = next
                inputDirty = true
                flushInput()
            }
        }
    }

    fun setJoystick(x: Float, y: Float) = post {
        if (x != joyX || y != joyY) {
            joyX = x
            joyY = y
            inputDirty = true
            flushInput()
        }
    }

    // BlePeripheral.Listener — called from binder threads.

    override fun onStatus(status: BlePeripheral.Status) {
        _status.value = status
        if (status !is BlePeripheral.Status.Connected) {
            _layout.value = ControllerLayout() // next game starts from the default layout
            post { rateHz = MoconProtocol.DEFAULT_RATE_HZ }
        }
    }

    override fun onReadyToSend() = post {
        inputDirty = inputDirty || buttons != 0 || joyX != 0f || joyY != 0f
        flushInput()
    }

    override fun onCommand(command: Command) {
        when (command) {
            Command.Recenter -> sensor.recenter()
            is Command.Vibrate -> vibrate(command.durationMs, command.amplitude)
            is Command.SetRate -> post { rateHz = command.hz }
            is Command.SetLayout -> _layout.update {
                it.withButtonCount(command.buttonCount).copy(
                    joystick = command.flags and MoconProtocol.LAYOUT_JOYSTICK != 0,
                    showRecenter = command.flags and MoconProtocol.LAYOUT_HIDE_RECENTER == 0,
                )
            }
            is Command.SetLabel -> _layout.update {
                if (command.index >= it.buttonLabels.size) it
                else it.copy(buttonLabels = it.buttonLabels.toMutableList().also { l -> l[command.index] = command.label })
            }
            is Command.SetTitle -> _layout.update { it.copy(title = command.title) }
            Command.ResetLayout -> _layout.value = ControllerLayout()
        }
    }

    private fun scheduleTick() {
        val h = handler ?: return
        h.postDelayed({ tick(); scheduleTick() }, (1000L / rateHz).coerceAtLeast(1))
    }

    private fun tick() {
        val sample = sensor.latest()
        if (++ticks % (rateHz / 15).coerceAtLeast(1) == 0) _orientation.value = sample.orientation
        if (!ble.isStreaming) return
        if (inputDirty) {
            flushInput()
            return // one notification in flight at a time; input wins
        }
        val q = sample.orientation
        val g = sample.gyro
        val a = sample.linearAccel
        val packet = MotionPacket(
            seq = motionSeq and 0xFF,
            timeMs = (SystemClock.elapsedRealtime() and 0xFFFF).toInt(),
            qw = q.w, qx = q.x, qy = q.y, qz = q.z,
            gx = g[0], gy = g[1], gz = g[2],
            ax = a[0], ay = a[1], az = a[2],
        )
        if (ble.sendMotion(MoconProtocol.encodeMotion(packet))) motionSeq++
    }

    private fun flushInput() {
        if (!inputDirty) return
        val bytes = MoconProtocol.encodeInput(InputPacket(inputSeq and 0xFF, buttons, joyX, joyY))
        if (ble.sendInput(bytes)) {
            inputSeq++
            inputDirty = false
        }
    }

    private fun vibrate(durationMs: Int, amplitude: Int) {
        val vibrator = if (Build.VERSION.SDK_INT >= 31) {
            appContext.getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            appContext.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        } ?: return
        val ms = durationMs.coerceIn(1, 5000).toLong()
        if (Build.VERSION.SDK_INT >= 26) {
            val amp = if (amplitude == 0) VibrationEffect.DEFAULT_AMPLITUDE else amplitude.coerceIn(1, 255)
            vibrator.vibrate(VibrationEffect.createOneShot(ms, amp))
        } else {
            @Suppress("DEPRECATION")
            vibrator.vibrate(ms)
        }
    }

    private fun post(block: () -> Unit) {
        handler?.post(block)
    }

    private fun capabilities(): Int {
        var caps = MoconProtocol.CAP_BUTTONS or MoconProtocol.CAP_JOYSTICK or MoconProtocol.CAP_VIBRATE
        if (sensor.isAvailable) caps = caps or MoconProtocol.CAP_MOTION
        return caps
    }
}
