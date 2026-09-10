/**
 * Even G2 BLE constants and command framing.
 *
 * IMPORTANT: none of this is from Even Realities. It is community
 * reverse-engineering, taken from i-soxi/even-g2-protocol (docs/ble-uuids.md and
 * the packet-structure section of its README) and not verified against a device
 * here. Expect it to drift with firmware. The supported path is the Even Hub SDK
 * in `packages/` — this module exists to see what the sandbox does not expose.
 */

const BASE = (suffix: string) => `00002760-08c2-11e1-9073-0e8ac72e${suffix}`;

export const G2 = {
  /** Advertised as `Even G2_XX_L_YYYYYY` / `Even G2_XX_R_YYYYYY`; each lens is its own peripheral. */
  namePrefix: 'Even G2_',
  service: BASE('0000'),
  /** Write Without Response — commands to the glasses. */
  writeCommands: BASE('5401'),
  /** Notify — responses from the glasses. Requires CCCD enablement. */
  notify: BASE('5402'),
  /** Service declaration. */
  declaration: BASE('5450'),
  /** Write Without Response — 204-byte display rendering packets. */
  writeDisplay: BASE('6402'),
} as const;

/** Service ids that appear inside the frame header, distinct from the BLE UUIDs. */
export const SERVICE_ID = {
  content: 0x5401,
  rendering: 0x6402,
} as const;

/** CRC-16/CCITT-FALSE: init 0xFFFF, poly 0x1021, over the payload bytes only. */
export function crc16Ccitt(payload: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of payload) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/**
 * Build a command frame:
 *   AA 21 <seq> <len> 01 01 <svc_hi> <svc_lo> <payload…> <crc_lo> <crc_hi>
 *
 * `len` is the payload length. The CRC is little-endian and covers the payload only.
 */
export function buildFrame(
  serviceId: number,
  payload: Uint8Array,
  seq: number,
): Uint8Array<ArrayBuffer> {
  if (payload.length > 0xff) {
    throw new RangeError(`Payload of ${payload.length} bytes does not fit in a one-byte length field.`);
  }
  const crc = crc16Ccitt(payload);
  // Back the frame with a concrete ArrayBuffer so it satisfies BufferSource
  // when handed to writeValueWithoutResponse.
  const frame = new Uint8Array(new ArrayBuffer(8 + payload.length + 2));
  frame[0] = 0xaa;
  frame[1] = 0x21;
  frame[2] = seq & 0xff;
  frame[3] = payload.length;
  frame[4] = 0x01;
  frame[5] = 0x01;
  frame[6] = (serviceId >> 8) & 0xff;
  frame[7] = serviceId & 0xff;
  frame.set(payload, 8);
  frame[8 + payload.length] = crc & 0xff;
  frame[9 + payload.length] = (crc >> 8) & 0xff;
  return frame;
}

export function hex(bytes: ArrayBufferView | ArrayBuffer): string {
  const view =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [...view].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** One connected lens. The left and right temples pair as separate peripherals. */
export class Lens {
  private seq = 0;

  private constructor(
    readonly device: BluetoothDevice,
    private commands: BluetoothRemoteGATTCharacteristic,
    private display: BluetoothRemoteGATTCharacteristic | null,
    private notifications: BluetoothRemoteGATTCharacteristic,
  ) {}

  static async request(onNotify: (lens: string, data: Uint8Array) => void): Promise<Lens> {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth is unavailable. Use Chrome over localhost or HTTPS.');
    }
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: G2.namePrefix }],
      optionalServices: [G2.service],
    });
    const server = await device.gatt!.connect();
    const service = await server.getPrimaryService(G2.service);

    const commands = await service.getCharacteristic(G2.writeCommands);
    const notifications = await service.getCharacteristic(G2.notify);
    // The rendering characteristic is not present on every firmware; treat it as optional.
    const display = await service.getCharacteristic(G2.writeDisplay).catch(() => null);

    await notifications.startNotifications();
    notifications.addEventListener('characteristicvaluechanged', (event) => {
      const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
      if (value) onNotify(device.name ?? '?', new Uint8Array(value.buffer));
    });

    return new Lens(device, commands, display, notifications);
  }

  get name(): string {
    return this.device.name ?? '(unnamed)';
  }

  /** Send a framed command on the content channel. Returns the bytes actually sent. */
  async send(payload: Uint8Array, serviceId: number = SERVICE_ID.content): Promise<Uint8Array<ArrayBuffer>> {
    const frame = buildFrame(serviceId, payload, this.seq++);
    const target = serviceId === SERVICE_ID.rendering && this.display ? this.display : this.commands;
    await target.writeValueWithoutResponse(frame);
    return frame;
  }

  async disconnect(): Promise<void> {
    await this.notifications.stopNotifications().catch(() => {});
    this.device.gatt?.disconnect();
  }
}
