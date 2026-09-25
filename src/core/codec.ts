// Binary encoding for one chunk of columnar traffic, as stored in one SQLite BLOB.
//
// Layout, little endian, every column aligned for zero-copy typed array views:
//   0  magic "PCT1" (4 bytes)
//   4  start      u32
//   8  count      u32
//  12  seed       u32
//  16  reserved   u32
//  20  offsetMs   u32[count]
//      asn        u32[count]
//      path       u16[count]
//      country    u16[count]
//      userAgent  u16[count]
//      status     u16[count]
//      method     u8[count]
//      label      u8[count]
//
// Decoding creates views over the buffer instead of copying, which is the reason for the
// layout. The dictionary is not stored: it is a pure function of the scenario definition.

import { digestBytes } from "./random";
import type { ColumnarTraffic, TrafficDictionary } from "./types";

const MAGIC = [0x50, 0x43, 0x54, 0x31] as const; // "PCT1"
const HEADER_BYTES = 20;

export function encodedSize(count: number): number {
  return HEADER_BYTES + count * (4 + 4 + 2 + 2 + 2 + 2 + 1 + 1);
}

export function encodeTraffic(t: ColumnarTraffic): Uint8Array {
  const n = t.count;
  const buf = new ArrayBuffer(encodedSize(n));
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  bytes.set(MAGIC, 0);
  view.setUint32(4, t.start, true);
  view.setUint32(8, n, true);
  view.setUint32(12, t.seed >>> 0, true);
  view.setUint32(16, 0, true);

  let at = HEADER_BYTES;
  const put32 = (src: Uint32Array) => {
    new Uint32Array(buf, at, n).set(src);
    at += n * 4;
  };
  const put16 = (src: Uint16Array) => {
    new Uint16Array(buf, at, n).set(src);
    at += n * 2;
  };
  const put8 = (src: Uint8Array) => {
    bytes.set(src, at);
    at += n;
  };
  put32(t.offsetMs);
  put32(t.asn);
  put16(t.path);
  put16(t.country);
  put16(t.userAgent);
  put16(t.status);
  put8(t.method);
  put8(t.label);
  return bytes;
}

export type DecodeError = { kind: "decode-error"; message: string };

export function decodeTraffic(
  input: ArrayBuffer | Uint8Array,
  scenarioId: string,
  dictionary: TrafficDictionary,
): ColumnarTraffic | DecodeError {
  // Typed array views need 4-byte alignment. A Uint8Array handed to us from storage may sit
  // at an arbitrary offset, so copy once in that case only.
  let buf: ArrayBuffer;
  if (input instanceof Uint8Array) {
    buf =
      input.byteOffset % 4 === 0 && input.buffer instanceof ArrayBuffer
        ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
        : new Uint8Array(input).buffer;
  } else {
    buf = input;
  }
  if (buf.byteLength < HEADER_BYTES) return { kind: "decode-error", message: "blob too short" };
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) return { kind: "decode-error", message: "bad magic" };
  }
  const view = new DataView(buf);
  const start = view.getUint32(4, true);
  const n = view.getUint32(8, true);
  const seed = view.getUint32(12, true);
  if (buf.byteLength !== encodedSize(n)) {
    return { kind: "decode-error", message: `length ${buf.byteLength} does not match count ${n}` };
  }
  let at = HEADER_BYTES;
  const take32 = () => {
    const v = new Uint32Array(buf, at, n);
    at += n * 4;
    return v;
  };
  const take16 = () => {
    const v = new Uint16Array(buf, at, n);
    at += n * 2;
    return v;
  };
  const take8 = () => {
    const v = new Uint8Array(buf, at, n);
    at += n;
    return v;
  };
  const offsetMs = take32();
  const asn = take32();
  const path = take16();
  const country = take16();
  const userAgent = take16();
  const status = take16();
  const method = take8();
  const label = take8();
  return {
    scenarioId,
    seed,
    start,
    count: n,
    dictionary,
    offsetMs,
    method,
    path,
    country,
    asn,
    userAgent,
    status,
    label,
  };
}

/** Digest of one encoded chunk. */
export function chunkDigest(encoded: Uint8Array): string {
  return digestBytes(encoded);
}

/** Digest of a whole scenario: a digest over the ordered chunk digests. */
export function trafficDigest(chunkDigests: readonly string[]): string {
  return digestBytes(new TextEncoder().encode(chunkDigests.join(":")));
}
