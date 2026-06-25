// Framing unit tests for the CH341 wire protocol. No hardware/WebUSB needed:
//   node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import * as proto from "../src/protocol.js";

test("reverseByte matches known bit-reversals", () => {
  assert.equal(proto.reverseByte(0x00), 0x00);
  assert.equal(proto.reverseByte(0xff), 0xff);
  assert.equal(proto.reverseByte(0x01), 0x80);
  assert.equal(proto.reverseByte(0x80), 0x01);
  assert.equal(proto.reverseByte(0x1d), 0xb8); // 0001_1101 -> 1011_1000
  assert.equal(proto.reverseByte(0x07), 0xe0);
  assert.equal(proto.reverseByte(0x40), 0x02);
  assert.equal(proto.reverseByte(0xa8), 0x15); // 1010_1000 -> 0001_0101
});

test("reverseByte is an involution", () => {
  for (let b = 0; b < 256; b++) {
    assert.equal(proto.reverseByte(proto.reverseByte(b)), b);
  }
});

test("SPI stream: short read-register frame", () => {
  // SX126x ReadRegister(0x0740): [0x1D, 0x07, 0x40, NOP, NOP]
  const pkts = proto.buildSpiStreamPackets([0x1d, 0x07, 0x40, 0x00, 0x00]);
  assert.equal(pkts.length, 1);
  assert.deepEqual(Array.from(pkts[0]), [0xa8, 0xb8, 0xe0, 0x02, 0x00, 0x00]);
});

test("SPI stream: packetization boundaries (31 data bytes/packet)", () => {
  const len = (n) => proto.buildSpiStreamPackets(new Uint8Array(n)).map((p) => p.length);
  assert.deepEqual(len(0), []);
  assert.deepEqual(len(1), [2]);
  assert.deepEqual(len(31), [32]); // exactly one full packet
  assert.deepEqual(len(32), [32, 2]); // spill one byte
  assert.deepEqual(len(62), [32, 32]);
  assert.deepEqual(len(63), [32, 32, 2]);
});

test("SPI stream: total data bytes preserved across packets", () => {
  const src = Uint8Array.from({ length: 70 }, (_, i) => (i * 7 + 3) & 0xff);
  const pkts = proto.buildSpiStreamPackets(src);
  const flat = [];
  for (const p of pkts) for (let i = 1; i < p.length; i++) flat.push(proto.reverseByte(p[i]));
  assert.deepEqual(flat, Array.from(src)); // un-reversing the payload recovers src
});

test("UIO out frame drives state + direction without clobbering command bits", () => {
  // CS(D0)=high, RESET(D2)=output -> state bit0, dir bits 0 and 2
  assert.deepEqual(Array.from(proto.buildUioOut(0x01, 0x05)), [0xab, 0x81, 0x45, 0x20]);
  // masking: D7 in state must not leak into the 0x80 command bit
  assert.deepEqual(Array.from(proto.buildUioOut(0xff, 0xff)), [0xab, 0xbf, 0x7f, 0x20]);
});

test("UIO dir-only and get-input frames", () => {
  assert.deepEqual(Array.from(proto.buildUioDir(0x05)), [0xab, 0x45, 0x20]);
  assert.deepEqual(Array.from(proto.buildGetInput()), [0xa0]);
});

test("inputPin extracts D0..D7 from status byte 0", () => {
  const reply = Uint8Array.from([0b0101_0000, 0, 0, 0, 0, 0]); // D4 and D6 high
  assert.equal(proto.inputPin(reply, 4), 1);
  assert.equal(proto.inputPin(reply, 6), 1);
  assert.equal(proto.inputPin(reply, 5), 0);
  assert.equal(proto.inputPin(reply, 0), 0);
});
