package com.example.mocon.protocol

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import kotlin.math.roundToInt

/**
 * Mocon wire protocol v1. Game-agnostic: the phone streams raw motion + input,
 * and each game configures the controller UI through the command characteristic.
 *
 * Full spec: PROTOCOL.md at the project root. Keep both in sync.
 * Every packet fits in 20 bytes so it works with the default BLE MTU.
 */
object MoconProtocol {
    const val VERSION: Int = 1

    val SERVICE_UUID: UUID = UUID.fromString("4d6f636f-6e00-4a1e-9c3b-5f2d00000000")
    /** READ. Protocol version, capabilities, device model. */
    val INFO_UUID: UUID = UUID.fromString("4d6f636f-6e00-4a1e-9c3b-5f2d00000001")
    /** NOTIFY. Motion packet, streamed at the configured rate. */
    val MOTION_UUID: UUID = UUID.fromString("4d6f636f-6e00-4a1e-9c3b-5f2d00000002")
    /** NOTIFY. Input packet, sent whenever buttons or joystick change. */
    val INPUT_UUID: UUID = UUID.fromString("4d6f636f-6e00-4a1e-9c3b-5f2d00000003")
    /** WRITE / WRITE_NO_RESPONSE. Commands from the game to the phone. */
    val COMMAND_UUID: UUID = UUID.fromString("4d6f636f-6e00-4a1e-9c3b-5f2d00000004")
    /** Standard Client Characteristic Configuration Descriptor. */
    val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    const val MAX_PACKET = 20
    const val MAX_BUTTONS = 8
    const val MAX_LABEL_BYTES = 17
    const val MAX_TITLE_BYTES = 19

    const val CAP_MOTION = 1 shl 0
    const val CAP_BUTTONS = 1 shl 1
    const val CAP_JOYSTICK = 1 shl 2
    const val CAP_VIBRATE = 1 shl 3

    /** Bit set in [InputPacket.buttons] while the phone's own Recenter button is held. */
    const val BUTTON_RECENTER = 1 shl 15

    const val QUAT_SCALE = 32767f
    const val GYRO_SCALE = 1000f // int16 = rad/s * 1000
    const val ACCEL_STEP = 0.5f // int8 * 0.5 = m/s^2

    const val MIN_RATE_HZ = 10
    const val MAX_RATE_HZ = 120
    const val DEFAULT_RATE_HZ = 60

    object Op {
        const val RECENTER = 0x01
        const val VIBRATE = 0x02
        const val SET_RATE = 0x03
        const val SET_LAYOUT = 0x04
        const val SET_LABEL = 0x05
        const val SET_TITLE = 0x06
        const val RESET_LAYOUT = 0x07
    }

    const val LAYOUT_JOYSTICK = 1 shl 0
    const val LAYOUT_HIDE_RECENTER = 1 shl 1

    private fun buf(size: Int) = ByteBuffer.allocate(size).order(ByteOrder.LITTLE_ENDIAN)

    fun encodeInfo(capabilities: Int, model: String): ByteArray {
        val name = model.toByteArray(Charsets.UTF_8).take(64).toByteArray()
        return buf(3 + name.size)
            .put(VERSION.toByte())
            .put(capabilities.toByte())
            .put(MAX_BUTTONS.toByte())
            .put(name)
            .array()
    }

    /** 20 bytes: seq u8, time u16, quat 4×i16, gyro 3×i16, linear accel 3×i8. */
    fun encodeMotion(p: MotionPacket): ByteArray {
        val b = buf(MAX_PACKET)
        b.put(p.seq.toByte())
        b.putShort((p.timeMs and 0xFFFF).toShort())
        for (v in floatArrayOf(p.qw, p.qx, p.qy, p.qz)) b.putShort(clampShort(v * QUAT_SCALE))
        for (v in floatArrayOf(p.gx, p.gy, p.gz)) b.putShort(clampShort(v * GYRO_SCALE))
        for (v in floatArrayOf(p.ax, p.ay, p.az)) b.put(clampByte(v / ACCEL_STEP))
        return b.array()
    }

    fun decodeMotion(bytes: ByteArray): MotionPacket {
        val b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        val seq = b.get().toInt() and 0xFF
        val time = b.short.toInt() and 0xFFFF
        val q = FloatArray(4) { b.short / QUAT_SCALE }
        val g = FloatArray(3) { b.short / GYRO_SCALE }
        val a = FloatArray(3) { b.get() * ACCEL_STEP }
        return MotionPacket(seq, time, q[0], q[1], q[2], q[3], g[0], g[1], g[2], a[0], a[1], a[2])
    }

    /** 5 bytes: seq u8, buttons u16, joystick x i8, joystick y i8 (−127..127, +y = up). */
    fun encodeInput(p: InputPacket): ByteArray =
        buf(5)
            .put(p.seq.toByte())
            .putShort(p.buttons.toShort())
            .put(clampByte(p.joyX * 127f))
            .put(clampByte(p.joyY * 127f))
            .array()

    fun decodeInput(bytes: ByteArray): InputPacket {
        val b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        return InputPacket(
            seq = b.get().toInt() and 0xFF,
            buttons = b.short.toInt() and 0xFFFF,
            joyX = b.get() / 127f,
            joyY = b.get() / 127f,
        )
    }

    /** Parses a command written by the game. Returns null for unknown or malformed packets. */
    fun decodeCommand(bytes: ByteArray): Command? {
        if (bytes.isEmpty()) return null
        val b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        val op = b.get().toInt() and 0xFF
        return try {
            when (op) {
                Op.RECENTER -> Command.Recenter
                Op.VIBRATE -> Command.Vibrate(
                    durationMs = b.short.toInt() and 0xFFFF,
                    amplitude = if (b.hasRemaining()) b.get().toInt() and 0xFF else 0,
                )
                Op.SET_RATE -> Command.SetRate(
                    (b.get().toInt() and 0xFF).coerceIn(MIN_RATE_HZ, MAX_RATE_HZ)
                )
                Op.SET_LAYOUT -> Command.SetLayout(
                    buttonCount = (b.get().toInt() and 0xFF).coerceIn(0, MAX_BUTTONS),
                    flags = if (b.hasRemaining()) b.get().toInt() and 0xFF else 0,
                )
                Op.SET_LABEL -> {
                    val index = b.get().toInt() and 0xFF
                    if (index >= MAX_BUTTONS) null
                    else Command.SetLabel(index, String(bytes, 2, bytes.size - 2, Charsets.UTF_8))
                }
                Op.SET_TITLE -> Command.SetTitle(String(bytes, 1, bytes.size - 1, Charsets.UTF_8))
                Op.RESET_LAYOUT -> Command.ResetLayout
                else -> null
            }
        } catch (_: java.nio.BufferUnderflowException) {
            null
        }
    }

    private fun clampShort(v: Float): Short = v.roundToInt().coerceIn(-32767, 32767).toShort()
    private fun clampByte(v: Float): Byte = v.roundToInt().coerceIn(-127, 127).toByte()
}

/**
 * Orientation is relative to the last recenter, as a unit quaternion in the
 * phone's own axes at recenter time (x = screen right, y = screen top, z = out of screen).
 * Gyro (rad/s) and linear acceleration (m/s², gravity removed) are in current device axes.
 */
data class MotionPacket(
    val seq: Int,
    val timeMs: Int,
    val qw: Float, val qx: Float, val qy: Float, val qz: Float,
    val gx: Float, val gy: Float, val gz: Float,
    val ax: Float, val ay: Float, val az: Float,
)

data class InputPacket(
    val seq: Int,
    val buttons: Int,
    val joyX: Float,
    val joyY: Float,
)

sealed interface Command {
    data object Recenter : Command
    data class Vibrate(val durationMs: Int, val amplitude: Int) : Command
    data class SetRate(val hz: Int) : Command
    data class SetLayout(val buttonCount: Int, val flags: Int) : Command
    data class SetLabel(val index: Int, val label: String) : Command
    data class SetTitle(val title: String) : Command
    data object ResetLayout : Command
}
