// `readline`: createInterface over a Readable; 'line' / 'close', async iteration, close().
// Line breaks are \n, \r\n and a lone \r. No terminal handling (history, cursor, prompts beyond
// question()).
import { EventEmitter } from "./events";
import { StringDecoder } from "./string-decoder";

interface InputLike {
  on(ev: string, fn: (...a: any[]) => void): unknown;
  removeListener(ev: string, fn: (...a: any[]) => void): unknown;
  pause?(): unknown;
  resume?(): unknown;
}
interface OutputLike {
  write(s: string): unknown;
}

export interface ReadLineOptions {
  input: InputLike;
  output?: OutputLike;
  crlfDelay?: number;
  terminal?: boolean;
  prompt?: string;
}

export class Interface extends EventEmitter {
  closed = false;
  terminal = false;
  line = "";
  private readonly input: InputLike;
  private readonly output?: OutputLike;
  private readonly decoder = new StringDecoder("utf8");
  private partial = "";
  private skipLF = false;
  private promptText = "> ";
  private questions: ((answer: string) => void)[] = [];

  private readonly onData = (chunk: unknown): void => {
    this.feed(typeof chunk === "string" ? chunk : this.decoder.write(chunk as Uint8Array));
  };
  private readonly onEnd = (): void => {
    const tail = this.decoder.end();
    if (tail) this.feed(tail);
    if (this.partial.length > 0) {
      const last = this.partial;
      this.partial = "";
      this.emitLine(last);
    }
    this.close();
  };

  constructor(inputOrOptions: InputLike | ReadLineOptions, output?: OutputLike) {
    super();
    const opts: ReadLineOptions =
      typeof (inputOrOptions as ReadLineOptions).input === "object" &&
      (inputOrOptions as ReadLineOptions).input !== null
        ? (inputOrOptions as ReadLineOptions)
        : { input: inputOrOptions as InputLike, output };
    this.input = opts.input;
    this.output = opts.output;
    if (opts.prompt !== undefined) this.promptText = opts.prompt;
    this.input.on("data", this.onData);
    this.input.on("end", this.onEnd);
    this.input.on("close", this.onEnd);
  }

  private feed(text: string): void {
    let s = text;
    if (this.skipLF) {
      this.skipLF = false;
      if (s.startsWith("\n")) s = s.slice(1);
    }
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c !== "\n" && c !== "\r") continue;
      const line = this.partial + s.slice(start, i);
      this.partial = "";
      if (c === "\r") {
        if (s[i + 1] === "\n") i++;
        else if (i + 1 === s.length) this.skipLF = true;
      }
      start = i + 1;
      this.emitLine(line);
      if (this.closed) return;
    }
    this.partial += s.slice(start);
  }

  private emitLine(line: string): void {
    const q = this.questions.shift();
    if (q) q(line);
    else this.emit("line", line);
  }

  setPrompt(p: string): void {
    this.promptText = p;
  }
  getPrompt(): string {
    return this.promptText;
  }
  prompt(): void {
    this.output?.write(this.promptText);
  }
  question(query: string, cb: (answer: string) => void): void {
    this.output?.write(query);
    this.questions.push(cb);
  }
  write(data: string): void {
    this.feed(data);
  }
  pause(): this {
    this.input.pause?.();
    this.emit("pause");
    return this;
  }
  resume(): this {
    this.input.resume?.();
    this.emit("resume");
    return this;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.input.removeListener("data", this.onData);
    this.input.removeListener("end", this.onEnd);
    this.input.removeListener("close", this.onEnd);
    this.emit("close");
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<string> {
    const queue: string[] = [];
    let done = this.closed;
    let wake: (() => void) | null = null;
    const onLine = (l: string): void => {
      queue.push(l);
      wake?.();
    };
    const onClose = (): void => {
      done = true;
      wake?.();
    };
    this.on("line", onLine);
    this.on("close", onClose);
    const cleanup = (): void => {
      this.removeListener("line", onLine);
      this.removeListener("close", onClose);
    };
    const self = this;
    return {
      async next(): Promise<IteratorResult<string>> {
        for (;;) {
          if (queue.length > 0) return { value: queue.shift()!, done: false };
          if (done) {
            cleanup();
            return { value: undefined, done: true };
          }
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      },
      async return(): Promise<IteratorResult<string>> {
        cleanup();
        self.close();
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}

export function createInterface(
  inputOrOptions: InputLike | ReadLineOptions,
  output?: OutputLike,
): Interface {
  return new Interface(inputOrOptions, output);
}

export const readlineModule = { Interface, createInterface };
