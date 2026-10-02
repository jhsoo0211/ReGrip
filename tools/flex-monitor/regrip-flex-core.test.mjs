import assert from "node:assert/strict";
import { EmaBank, median, normalizeFlex, parseBleFlexPacket, parseFlexFrame } from "./regrip-flex-core.mjs";

assert.equal(parseFlexFrame("sample_id,timestamp_ms,thumb_raw,index_raw,middle_raw,ring_raw,little_raw"), null);
assert.equal(parseFlexFrame("# READY"), null);
assert.equal(parseFlexFrame("1,20,100,200,300,400"), null);
assert.equal(parseFlexFrame("1,20,100,200,300,400,5000"), null);

assert.deepEqual(parseFlexFrame("7,140,1780,4095,4095,1825,4095"), {
  sampleId: 7,
  timestampMs: 140,
  raw: { thumb: 1780, index: 4095, middle: 4095, ring: 1825, little: 4095 },
  rawLine: "7,140,1780,4095,4095,1825,4095",
});

const packetBytes = new Uint8Array(20);
const packet = new DataView(packetBytes.buffer);
packet.setUint8(0, 0x52);
packet.setUint8(1, 3);
packet.setUint16(2, 65535, true);
packet.setUint32(4, 123456, true);
[1780, 4095, 4095, 1825, 4095].forEach((value, index) => packet.setUint16(8 + index * 2, value, true));
packet.setUint8(18, 0b01001);
packet.setUint8(19, 0);
assert.deepEqual(parseBleFlexPacket(packet), {
  sampleId: 65535,
  timestampMs: 123456,
  raw: { thumb: 1780, index: 4095, middle: 4095, ring: 1825, little: 4095 },
  connectedMask: 0b01001,
  errorCode: 0,
  rawLine: "65535,123456,1780,4095,4095,1825,4095",
});
packet.setUint8(1, 2);
assert.equal(parseBleFlexPacket(packet), null);

assert.equal(normalizeFlex(1000, 1000, 2000), 0);
assert.equal(normalizeFlex(1500, 1000, 2000), 50);
assert.equal(normalizeFlex(2000, 1000, 2000), 100);
assert.equal(normalizeFlex(1500, 2000, 1000), 50);
assert.equal(normalizeFlex(1100, 1000, 1050), null);

assert.equal(median([5, 1, 3]), 3);
assert.equal(median([4, 2, 1, 3]), 2.5);
assert.equal(median([]), null);

const ema = new EmaBank(0.5);
assert.equal(ema.update({ thumb: 100, index: 200, middle: 300, ring: 400, little: 500 }).thumb, 100);
assert.equal(ema.update({ thumb: 200, index: 300, middle: 400, ring: 500, little: 600 }).thumb, 150);
ema.reset();
assert.equal(ema.update({ thumb: 50, index: 50, middle: 50, ring: 50, little: 50 }).thumb, 50);

console.log("regrip-flex-core: all tests passed");
