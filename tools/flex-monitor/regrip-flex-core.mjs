export const ADC_MAX = 4095;
export const BLE_PACKET_LENGTH = 20;
export const BLE_PACKET_MAGIC = 0x52;
export const BLE_PROTOCOL_VERSION = 3;

export const FINGERS = [
  { key: "thumb", label: "엄지" },
  { key: "index", label: "검지" },
  { key: "middle", label: "중지" },
  { key: "ring", label: "약지" },
  { key: "little", label: "소지" },
];

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function parseFlexFrame(input) {
  const line = String(input ?? "").trim();
  if (!line || line.startsWith("#") || line.startsWith("sample_id")) return null;

  const parts = line.split(",").map((part) => part.trim());
  if (parts.length !== 7) return null;

  const values = parts.map(Number);
  if (!values.every(Number.isFinite)) return null;

  const [sampleId, timestampMs, thumb, index, middle, ring, little] = values;
  if (!Number.isInteger(sampleId) || !Number.isInteger(timestampMs)) return null;
  if (sampleId < 0 || timestampMs < 0) return null;

  const raw = { thumb, index, middle, ring, little };
  if (!Object.values(raw).every((value) =>
    Number.isInteger(value) && value >= 0 && value <= ADC_MAX)) return null;

  return { sampleId, timestampMs, raw, rawLine: line };
}

export function parseBleFlexPacket(input) {
  let view;
  if (input instanceof DataView) {
    view = input;
  } else if (input instanceof ArrayBuffer) {
    view = new DataView(input);
  } else if (ArrayBuffer.isView(input)) {
    view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  } else {
    return null;
  }

  if (view.byteLength !== BLE_PACKET_LENGTH) return null;
  if (view.getUint8(0) !== BLE_PACKET_MAGIC) return null;
  if (view.getUint8(1) !== BLE_PROTOCOL_VERSION) return null;

  const sampleId = view.getUint16(2, true);
  const timestampMs = view.getUint32(4, true);
  const raw = Object.fromEntries(FINGERS.map(({ key }, index) => [
    key,
    view.getUint16(8 + index * 2, true),
  ]));
  if (!Object.values(raw).every((value) => value <= ADC_MAX)) return null;

  const connectedMask = view.getUint8(18);
  const errorCode = view.getUint8(19);
  const rawLine = [sampleId, timestampMs, ...FINGERS.map(({ key }) => raw[key])].join(",");
  return { sampleId, timestampMs, raw, connectedMask, errorCode, rawLine };
}

export function normalizeFlex(raw, openValue, closedValue, minSpan = 80) {
  if (![raw, openValue, closedValue].every(Number.isFinite)) return null;
  const span = closedValue - openValue;
  if (Math.abs(span) < minSpan) return null;
  return clamp(((raw - openValue) / span) * 100, 0, 100);
}

export function median(values) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2
    ? finite[middle]
    : (finite[middle - 1] + finite[middle]) / 2;
}

export class EmaBank {
  constructor(alpha = 0.2) {
    this.alpha = alpha;
    this.values = Object.fromEntries(FINGERS.map(({ key }) => [key, null]));
  }

  update(raw) {
    for (const { key } of FINGERS) {
      const previous = this.values[key];
      this.values[key] = previous === null
        ? raw[key]
        : this.alpha * raw[key] + (1 - this.alpha) * previous;
    }
    return { ...this.values };
  }

  reset() {
    for (const { key } of FINGERS) this.values[key] = null;
  }
}
