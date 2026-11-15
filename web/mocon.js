// Mocon browser SDK — connect any web game to the Mocon Android controller over Bluetooth LE.
// Protocol v1, see PROTOCOL.md. No dependencies; works in Chrome and Edge (desktop and Android).
//
//   import { Mocon } from './mocon.js';
//   const pad = new Mocon();
//   button.onclick = async () => {
//     await pad.connect();                       // must run inside a click/tap handler
//     await pad.setLayout({ title: 'Sword', buttons: ['Block', 'Special'] });
//   };
//   pad.addEventListener('motion', e => sword.quaternion.copy(Mocon.toThree(e.detail.quaternion)));
//   pad.addEventListener('buttondown', e => e.detail.index === 0 && startBlock());

const BASE = '4d6f636f-6e00-4a1e-9c3b-5f2d0000000';
export const UUIDS = {
  service: BASE + '0',
  info: BASE + '1',
  motion: BASE + '2',
  input: BASE + '3',
  command: BASE + '4',
};

const OP = { RECENTER: 1, VIBRATE: 2, SET_RATE: 3, SET_LAYOUT: 4, SET_LABEL: 5, SET_TITLE: 6, RESET_LAYOUT: 7 };
export const CAP = { MOTION: 1, BUTTONS: 2, JOYSTICK: 4, VIBRATE: 8 };
export const BUTTON_RECENTER = 1 << 15;
const MAX_BUTTONS = 8;

export class Mocon extends EventTarget {
  /** @type {BluetoothDevice|null} */ device = null;
  info = null;
  /** Latest data, if you prefer polling in your game loop over events. */
  state = {
    quaternion: { w: 1, x: 0, y: 0, z: 0 },
    gyro: { x: 0, y: 0, z: 0 },
    accel: { x: 0, y: 0, z: 0 },
    buttons: 0,
    joystick: { x: 0, y: 0 },
    timeMs: 0,
  };
  #command = null;
  #queue = Promise.resolve();
  #enc = new TextEncoder();

  static isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  get connected() {
    return !!this.device?.gatt?.connected;
  }

  /** Shows the browser's device picker. Call from a user gesture (click/tap). */
  async connect() {
    if (!Mocon.isSupported()) {
      throw new Error('Web Bluetooth is not available. Use Chrome or Edge over https:// or localhost.');
    }
    this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: [UUIDS.service] }] });
    this.device.addEventListener('gattserverdisconnected', () => {
      this.#command = null;
      this.dispatchEvent(new CustomEvent('disconnect'));
    });
    await this.#setup();
  }

  /** Reconnects to the last device without showing the picker again. */
  async reconnect() {
    if (!this.device) throw new Error('Call connect() first');
    await this.#setup();
  }

  disconnect() {
    this.device?.gatt?.disconnect();
  }

  async #setup() {
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(UUIDS.service);
    const [info, motion, input, command] = await Promise.all(
      [UUIDS.info, UUIDS.motion, UUIDS.input, UUIDS.command].map((u) => service.getCharacteristic(u)),
    );
    this.info = parseInfo(await info.readValue());
    this.#command = command;
    motion.addEventListener('characteristicvaluechanged', (e) => this.#onMotion(e.target.value));
    input.addEventListener('characteristicvaluechanged', (e) => this.#onInput(e.target.value));
    await motion.startNotifications();
    await input.startNotifications();
    this.dispatchEvent(new CustomEvent('connect', { detail: this.info }));
  }

  #onMotion(v) {
    const s = this.state;
    s.timeMs = v.getUint16(1, true);
    s.quaternion = {
      w: v.getInt16(3, true) / 32767,
      x: v.getInt16(5, true) / 32767,
      y: v.getInt16(7, true) / 32767,
      z: v.getInt16(9, true) / 32767,
    };
    s.gyro = { x: v.getInt16(11, true) / 1000, y: v.getInt16(13, true) / 1000, z: v.getInt16(15, true) / 1000 };
    s.accel = { x: v.getInt8(17) * 0.5, y: v.getInt8(18) * 0.5, z: v.getInt8(19) * 0.5 };
    this.dispatchEvent(new CustomEvent('motion', {
      detail: { seq: v.getUint8(0), timeMs: s.timeMs, quaternion: s.quaternion, gyro: s.gyro, accel: s.accel },
    }));
  }

  #onInput(v) {
    const prev = this.state.buttons;
    const buttons = v.getUint16(1, true);
    this.state.buttons = buttons;
    this.state.joystick = { x: v.getInt8(3) / 127, y: v.getInt8(4) / 127 };
    const changed = prev ^ buttons;
    for (let i = 0; i < MAX_BUTTONS; i++) {
      if (changed & (1 << i)) {
        this.dispatchEvent(new CustomEvent(buttons & (1 << i) ? 'buttondown' : 'buttonup', { detail: { index: i } }));
      }
    }
    if (changed & BUTTON_RECENTER && buttons & BUTTON_RECENTER) this.dispatchEvent(new CustomEvent('recenter'));
    this.dispatchEvent(new CustomEvent('input', {
      detail: { buttons, joystick: this.state.joystick, recenterHeld: !!(buttons & BUTTON_RECENTER) },
    }));
  }

  /** True while game button `index` (0-based) is held. */
  isPressed(index) {
    return !!(this.state.buttons & (1 << index));
  }

  // ---- Commands (game → phone). Queued, since Web Bluetooth allows one GATT operation at a time.

  /**
   * Sets what the phone shows. Labels: up to 8 buttons, 17 UTF-8 bytes each.
   * @param {{title?: string, buttons?: string[], joystick?: boolean, showRecenter?: boolean}} layout
   */
  async setLayout({ title, buttons = [], joystick = false, showRecenter = true } = {}) {
    if (buttons.length > MAX_BUTTONS) throw new Error(`At most ${MAX_BUTTONS} buttons`);
    const flags = (joystick ? 1 : 0) | (showRecenter ? 0 : 2);
    await this.#send([OP.SET_LAYOUT, buttons.length, flags]);
    for (let i = 0; i < buttons.length; i++) {
      await this.#send([OP.SET_LABEL, i, ...this.#text(buttons[i], 17)]);
    }
    if (title != null) await this.#send([OP.SET_TITLE, ...this.#text(title, 19)]);
  }

  resetLayout() { return this.#send([OP.RESET_LAYOUT]); }

  /** Makes the phone's current pose the new "forward". */
  recenter() { return this.#send([OP.RECENTER]); }

  /** @param {number} ms 1–5000  @param {number} amplitude 1–255, or 0 for the phone's default */
  vibrate(ms = 50, amplitude = 0) {
    ms = Math.max(1, Math.min(5000, Math.round(ms)));
    return this.#send([OP.VIBRATE, ms & 0xff, ms >> 8, amplitude & 0xff], false);
  }

  /** Motion packets per second, 10–120 (default 60). Actual rate is limited by the BLE link. */
  setRate(hz) { return this.#send([OP.SET_RATE, Math.max(10, Math.min(120, Math.round(hz)))]); }

  #text(s, maxBytes) {
    let bytes = this.#enc.encode(s);
    while (bytes.length > maxBytes) bytes = this.#enc.encode((s = s.slice(0, -1)));
    return bytes;
  }

  #send(bytes, withResponse = true) {
    const run = async () => {
      if (!this.#command) throw new Error('Not connected');
      const data = Uint8Array.from(bytes);
      return withResponse ? this.#command.writeValueWithResponse(data) : this.#command.writeValueWithoutResponse(data);
    };
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => {});
    return p;
  }

  // ---- Helpers

  /**
   * Converts a Mocon quaternion to Three.js axes (x right, y up, −z forward).
   * hold: 'pointer' — phone held like a sword hilt or TV remote, top pointing at the
   *                   screen, display facing up, when recentered (default).
   *       'upright' — phone held upright facing the player, like reading it.
   * Returns {x, y, z, w}; pass to THREE.Quaternion.set(x, y, z, w).
   */
  static toThree(q, hold = 'pointer') {
    if (hold === 'upright') return { x: q.x, y: q.y, z: q.z, w: q.w };
    return { x: q.x, y: q.z, z: -q.y, w: q.w };
  }

  /** Angular speed in rad/s, handy for swing detection. */
  static speed(v) {
    return Math.hypot(v.x, v.y, v.z);
  }
}

function parseInfo(v) {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  const caps = bytes[1];
  return {
    version: bytes[0],
    capabilities: caps,
    hasMotion: !!(caps & CAP.MOTION),
    hasVibrate: !!(caps & CAP.VIBRATE),
    maxButtons: bytes[2],
    model: new TextDecoder().decode(bytes.subarray(3)),
  };
}
