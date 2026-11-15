# Mocon protocol v1

Mocon turns an Android phone into a Bluetooth LE motion controller for web games.
The phone is the BLE **peripheral** (GATT server); the game in Chrome/Edge is the
**central** and connects with Web Bluetooth. No server is involved.

The phone knows nothing about any particular game. It streams raw motion and input,
and each game configures the on-phone buttons through commands. Most games should use
the SDK in [`web/mocon.js`](web/mocon.js) rather than this spec directly.

All multi-byte values are **little-endian**. Every packet is ≤ 20 bytes, so it fits the
default BLE MTU without negotiation.

## Service

| Name    | UUID                                   | Properties           |
|---------|----------------------------------------|----------------------|
| Service | `4d6f636f-6e00-4a1e-9c3b-5f2d00000000` | primary, advertised  |
| Info    | `4d6f636f-6e00-4a1e-9c3b-5f2d00000001` | read                 |
| Motion  | `4d6f636f-6e00-4a1e-9c3b-5f2d00000002` | notify               |
| Input   | `4d6f636f-6e00-4a1e-9c3b-5f2d00000003` | notify               |
| Command | `4d6f636f-6e00-4a1e-9c3b-5f2d00000004` | write, write w/o rsp |

One game connects at a time. The phone stops advertising while connected and resets its
layout and rate to defaults when the game disconnects.

## Info (read)

| Offset | Type  | Field                                                    |
|--------|-------|----------------------------------------------------------|
| 0      | u8    | protocol version (1)                                     |
| 1      | u8    | capabilities: bit0 motion, bit1 buttons, bit2 joystick, bit3 vibrate |
| 2      | u8    | max buttons (8)                                          |
| 3…     | UTF-8 | phone model, e.g. "Google Pixel 9"                       |

## Motion (notify, 20 bytes, default 60 Hz)

| Offset | Type     | Field |
|--------|----------|-------|
| 0      | u8       | sequence number, wraps at 256 |
| 1      | u16      | phone clock in ms, wraps at 65536 (use differences only) |
| 3      | 4 × i16  | orientation quaternion w, x, y, z; value = raw / 32767 |
| 11     | 3 × i16  | angular velocity x, y, z in rad/s; value = raw / 1000 |
| 17     | 3 × i8   | linear acceleration (gravity removed) x, y, z in m/s²; value = raw × 0.5, clamps at ±63.5 |

**Axes.** Phone axes: x = right edge of screen, y = top edge, z = out of the display.

- **Orientation** is relative to the last recenter: identity means "the phone is in the
  pose it had when recentered". It is the rotation from the recentered pose to the current
  pose, expressed in the recentered phone's axes. It uses gyro + accelerometer only
  (no compass), so it is stable near metal but yaw drifts slowly; games should offer a recenter.
- **Angular velocity** and **acceleration** are in the phone's current axes.

The first orientation sample after the app starts is used as the initial recenter.

To map to Three.js (x right, y up, −z forward) with the phone held like a hilt or
remote (top toward the screen, display up) at recenter: `three = (x: q.x, y: q.z, z: −q.y, w: q.w)`.
`Mocon.toThree()` does this.

## Input (notify, 5 bytes, sent on change)

| Offset | Type | Field |
|--------|------|-------|
| 0      | u8   | sequence number |
| 1      | u16  | buttons: bit *n* = game button *n* held (0–7); bit 15 = phone's Recenter button held |
| 3      | i8   | joystick x, −127 (left) … 127 (right) |
| 4      | i8   | joystick y, −127 (down) … 127 (up) |

The phone also sends the current input state right after the game subscribes.

## Commands (write)

Byte 0 is the opcode. Unknown opcodes are ignored.

| Op   | Name         | Payload | Effect |
|------|--------------|---------|--------|
| 0x01 | RECENTER     | –       | Current pose becomes identity |
| 0x02 | VIBRATE      | u16 duration ms (1–5000), u8 amplitude (1–255, 0 = default) | Vibrate the phone |
| 0x03 | SET_RATE     | u8 Hz (10–120) | Motion packet rate |
| 0x04 | SET_LAYOUT   | u8 button count (0–8), u8 flags: bit0 show joystick, bit1 hide Recenter | Rebuild the on-phone controls; labels default to A, B, C… |
| 0x05 | SET_LABEL    | u8 button index, UTF-8 label (≤ 17 bytes) | Rename one button |
| 0x06 | SET_TITLE    | UTF-8 title (≤ 19 bytes) | Heading shown on the phone |
| 0x07 | RESET_LAYOUT | – | Back to the default (2 buttons, Recenter shown) |

A typical game sends `SET_LAYOUT`, then one `SET_LABEL` per button, then `SET_TITLE`,
right after connecting.

## Versioning

New fields are only appended to packets, and new opcodes added. A breaking change bumps the
version byte in Info and gets new characteristic UUIDs, so old games keep working with old phones.
