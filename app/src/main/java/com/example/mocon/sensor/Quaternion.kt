package com.example.mocon.sensor

import kotlin.math.sqrt

data class Quaternion(val w: Float, val x: Float, val y: Float, val z: Float) {
    operator fun times(o: Quaternion) = Quaternion(
        w * o.w - x * o.x - y * o.y - z * o.z,
        w * o.x + x * o.w + y * o.z - z * o.y,
        w * o.y - x * o.z + y * o.w + z * o.x,
        w * o.z + x * o.y - y * o.x + z * o.w,
    )

    fun conjugate() = Quaternion(w, -x, -y, -z)

    fun normalized(): Quaternion {
        val n = sqrt(w * w + x * x + y * y + z * z)
        return if (n == 0f) IDENTITY else Quaternion(w / n, x / n, y / n, z / n)
    }

    /** Same rotation with w >= 0, so the encoded value doesn't flip sign between frames. */
    fun canonical() = if (w < 0f) Quaternion(-w, -x, -y, -z) else this

    companion object {
        val IDENTITY = Quaternion(1f, 0f, 0f, 0f)

        /** Rotation from [reference] to [current], expressed in the reference pose's axes. */
        fun relative(reference: Quaternion, current: Quaternion): Quaternion =
            (reference.conjugate() * current).normalized().canonical()
    }
}
