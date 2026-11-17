// `crypto`: randomBytes/randomUUID/randomInt (WebCrypto), synchronous createHash for sha256 and
// sha1, createHmac over them, timingSafeEqual. Other algorithms throw.
import { Buffer, encodeString } from "./buffer";
import { nodeError } from "./errors";

type Data = string | Uint8Array | ArrayBufferView;

const toBytes = (data: Data, enc?: string): Uint8Array => {
  if (typeof data === "string") return encodeString(data, enc);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw nodeError(
    "ERR_INVALID_ARG_TYPE",
    'The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView',
    {
      name: "TypeError",
    },
  );
};

const rotl = (x: number, n: number): number => (x << n) | (x >>> (32 - n));
const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

interface Algo {
  blockSize: number;
  digest(msg: Uint8Array): Uint8Array;
}

/** Merkle-Damgard padding for a 64-byte block hash with a 64-bit big-endian bit length. */
function pad(msg: Uint8Array): Uint8Array {
  const total = (((msg.length + 8) >> 6) + 1) << 6;
  const out = new Uint8Array(total);
  out.set(msg);
  out[msg.length] = 0x80;
  const dv = new DataView(out.buffer);
  dv.setUint32(total - 8, Math.floor((msg.length * 8) / 2 ** 32), false);
  dv.setUint32(total - 4, (msg.length * 8) >>> 0, false);
  return out;
}

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const sha256: Algo = {
  blockSize: 64,
  digest(msg) {
    const h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
      0x5be0cd19,
    ]);
    const data = pad(msg);
    const dv = new DataView(data.buffer);
    const w = new Uint32Array(64);
    for (let off = 0; off < data.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + K256[i] + w[i]) | 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) | 0;
        hh = g;
        g = f;
        f = e;
        e = (d + t1) | 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) | 0;
      }
      h[0] += a;
      h[1] += b;
      h[2] += c;
      h[3] += d;
      h[4] += e;
      h[5] += f;
      h[6] += g;
      h[7] += hh;
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    h.forEach((v, i) => odv.setUint32(i * 4, v, false));
    return out;
  },
};

const sha1: Algo = {
  blockSize: 64,
  digest(msg) {
    const h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
    const data = pad(msg);
    const dv = new DataView(data.buffer);
    const w = new Uint32Array(80);
    for (let off = 0; off < data.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
      for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
      let [a, b, c, d, e] = h;
      for (let i = 0; i < 80; i++) {
        let f: number;
        let k: number;
        if (i < 20) {
          f = (b & c) | (~b & d);
          k = 0x5a827999;
        } else if (i < 40) {
          f = b ^ c ^ d;
          k = 0x6ed9eba1;
        } else if (i < 60) {
          f = (b & c) | (b & d) | (c & d);
          k = 0x8f1bbcdc;
        } else {
          f = b ^ c ^ d;
          k = 0xca62c1d6;
        }
        const t = (rotl(a, 5) + f + e + k + w[i]) | 0;
        e = d;
        d = c;
        c = rotl(b, 30);
        b = a;
        a = t;
      }
      h[0] += a;
      h[1] += b;
      h[2] += c;
      h[3] += d;
      h[4] += e;
    }
    const out = new Uint8Array(20);
    const odv = new DataView(out.buffer);
    h.forEach((v, i) => odv.setUint32(i * 4, v, false));
    return out;
  },
};

const ALGOS: Record<string, Algo> = { sha256, sha1, "sha-256": sha256, "sha-1": sha1 };
const algoOf = (name: string): Algo => {
  const a = ALGOS[String(name).toLowerCase()];
  if (!a)
    throw nodeError(
      "ERR_CRYPTO_INVALID_DIGEST",
      `Digest method not supported: ${name} (only sha256 and sha1)`,
    );
  return a;
};

const out = (bytes: Uint8Array, enc?: string): string | Buffer => {
  const b = Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.length);
  return enc === undefined || enc === "buffer" ? b : b.toString(enc);
};

class Hash {
  private chunks: Uint8Array[] = [];
  private done = false;
  constructor(private readonly algo: Algo) {}
  update(data: Data, enc?: string): this {
    if (this.done) throw nodeError("ERR_CRYPTO_HASH_FINALIZED", "Digest already called");
    this.chunks.push(Uint8Array.from(toBytes(data, enc)));
    return this;
  }
  digest(enc?: string): string | Buffer {
    if (this.done) throw nodeError("ERR_CRYPTO_HASH_FINALIZED", "Digest already called");
    this.done = true;
    return out(this.algo.digest(Buffer.concat(this.chunks)), enc);
  }
  copy(): Hash {
    const h = new Hash(this.algo);
    h.chunks = [...this.chunks];
    return h;
  }
}

class Hmac {
  private chunks: Uint8Array[] = [];
  private done = false;
  private readonly key: Uint8Array;
  constructor(
    private readonly algo: Algo,
    key: Data,
  ) {
    let k = toBytes(key);
    if (k.length > algo.blockSize) k = algo.digest(k);
    this.key = new Uint8Array(algo.blockSize);
    this.key.set(k);
  }
  update(data: Data, enc?: string): this {
    this.chunks.push(Uint8Array.from(toBytes(data, enc)));
    return this;
  }
  digest(enc?: string): string | Buffer {
    if (this.done) throw nodeError("ERR_CRYPTO_HASH_FINALIZED", "Digest already called");
    this.done = true;
    const ipad = this.key.map((b) => b ^ 0x36);
    const opad = this.key.map((b) => b ^ 0x5c);
    const inner = this.algo.digest(Buffer.concat([ipad, ...this.chunks]));
    return out(this.algo.digest(Buffer.concat([opad, inner])), enc);
  }
}

function randomBytes(size: number, cb?: (err: Error | null, buf: Buffer) => void): Buffer | void {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 65536)
    globalThis.crypto.getRandomValues(buf.subarray(i, Math.min(size, i + 65536)));
  if (cb) {
    queueMicrotask(() => cb(null, buf));
    return;
  }
  return buf;
}

export const cryptoModule = {
  randomBytes,
  randomUUID: (): string => globalThis.crypto.randomUUID(),
  randomInt(min: number, max?: number): number {
    const lo = max === undefined ? 0 : min;
    const hi = max === undefined ? min : max;
    const span = hi - lo;
    if (!(span > 0)) throw nodeError("ERR_OUT_OF_RANGE", 'The value of "max" is out of range');
    const limit = Math.floor(2 ** 32 / span) * span;
    const buf = new Uint32Array(1);
    do globalThis.crypto.getRandomValues(buf);
    while (buf[0] >= limit);
    return lo + (buf[0] % span);
  },
  getRandomValues: <T extends ArrayBufferView>(a: T): T =>
    globalThis.crypto.getRandomValues(a as never) as T,
  createHash: (algorithm: string): Hash => new Hash(algoOf(algorithm)),
  createHmac: (algorithm: string, key: Data): Hmac => new Hmac(algoOf(algorithm), key),
  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length)
      throw nodeError(
        "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH",
        "Input buffers must have the same byte length",
      );
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  },
  getHashes: (): string[] => ["sha1", "sha256"],
  webcrypto: globalThis.crypto,
  subtle: globalThis.crypto?.subtle,
};
