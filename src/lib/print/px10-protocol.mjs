// SPDX-License-Identifier: Apache-2.0
// Tiny/d1 packet and line encoding adapted from TiMini-Print v0.9.
// https://github.com/Dejniel/TiMini-Print/tree/v0.9
// See ../../../static/px10/LICENSE.txt and NOTICE.txt. No hardware access here.
export const WIDTH = 384;
export const HEIGHT = 480;
export const PRINTER_NAME = 'Luxorp.PX10-DAAF';

/** @param {ArrayLike<number>} bytes */
export function crc8(bytes) {
  let crc = 0;
  for (const byte of Array.from(bytes)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 128 ? 7 : 0)) & 255;
  }
  return crc;
}

/** @param {number} opcode @param {Uint8Array|number[]} [payload] */
export function packet(opcode, payload = new Uint8Array()) {
  const result = new Uint8Array(payload.length + 8);
  result.set([0x51, 0x78, opcode, 0, payload.length & 255, payload.length >> 8], 0);
  result.set(payload, 6);
  result.set([crc8(payload), 0xff], result.length - 2);
  return result;
}

/** @param {number[]} output @param {number} color @param {number} count */
function appendRun(output, color, count) {
  while (count > 127) { output.push((color << 7) | 127); count -= 127; }
  if (count) output.push((color << 7) | count);
}

/** @param {Uint8Array} line */
export function encodeLine(line) {
  if (line.length !== WIDTH) throw new Error('PX10 krev 384 pikslar per rad.');
  /** @type {number[]} */ const runs = [];
  let previous = line[0], count = 1;
  for (let i = 1; i < line.length; i++) {
    if (line[i] === previous) count++;
    else { appendRun(runs, previous, count); previous = line[i]; count = 1; }
  }
  appendRun(runs, previous, count);
  if (runs.length <= WIDTH / 8) return packet(0xbf, new Uint8Array(runs));
  const packed = new Uint8Array(WIDTH / 8);
  for (let i = 0; i < WIDTH; i++) if (line[i]) packed[i >> 3] |= 1 << (i & 7);
  return packet(0xa2, packed);
}

/** @param {Uint8Array[]} parts */
export function joinBytes(parts) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

/** @param {Uint8Array} pixels */
export function buildPrintJob(pixels) {
  const height = pixels.length / WIDTH;
  if (!Number.isInteger(height) || height < 1 || height > 1024) throw new Error('Ugyldig biletstorleik.');
  if (pixels.some(value => value !== 0 && value !== 1)) throw new Error('Biletet må vere svart og kvitt.');
  // Pocket Printer/d1: blackening 3, image energy 5000, speed 10, LSB-first.
  const parts = [packet(0xa4, [0x33]), packet(0xaf, [0x88, 0x13]),
    packet(0xbe, [0]), packet(0xbd, [10])];
  for (let row = 0; row < height; row++) {
    parts.push(encodeLine(pixels.subarray(row * WIDTH, (row + 1) * WIDTH)));
    if ((row + 1) % 200 === 0) parts.push(packet(0xbd, [10]));
  }
  parts.push(packet(0xbd, [12]), packet(0xa1, [0x30, 0]),
    packet(0xa1, [0x30, 0]), packet(0xbd, [12]), packet(0xa3, [0]));
  return joinBytes(parts);
}

export class PacketDecoder {
  constructor() { /** @type {Uint8Array} */ this.buffer = new Uint8Array(); }
  /** @param {Uint8Array} bytes */
  feed(bytes) {
    this.buffer = joinBytes([this.buffer, bytes]);
    const frames = [];
    while (this.buffer.length) {
      let marker = -1;
      for (let i = 0; i + 1 < this.buffer.length; i++) {
        if (this.buffer[i] === 0x51 && this.buffer[i + 1] === 0x78) { marker = i; break; }
      }
      if (marker < 0) {
        this.buffer = this.buffer.at(-1) === 0x51 ? new Uint8Array([0x51]) : new Uint8Array();
        break;
      }
      if (marker) this.buffer = this.buffer.slice(marker);
      if (this.buffer.length < 6) break;
      const length = this.buffer[4] | (this.buffer[5] << 8);
      if (length > 4096) { this.buffer = this.buffer.slice(1); continue; }
      if (this.buffer.length < length + 8) break;
      const payload = this.buffer.slice(6, 6 + length);
      if (this.buffer[length + 7] !== 0xff || crc8(payload) !== this.buffer[length + 6]) {
        this.buffer = this.buffer.slice(1); continue;
      }
      frames.push({ opcode: this.buffer[2], flags: this.buffer[3], payload });
      this.buffer = this.buffer.slice(length + 8);
    }
    return frames;
  }
}
