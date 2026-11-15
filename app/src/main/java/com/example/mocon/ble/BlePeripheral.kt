package com.example.mocon.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.content.Context
import android.os.Build
import android.os.ParcelUuid
import android.os.SystemClock
import android.util.Log
import com.example.mocon.protocol.Command
import com.example.mocon.protocol.MoconProtocol
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Makes the phone a BLE peripheral exposing the Mocon GATT service.
 * One game (central) connects at a time; advertising stops while connected.
 *
 * Callers must hold BLUETOOTH_ADVERTISE + BLUETOOTH_CONNECT (Android 12+) before [start].
 */
@SuppressLint("MissingPermission")
class BlePeripheral(
    private val context: Context,
    private val infoPayload: ByteArray,
    private val listener: Listener,
) {
    sealed interface Status {
        data object Stopped : Status
        data object BluetoothOff : Status
        data class Unsupported(val reason: String) : Status
        data object Advertising : Status
        data class Connected(val deviceName: String) : Status
        data class Failed(val reason: String) : Status
    }

    interface Listener {
        fun onStatus(status: Status)
        fun onCommand(command: Command)
        /** A notification finished sending; the next one can go out. */
        fun onReadyToSend()
    }

    private val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
    private var server: BluetoothGattServer? = null
    @Volatile private var device: BluetoothDevice? = null
    private val subscribed: MutableSet<UUID> = ConcurrentHashMap.newKeySet()
    private var advertising = false
    private var includeName = true

    @Volatile private var busySince = 0L
    @Volatile var status: Status = Status.Stopped
        private set

    private val motionChar = notifyChar(MoconProtocol.MOTION_UUID)
    private val inputChar = notifyChar(MoconProtocol.INPUT_UUID)

    val isStreaming: Boolean get() = device != null && subscribed.isNotEmpty()

    fun start() {
        val adapter = manager.adapter
        when {
            adapter == null -> return setStatus(Status.Unsupported("This phone has no Bluetooth"))
            !adapter.isEnabled -> return setStatus(Status.BluetoothOff)
            adapter.bluetoothLeAdvertiser == null || !adapter.isMultipleAdvertisementSupported ->
                return setStatus(Status.Unsupported("This phone can't act as a Bluetooth LE controller"))
        }
        if (server != null) return
        val gatt = manager.openGattServer(context, gattCallback)
            ?: return setStatus(Status.Failed("Couldn't open GATT server"))
        server = gatt
        gatt.addService(buildService()) // advertising starts in onServiceAdded
    }

    fun stop() {
        stopAdvertising()
        device?.let { server?.cancelConnection(it) }
        server?.close()
        server = null
        device = null
        subscribed.clear()
        setStatus(Status.Stopped)
    }

    fun sendMotion(bytes: ByteArray) = send(motionChar, bytes)
    fun sendInput(bytes: ByteArray) = send(inputChar, bytes)

    /** Returns false if not subscribed or the previous notification is still in flight. */
    private fun send(ch: BluetoothGattCharacteristic, bytes: ByteArray): Boolean {
        val gatt = server ?: return false
        val dev = device ?: return false
        if (ch.uuid !in subscribed) return false
        val now = SystemClock.elapsedRealtime()
        // Only one notification may be in flight; recover if a callback was ever lost.
        if (busySince != 0L && now - busySince < 250) return false
        busySince = now
        val ok = if (Build.VERSION.SDK_INT >= 33) {
            gatt.notifyCharacteristicChanged(dev, ch, false, bytes) == BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            ch.value = bytes
            @Suppress("DEPRECATION")
            gatt.notifyCharacteristicChanged(dev, ch, false)
        }
        if (!ok) busySince = 0L
        return ok
    }

    private fun buildService(): BluetoothGattService {
        val service = BluetoothGattService(MoconProtocol.SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        service.addCharacteristic(
            BluetoothGattCharacteristic(
                MoconProtocol.INFO_UUID,
                BluetoothGattCharacteristic.PROPERTY_READ,
                BluetoothGattCharacteristic.PERMISSION_READ,
            )
        )
        service.addCharacteristic(motionChar)
        service.addCharacteristic(inputChar)
        service.addCharacteristic(
            BluetoothGattCharacteristic(
                MoconProtocol.COMMAND_UUID,
                BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
                BluetoothGattCharacteristic.PERMISSION_WRITE,
            )
        )
        return service
    }

    private fun notifyChar(uuid: UUID) = BluetoothGattCharacteristic(
        uuid,
        BluetoothGattCharacteristic.PROPERTY_NOTIFY,
        0,
    ).apply {
        addDescriptor(
            BluetoothGattDescriptor(
                MoconProtocol.CCCD_UUID,
                BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
            )
        )
    }

    private fun startAdvertising() {
        if (advertising) return
        val advertiser = manager.adapter?.bluetoothLeAdvertiser ?: return
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(true)
            .build()
        val data = AdvertiseData.Builder()
            .addServiceUuid(ParcelUuid(MoconProtocol.SERVICE_UUID))
            .setIncludeDeviceName(false)
            .build()
        // The name goes in the scan response so the browser's device picker can show it.
        val scanResponse = AdvertiseData.Builder().setIncludeDeviceName(includeName).build()
        advertising = true
        advertiser.startAdvertising(settings, data, scanResponse, advertiseCallback)
    }

    private fun stopAdvertising() {
        if (!advertising) return
        advertising = false
        manager.adapter?.bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback)
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
            if (device == null) setStatus(Status.Advertising)
        }

        override fun onStartFailure(errorCode: Int) {
            advertising = false
            if (errorCode == ADVERTISE_FAILED_DATA_TOO_LARGE && includeName) {
                // Long phone names don't fit; advertise without it.
                includeName = false
                startAdvertising()
            } else if (errorCode == ADVERTISE_FAILED_ALREADY_STARTED) {
                advertising = true
                setStatus(Status.Advertising)
            } else {
                setStatus(Status.Failed("Advertising failed (code $errorCode)"))
            }
        }
    }

    private val gattCallback = object : BluetoothGattServerCallback() {
        override fun onServiceAdded(status: Int, service: BluetoothGattService) {
            if (status == BluetoothGatt.GATT_SUCCESS) startAdvertising()
            else setStatus(Status.Failed("Couldn't add GATT service (status $status)"))
        }

        override fun onConnectionStateChange(dev: BluetoothDevice, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                if (device != null && device != dev) {
                    server?.cancelConnection(dev) // already controlling another game
                    return
                }
                device = dev
                busySince = 0L
                stopAdvertising()
                setStatus(Status.Connected(dev.name ?: dev.address))
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED && dev == device) {
                device = null
                subscribed.clear()
                if (server != null) {
                    startAdvertising()
                    setStatus(Status.Advertising)
                }
            }
        }

        override fun onCharacteristicReadRequest(
            dev: BluetoothDevice, requestId: Int, offset: Int, ch: BluetoothGattCharacteristic,
        ) {
            if (ch.uuid != MoconProtocol.INFO_UUID) {
                server?.sendResponse(dev, requestId, BluetoothGatt.GATT_READ_NOT_PERMITTED, offset, null)
                return
            }
            if (offset > infoPayload.size) {
                server?.sendResponse(dev, requestId, BluetoothGatt.GATT_INVALID_OFFSET, offset, null)
                return
            }
            server?.sendResponse(
                dev, requestId, BluetoothGatt.GATT_SUCCESS, offset,
                infoPayload.copyOfRange(offset, infoPayload.size),
            )
        }

        override fun onCharacteristicWriteRequest(
            dev: BluetoothDevice, requestId: Int, ch: BluetoothGattCharacteristic,
            preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray?,
        ) {
            val ok = ch.uuid == MoconProtocol.COMMAND_UUID && !preparedWrite && offset == 0 && value != null
            if (responseNeeded) {
                server?.sendResponse(
                    dev, requestId,
                    if (ok) BluetoothGatt.GATT_SUCCESS else BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED,
                    offset, null,
                )
            }
            if (!ok) return
            val command = MoconProtocol.decodeCommand(value!!)
            if (command != null) listener.onCommand(command)
            else Log.w(TAG, "Ignored unknown command ${value.joinToString(" ") { "%02x".format(it) }}")
        }

        override fun onDescriptorReadRequest(
            dev: BluetoothDevice, requestId: Int, offset: Int, descriptor: BluetoothGattDescriptor,
        ) {
            val on = descriptor.characteristic.uuid in subscribed
            val value = if (on) BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            else BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
            server?.sendResponse(dev, requestId, BluetoothGatt.GATT_SUCCESS, 0, value)
        }

        override fun onDescriptorWriteRequest(
            dev: BluetoothDevice, requestId: Int, descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray?,
        ) {
            if (descriptor.uuid == MoconProtocol.CCCD_UUID && value != null && value.isNotEmpty()) {
                val uuid = descriptor.characteristic.uuid
                if (value[0].toInt() and 0x01 != 0) subscribed += uuid else subscribed -= uuid
                if (uuid == MoconProtocol.INPUT_UUID) listener.onReadyToSend() // push current input state
            }
            if (responseNeeded) {
                server?.sendResponse(dev, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            }
        }

        override fun onNotificationSent(dev: BluetoothDevice, status: Int) {
            busySince = 0L
            listener.onReadyToSend()
        }
    }

    private fun setStatus(s: Status) {
        status = s
        listener.onStatus(s)
    }

    private companion object {
        const val TAG = "MoconBle"
    }
}
