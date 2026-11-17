// `buffer`: a Buffer that is a Uint8Array subclass (utf8, hex, base64, base64url, latin1/binary,
// ascii, utf16le). Not pooled; `new Buffer()` is accepted but `Buffer.from/alloc` are the API.
import { nodeError } from "./errors";

export type Encoding =
  | "utf8"
  | "utf-8"
  | "hex"
  | "base64"
  | "base64url"
  | "latin1"
  | "binary"
  | "ascii"
  | "ucs2"
  | "ucs-2"
  | "utf16le"
  | "utf-16le";

const textEncoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true });

export function normalizeEncoding(
  enc: unknown,
): "utf8" | "hex" | "base64" | "base64url" | "latin1" | "ascii" | "utf16le" | undefined {
  if (enc === undefined || enc === null || enc === "") return "utf8";
  switch ((typeof enc === "string" ? enc : "").toLowerCase()) {
    case "utf8":
    case "utf-8":
      return "utf8";
    case "hex":
      return "hex";
    case "base64":
      return "base64";
    case "base64url":
      return "base64url";
    case "latin1":
    case "binary":
      return "latin1";
    case "ascii":
      return "ascii";
    case "ucs2":
    case "ucs-2":
    case "utf16le":
    case "utf-16le":
      return "utf16le";
    default:
      return undefined;
  }
}

function needEncoding(enc: unknown): NonNullable<ReturnType<typeof normalizeEncoding>> {
  const n = normalizeEncoding(enc);
  if (!n)
    throw nodeError("ERR_UNKNOWN_ENCODING", `Unknown encoding: ${String(enc)}`, {
      name: "TypeError",
    });
  return n;
}

export function bytesToBinaryString(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let out = "";
  const STEP = 0x4000;
  for (let i = start; i < end; i += STEP) {
    out += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(end, i + STEP)) as unknown as number[],
    );
  }
  return out;
}

function base64ToBytes(input: string): Uint8Array {
  let s = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/[^A-Za-z0-9+/]/g, "");
  // Node stops at the first '=' padding; the sanitiser above already dropped them.
  const rem = s.length % 4;
  if (rem === 1) s = s.slice(0, -1);
  else if (rem > 1) s += "=".repeat(4 - rem);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexToBytes(s: string): Uint8Array {
  const n = s.length >> 1;
  const out = new Uint8Array(n);
  let i = 0;
  for (; i < n; i++) {
    const byte = parseInt(s.substr(i * 2, 2), 16);
    if (!/^[0-9a-fA-F]{2}$/.test(s.substr(i * 2, 2))) break;
    out[i] = byte;
  }
  return out.subarray(0, i);
}

/** Encodes a JS string into bytes. */
export function encodeString(str: string, enc: unknown): Uint8Array {
  switch (needEncoding(enc)) {
    case "utf8":
      return textEncoder.encode(str);
    case "hex":
      return hexToBytes(str);
    case "base64":
    case "base64url":
      return base64ToBytes(str);
    case "latin1":
    case "ascii": {
      const out = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
      return out;
    }
    case "utf16le": {
      const out = new Uint8Array(str.length * 2);
      for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        out[i * 2] = c & 0xff;
        out[i * 2 + 1] = c >> 8;
      }
      return out;
    }
  }
}

/** Decodes bytes[start,end) into a JS string. */
export function decodeBytes(
  bytes: Uint8Array,
  enc: unknown,
  start = 0,
  end = bytes.length,
): string {
  const view = start === 0 && end === bytes.length ? bytes : bytes.subarray(start, end);
  switch (needEncoding(enc)) {
    case "utf8":
      return utf8Decoder.decode(view);
    case "hex": {
      let out = "";
      for (let i = 0; i < view.length; i++) out += (view[i] < 16 ? "0" : "") + view[i].toString(16);
      return out;
    }
    case "base64":
      return btoa(bytesToBinaryString(view));
    case "base64url":
      return btoa(bytesToBinaryString(view))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    case "latin1":
      return bytesToBinaryString(view);
    case "ascii": {
      let out = "";
      for (let i = 0; i < view.length; i++) out += String.fromCharCode(view[i] & 0x7f);
      return out;
    }
    case "utf16le": {
      let out = "";
      for (let i = 0; i + 1 < view.length; i += 2)
        out += String.fromCharCode(view[i] | (view[i + 1] << 8));
      return out;
    }
  }
}

function rangeError(name: string, offset: number, max: number): RangeError {
  const e = new RangeError(
    `The value of "${name}" is out of range. It must be >= 0 and <= ${max}. Received ${offset}`,
  );
  (e as RangeError & { code: string }).code = "ERR_OUT_OF_RANGE";
  return e;
}

// Node's Buffer is a class with aliases added at runtime; the interface declares those aliases.
// eslint-disable-next-line typescript/no-unsafe-declaration-merging
export interface Buffer {
  readUint8: Buffer["readUInt8"];
  readUint16LE: Buffer["readUInt16LE"];
  readUint16BE: Buffer["readUInt16BE"];
  readUint32LE: Buffer["readUInt32LE"];
  readUint32BE: Buffer["readUInt32BE"];
  writeUint8: Buffer["writeUInt8"];
  writeUint16LE: Buffer["writeUInt16LE"];
  writeUint16BE: Buffer["writeUInt16BE"];
  writeUint32LE: Buffer["writeUInt32LE"];
  writeUint32BE: Buffer["writeUInt32BE"];
}
export class Buffer extends Uint8Array {
  static readonly poolSize = 8192;

  constructor(arg: number | ArrayBufferLike, byteOffset?: number, length?: number) {
    super(arg as ArrayBuffer, byteOffset, length);
  }

  static from(value: string, encoding?: string): Buffer;
  static from(value: ArrayBufferLike, byteOffset?: number, length?: number): Buffer;
  static from(value: ArrayLike<number> | Iterable<number>): Buffer;
  static from(value: { type: "Buffer"; data: number[] }): Buffer;
  static from(value: any, a?: any, b?: any): Buffer {
    if (typeof value === "string") {
      const bytes = encodeString(value, a);
      return new Buffer(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.length);
    }
    if (
      value instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)
    ) {
      const off = a ?? 0;
      return new Buffer(value, off, b ?? value.byteLength - off);
    }
    if (ArrayBuffer.isView(value)) {
      const out = new Buffer(value.byteLength);
      out.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      return out;
    }
    if (value && typeof value === "object") {
      if (value.type === "Buffer" && Array.isArray(value.data)) return Buffer.from(value.data);
      const arr = Array.from(value as ArrayLike<number>);
      const out = new Buffer(arr.length);
      for (let i = 0; i < arr.length; i++) out[i] = arr[i] & 0xff;
      return out;
    }
    throw nodeError(
      "ERR_INVALID_ARG_TYPE",
      "The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object.",
      { name: "TypeError" },
    );
  }

  static alloc(size: number, fill?: number | string | Uint8Array, encoding?: string): Buffer {
    const b = new Buffer(size);
    if (fill !== undefined && fill !== 0) b.fill(fill as number, 0, size, encoding);
    return b;
  }
  static allocUnsafe(size: number): Buffer {
    return new Buffer(size);
  }
  static allocUnsafeSlow(size: number): Buffer {
    return new Buffer(size);
  }

  static isBuffer(value: unknown): value is Buffer {
    return value instanceof Buffer;
  }
  static isEncoding(enc: unknown): boolean {
    return typeof enc === "string" && normalizeEncoding(enc) !== undefined && enc !== "";
  }

  static byteLength(value: string | ArrayBufferView | ArrayBuffer, encoding?: string): number {
    if (typeof value === "string") return encodeString(value, encoding).length;
    return value.byteLength;
  }

  static concat(list: readonly Uint8Array[], totalLength?: number): Buffer {
    const total = totalLength ?? list.reduce((n, b) => n + b.length, 0);
    const out = new Buffer(total);
    let pos = 0;
    for (const b of list) {
      if (pos >= total) break;
      const take = Math.min(b.length, total - pos);
      out.set(take === b.length ? b : b.subarray(0, take), pos);
      pos += take;
    }
    return out;
  }

  static compare(a: Uint8Array, b: Uint8Array): -1 | 0 | 1 {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  }

  toString(encoding?: string, start?: number, end?: number): string {
    const s = Math.max(0, start ?? 0);
    const e = Math.min(this.length, end ?? this.length);
    if (e <= s) return "";
    return decodeBytes(this, encoding, s, e);
  }
  toJSON(): { type: "Buffer"; data: number[] } {
    return { type: "Buffer", data: Array.from(this) };
  }
  equals(other: Uint8Array): boolean {
    return Buffer.compare(this, other) === 0;
  }
  compare(other: Uint8Array): -1 | 0 | 1 {
    return Buffer.compare(this, other);
  }

  /** Like Node: shares memory with the original (unlike Uint8Array#slice). */
  slice(start?: number, end?: number): Buffer {
    return this.subarray(start, end) as Buffer;
  }
  subarray(start?: number, end?: number): Buffer {
    const sub = super.subarray(start, end);
    return new Buffer(sub.buffer as ArrayBuffer, sub.byteOffset, sub.length);
  }

  private needle(value: string | number | Uint8Array, encoding?: string): Uint8Array {
    if (typeof value === "number") return Uint8Array.of(value & 0xff);
    if (typeof value === "string") return encodeString(value, encoding);
    return value;
  }
  indexOf(value: string | number | Uint8Array, byteOffset = 0, encoding?: string): number {
    const n = this.needle(
      value,
      typeof byteOffset === "string" ? (byteOffset as string) : encoding,
    );
    let from = typeof byteOffset === "number" ? byteOffset : 0;
    if (from < 0) from = Math.max(0, this.length + from);
    if (n.length === 0) return Math.min(from, this.length);
    outer: for (let i = from; i <= this.length - n.length; i++) {
      for (let j = 0; j < n.length; j++) if (this[i + j] !== n[j]) continue outer;
      return i;
    }
    return -1;
  }
  lastIndexOf(value: string | number | Uint8Array, byteOffset?: number, encoding?: string): number {
    const n = this.needle(value, encoding);
    let from = byteOffset === undefined ? this.length - n.length : byteOffset;
    if (from < 0) from = this.length + from;
    from = Math.min(from, this.length - n.length);
    outer: for (let i = from; i >= 0; i--) {
      for (let j = 0; j < n.length; j++) if (this[i + j] !== n[j]) continue outer;
      return i;
    }
    return -1;
  }
  includes(value: string | number | Uint8Array, byteOffset?: number, encoding?: string): boolean {
    return this.indexOf(value, byteOffset, encoding) !== -1;
  }

  fill(
    value: number | string | Uint8Array,
    start?: number | string,
    end?: number | string,
    encoding?: string,
  ): this {
    if (typeof value === "number") {
      super.fill(value & 0xff, start as number, end as number);
      return this;
    }
    if (typeof start === "string") {
      encoding = start;
      start = 0;
      end = this.length;
    } else if (typeof end === "string") {
      encoding = end;
      end = this.length;
    }
    const s = (start as number | undefined) ?? 0;
    const e = (end as number | undefined) ?? this.length;
    const pattern = typeof value === "string" ? encodeString(value, encoding) : value;
    if (pattern.length === 0) return super.fill(0, s, e) as this;
    for (let i = s, j = 0; i < e; i++, j = (j + 1) % pattern.length) this[i] = pattern[j];
    return this;
  }

  write(
    string: string,
    offset?: number | string,
    length?: number | string,
    encoding?: string,
  ): number {
    if (typeof offset === "string") {
      encoding = offset;
      offset = 0;
      length = undefined;
    } else if (typeof length === "string") {
      encoding = length;
      length = undefined;
    }
    const off = (offset as number | undefined) ?? 0;
    const bytes = encodeString(string, encoding);
    const n = Math.min(
      bytes.length,
      (length as number | undefined) ?? this.length - off,
      this.length - off,
    );
    this.set(bytes.subarray(0, n), off);
    return n;
  }

  copy(target: Uint8Array, targetStart = 0, sourceStart = 0, sourceEnd = this.length): number {
    const src = this.subarray(sourceStart, sourceEnd);
    const n = Math.max(0, Math.min(src.length, target.length - targetStart));
    target.set(src.subarray(0, n), targetStart);
    return n;
  }

  private check(offset: number, size: number): number {
    if (!Number.isInteger(offset) || offset < 0 || offset + size > this.length)
      throw rangeError("offset", offset, this.length - size);
    return offset;
  }
  private dv(): DataView {
    return new DataView(this.buffer, this.byteOffset, this.byteLength);
  }
  readUInt8(o = 0): number {
    return this[this.check(o, 1)];
  }
  readInt8(o = 0): number {
    return this.dv().getInt8(this.check(o, 1));
  }
  readUInt16LE(o = 0): number {
    return this.dv().getUint16(this.check(o, 2), true);
  }
  readUInt16BE(o = 0): number {
    return this.dv().getUint16(this.check(o, 2), false);
  }
  readInt16LE(o = 0): number {
    return this.dv().getInt16(this.check(o, 2), true);
  }
  readInt16BE(o = 0): number {
    return this.dv().getInt16(this.check(o, 2), false);
  }
  readUInt32LE(o = 0): number {
    return this.dv().getUint32(this.check(o, 4), true);
  }
  readUInt32BE(o = 0): number {
    return this.dv().getUint32(this.check(o, 4), false);
  }
  readInt32LE(o = 0): number {
    return this.dv().getInt32(this.check(o, 4), true);
  }
  readInt32BE(o = 0): number {
    return this.dv().getInt32(this.check(o, 4), false);
  }
  readDoubleLE(o = 0): number {
    return this.dv().getFloat64(this.check(o, 8), true);
  }
  readDoubleBE(o = 0): number {
    return this.dv().getFloat64(this.check(o, 8), false);
  }
  writeUInt8(v: number, o = 0): number {
    this[this.check(o, 1)] = v;
    return o + 1;
  }
  writeUInt16LE(v: number, o = 0): number {
    this.dv().setUint16(this.check(o, 2), v, true);
    return o + 2;
  }
  writeUInt16BE(v: number, o = 0): number {
    this.dv().setUint16(this.check(o, 2), v, false);
    return o + 2;
  }
  writeUInt32LE(v: number, o = 0): number {
    this.dv().setUint32(this.check(o, 4), v, true);
    return o + 4;
  }
  writeUInt32BE(v: number, o = 0): number {
    this.dv().setUint32(this.check(o, 4), v, false);
    return o + 4;
  }
}

// Lower-case aliases Node also has.
const proto = Buffer.prototype as unknown as Record<string, unknown>;
for (const n of ["UInt8", "UInt16LE", "UInt16BE", "UInt32LE", "UInt32BE"]) {
  proto[`readUint${n.slice(4)}`] = proto[`readUInt${n.slice(4)}`];
  proto[`writeUint${n.slice(4)}`] = proto[`writeUInt${n.slice(4)}`];
}

export const kMaxLength = 2 ** 32;
export const constants = { MAX_LENGTH: kMaxLength, MAX_STRING_LENGTH: 2 ** 29 - 24 };

export const bufferModule = {
  Buffer,
  kMaxLength,
  constants,
  SlowBuffer: Buffer,
  atob: globalThis.atob?.bind(globalThis),
  btoa: globalThis.btoa?.bind(globalThis),
  Blob: (globalThis as { Blob?: unknown }).Blob,
};
