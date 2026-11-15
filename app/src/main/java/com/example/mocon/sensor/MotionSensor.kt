package com.example.mocon.sensor

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler

/**
 * Reads orientation, angular velocity and linear acceleration.
 *
 * Uses GAME_ROTATION_VECTOR (gyro + accelerometer, no compass) so nearby
 * magnets or metal don't make the orientation jump.
 */
class MotionSensor(context: Context) : SensorEventListener {

    data class Sample(
        val orientation: Quaternion,
        val gyro: FloatArray,
        val linearAccel: FloatArray,
    )

    private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val rotationSensor: Sensor? =
        sensorManager.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR)
            ?: sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
    private val gyroSensor: Sensor? = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
    private val accelSensor: Sensor? = sensorManager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)

    val isAvailable: Boolean get() = rotationSensor != null

    private val lock = Any()
    private var absolute = Quaternion.IDENTITY
    private var reference = Quaternion.IDENTITY
    private var pendingRecenter = true
    private val gyro = FloatArray(3)
    private val accel = FloatArray(3)
    private val quatScratch = FloatArray(4)

    fun start(handler: Handler) {
        val periodUs = 10_000 // 100 Hz; the BLE sender picks the latest sample at its own rate.
        listOfNotNull(rotationSensor, gyroSensor, accelSensor).forEach {
            sensorManager.registerListener(this, it, periodUs, handler)
        }
    }

    fun stop() = sensorManager.unregisterListener(this)

    /** Makes the current pose the new "forward" (identity). */
    fun recenter() = synchronized(lock) { pendingRecenter = true }

    fun latest(): Sample = synchronized(lock) {
        Sample(Quaternion.relative(reference, absolute), gyro.copyOf(), accel.copyOf())
    }

    override fun onSensorChanged(event: SensorEvent) {
        synchronized(lock) {
            when (event.sensor.type) {
                Sensor.TYPE_GAME_ROTATION_VECTOR, Sensor.TYPE_ROTATION_VECTOR -> {
                    SensorManager.getQuaternionFromVector(quatScratch, event.values)
                    absolute = Quaternion(quatScratch[0], quatScratch[1], quatScratch[2], quatScratch[3])
                    if (pendingRecenter) {
                        reference = absolute
                        pendingRecenter = false
                    }
                }
                Sensor.TYPE_GYROSCOPE -> event.values.copyInto(gyro, 0, 0, 3)
                Sensor.TYPE_LINEAR_ACCELERATION -> event.values.copyInto(accel, 0, 0, 3)
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
}
