// Test fakes for the Node surface. Not exported from index.ts.
import { base64ToBytes, bytesToBase64 } from "../api/network";
import type { FsProbe, NodeIpc, NodeOsInfo, ProcEvent, ProcSignal, ProcSpawnRequest } from "./ipc";

export interface FakeProc {
  id: number;
  pid: number;
  request: ProcSpawnRequest;
  stdinWrites: string[];
  stdinClosed: boolean;
  kills: { signal?: ProcSignal; group?: boolean }[];
  emit(ev: ProcEvent): void;
  stdout(text: string | Uint8Array): void;
  stderr(text: string | Uint8Array): void;
  exit(code: number | null, signal?: string | null): void;
  error(code: string, message?: string): void;
  /** Called with each stdin write (decoded as UTF-8). */
  onStdin?: (text: string, proc: FakeProc) => void;
}

const enc = new TextEncoder();
const b64 = (d: string | Uint8Array): string =>
  bytesToBase64(typeof d === "string" ? enc.encode(d) : d);

export class FakeNodeIpc implements NodeIpc {
  procs: FakeProc[] = [];
  osinfo: NodeOsInfo = {
    platform: "darwin",
    arch: "arm64",
    homedir: "/Users/test",
    username: "test",
    shell: "/bin/zsh",
    tmpdir: "/var/tmp",
    env: { HOME: "/Users/test", PATH: "/usr/bin", LANG: "en_US.UTF-8" },
  };
  loginPath = "/opt/bin:/usr/bin";
  whichMap: Record<string, string | null> = { claude: "/Users/test/.local/bin/claude" };
  probes: Record<string, Partial<FsProbe>> = {};
  probeCalls: string[][] = [];
  openedUrls: string[] = [];
  openedPaths: { path: string; reveal: boolean }[] = [];
  /** Reject openUrl / openPath with this text. */
  openRejection: string | null = null;
  failWith: Partial<Record<"osInfo" | "resolveLoginPath" | "which" | "fsProbe", string>> = {};
  /** Reject procSpawn with this text (e.g. "EACCES: consent denied"). */
  spawnRejection: string | null = null;
  /** Deliver the 'spawn' event before procSpawn resolves (the real Channel may do this). */
  eventsBeforeResolve = false;
  /** Runs right after the spawn event; drive the fake process from here. */
  onSpawn?: (proc: FakeProc) => void;

  async procSpawn(request: ProcSpawnRequest, onEvent: (ev: ProcEvent) => void): Promise<number> {
    if (this.spawnRejection) throw this.spawnRejection;
    const id = this.procs.length + 1;
    const proc: FakeProc = {
      id,
      pid: 4000 + id,
      request,
      stdinWrites: [],
      stdinClosed: false,
      kills: [],
      emit: onEvent,
      stdout: (t) => onEvent({ type: "stdout", data_base64: b64(t) }),
      stderr: (t) => onEvent({ type: "stderr", data_base64: b64(t) }),
      exit: (code, signal = null) => onEvent({ type: "exit", code, signal }),
      error: (code, message = code) => onEvent({ type: "error", code, message }),
    };
    this.procs.push(proc);
    const start = (): void => {
      onEvent({ type: "spawn", pid: proc.pid });
      this.onSpawn?.(proc);
    };
    if (this.eventsBeforeResolve) {
      start();
      await new Promise((r) => setTimeout(r, 0));
    } else queueMicrotask(start);
    return id;
  }
  private proc(id: number): FakeProc {
    const p = this.procs.find((x) => x.id === id);
    if (!p) throw new Error(`no proc ${id}`);
    return p;
  }
  async procWrite(procId: number, dataBase64: string): Promise<void> {
    const p = this.proc(procId);
    const text = new TextDecoder().decode(base64ToBytes(dataBase64));
    p.stdinWrites.push(text);
    p.onStdin?.(text, p);
  }
  async procCloseStdin(procId: number): Promise<void> {
    this.proc(procId).stdinClosed = true;
  }
  async procKill(procId: number, signal?: ProcSignal, group?: boolean): Promise<void> {
    this.proc(procId).kills.push({ signal, group });
  }
  async which(name: string): Promise<string | null> {
    if (this.failWith.which) throw this.failWith.which;
    return this.whichMap[name] ?? null;
  }
  async resolveLoginPath(): Promise<string> {
    if (this.failWith.resolveLoginPath) throw this.failWith.resolveLoginPath;
    return this.loginPath;
  }
  async osInfo(): Promise<NodeOsInfo> {
    if (this.failWith.osInfo) throw this.failWith.osInfo;
    return this.osinfo;
  }
  async openUrl(url: string): Promise<void> {
    if (this.openRejection) throw this.openRejection;
    this.openedUrls.push(url);
  }
  async openPath(path: string, reveal: boolean): Promise<void> {
    if (this.openRejection) throw this.openRejection;
    this.openedPaths.push({ path, reveal });
  }
  async fsProbe(paths: string[]): Promise<FsProbe[]> {
    if (this.failWith.fsProbe) throw this.failWith.fsProbe;
    this.probeCalls.push(paths);
    return paths.map((path) => {
      const hit = this.probes[path];
      return {
        path,
        exists: hit?.exists ?? false,
        is_file: hit?.is_file ?? false,
        is_dir: hit?.is_dir ?? false,
        size: hit?.size ?? null,
        ...(hit?.entries ? { entries: hit.entries } : {}),
        ...(hit?.real ? { real: hit.real } : {}),
        ...(hit?.text !== undefined ? { text: hit.text } : {}),
      };
    });
  }
}

export const flush = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
