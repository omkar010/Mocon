package com.example.mocon

import com.example.mocon.protocol.Command
import com.example.mocon.protocol.InputPacket
import com.example.mocon.protocol.MoconProtocol
import com.example.mocon.protocol.MotionPacket
import com.example.mocon.sensor.Quaternion
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import kotlin.math.cos
import kotlin.math.sin

class ProtocolTest {

    @Test
    fun motionPacketIs20BytesAndRoundTrips() {
        val p = MotionPacket(
            seq = 255, timeMs = 70_000,
            qw = 0.7071f, qx = 0f, qy = 0.7071f, qz = 0f,
            gx = 12.5f, gy = -3.25f, gz = 0f,
            ax = 9.5f, ay = -20f, az = 100f, // az clamps to 63.5
        )
        val bytes = MoconProtocol.encodeMotion(p)
        assertEquals(20, bytes.size)
        val d = MoconProtocol.decodeMotion(bytes)
        assertEquals(255, d.seq)
        assertEquals(70_000 and 0xFFFF, d.timeMs)
        assertEquals(0.7071f, d.qw, 1e-4f)
        assertEquals(0.7071f, d.qy, 1e-4f)
        assertEquals(12.5f, d.gx, 1e-3f)
        assertEquals(-3.25f, d.gy, 1e-3f)
        assertEquals(9.5f, d.ax, 0.25f)
        assertEquals(-20f, d.ay, 0.25f)
        assertEquals(63.5f, d.az, 0.01f)
    }

    @Test
    fun inputPacketRoundTrips() {
        val bytes = MoconProtocol.encodeInput(
            InputPacket(seq = 7, buttons = 0b101 or MoconProtocol.BUTTON_RECENTER, joyX = -1f, joyY = 0.5f)
        )
        assertEquals(5, bytes.size)
        val d = MoconProtocol.decodeInput(bytes)
        assertEquals(0b101 or MoconProtocol.BUTTON_RECENTER, d.buttons)
        assertEquals(-1f, d.joyX, 0.01f)
        assertEquals(0.5f, d.joyY, 0.01f)
    }

    @Test
    fun decodesCommands() {
        fun cmd(vararg b: Int) = MoconProtocol.decodeCommand(ByteArray(b.size) { b[it].toByte() })
        assertEquals(Command.Recenter, cmd(0x01))
        assertEquals(Command.Vibrate(300, 0), cmd(0x02, 0x2C, 0x01))
        assertEquals(Command.SetRate(120), cmd(0x03, 250)) // clamped
        assertEquals(Command.SetLayout(3, MoconProtocol.LAYOUT_JOYSTICK), cmd(0x04, 3, 1))
        assertEquals(Command.SetLabel(1, "Block"), cmd(0x05, 1, 'B'.code, 'l'.code, 'o'.code, 'c'.code, 'k'.code))
        assertEquals(Command.SetTitle("Hi"), cmd(0x06, 'H'.code, 'i'.code))
        assertNull(cmd(0x05, 9, 'x'.code)) // button index out of range
        assertNull(cmd(0x02)) // truncated
        assertNull(cmd(0x7F))
    }

    @Test
    fun relativeOrientationIsIdentityAtReference() {
        val ref = axisAngle(0f, 0f, 1f, 1.2f)
        val r = Quaternion.relative(ref, ref)
        assertEquals(1f, r.w, 1e-5f)
        assertEquals(0f, r.x, 1e-5f)
    }

    @Test
    fun relativeOrientationRemovesReferenceYaw() {
        val ref = axisAngle(0f, 0f, 1f, 1.0f) // turned 1 rad about world up
        val current = ref * axisAngle(1f, 0f, 0f, 0.5f) // then tilted 0.5 rad about its own x
        val r = Quaternion.relative(ref, current)
        val expected = axisAngle(1f, 0f, 0f, 0.5f)
        assertEquals(expected.w, r.w, 1e-5f)
        assertEquals(expected.x, r.x, 1e-5f)
        assertEquals(0f, r.y, 1e-5f)
        assertEquals(0f, r.z, 1e-5f)
    }

    private fun axisAngle(x: Float, y: Float, z: Float, angle: Float): Quaternion {
        val s = sin(angle / 2)
        return Quaternion(cos(angle / 2), x * s, y * s, z * s)
    }
}
