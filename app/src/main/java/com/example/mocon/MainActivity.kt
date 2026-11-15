package com.example.mocon

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import com.example.mocon.controller.MoconController
import com.example.mocon.ui.ControllerScreen
import com.example.mocon.ui.theme.MoconTheme

class MainActivity : ComponentActivity() {

    private lateinit var controller: MoconController
    private val permissionsGranted = mutableStateOf(false)

    private val requiredPermissions: Array<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            arrayOf(Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            emptyArray() // BLUETOOTH / BLUETOOTH_ADMIN are granted at install time
        }

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            refreshPermissions()
            if (permissionsGranted.value) restartController()
        }

    private val enableBluetoothLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            restartController()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        controller = MoconController(this)
        refreshPermissions()
        if (!permissionsGranted.value) permissionLauncher.launch(requiredPermissions)

        setContent {
            MoconTheme {
                val status by controller.status.collectAsState()
                val layout by controller.layout.collectAsState()
                val orientation by controller.orientation.collectAsState()
                Scaffold(Modifier.fillMaxSize()) { padding ->
                    ControllerScreen(
                        status = status,
                        layout = layout,
                        orientation = orientation,
                        hasMotionSensor = controller.hasMotionSensor,
                        permissionsGranted = permissionsGranted.value,
                        onRequestPermissions = { permissionLauncher.launch(requiredPermissions) },
                        onEnableBluetooth = {
                            enableBluetoothLauncher.launch(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE))
                        },
                        onRetry = ::restartController,
                        onButton = controller::setButton,
                        onRecenter = controller::setRecenterHeld,
                        onJoystick = controller::setJoystick,
                        modifier = Modifier.padding(padding),
                    )
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        refreshPermissions()
        if (permissionsGranted.value) controller.start()
    }

    override fun onStop() {
        controller.stop()
        super.onStop()
    }

    private fun restartController() {
        controller.stop()
        if (permissionsGranted.value) controller.start()
    }

    private fun refreshPermissions() {
        permissionsGranted.value = requiredPermissions.all {
            ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
        }
    }
}
