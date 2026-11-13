// `string_decoder`: multi-byte safe incremental decoding.
import { Buffer, decodeBytes, normalizeEncoding } from "./buffer";
import { nodeError } from "./errors";

type Enc = NonNullable<ReturnType<typeof normalizeEncoding>>;

export class StringDecoder {
  readonly encoding: Enc;
  private td: TextDecoder | null = null;
  private pending: Uint8Array = new Uint8Array(0); // base64 remainder bytes

  constructor(encoding?: string) {
    const enc = normalizeEncoding(encoding);
    if (!enc) throw nodeError("ERR_UNKNOWN_ENCODING", `Unknown encoding: ${String(encoding)}`);
    this.encoding = enc;
    if (enc === "utf8") this.td = new TextDecoder("utf-8", { ignoreBOM: true });
    else if (enc === "utf16le") this.td = new TextDecoder("utf-16le", { ignoreBOM: true });
  }

  write(buf: string | Uint8Array): string {
    if (typeof buf === "string") return buf;
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf as ArrayBufferLike);
    if (this.td) return this.td.decode(bytes, { stream: true });
    if (this.encoding === "base64" || this.encoding === "base64url") {
      const all = Buffer.concat([this.pending, bytes]);
      const keep = all.length % 3;
      this.pending = all.slice(all.length - keep);
      return decodeBytes(all, this.encoding, 0, all.length - keep);
    }
    return decodeBytes(bytes, this.encoding);
  }

  end(buf?: string | Uint8Array): string {
    let out = buf === undefined ? "" : this.write(buf);
    if (this.td) out += this.td.decode(new Uint8Array(0), { stream: false });
    else if (this.pending.length) {
      out += decodeBytes(this.pending, this.encoding);
      this.pending = new Uint8Array(0);
    }
    return out;
  }
}
