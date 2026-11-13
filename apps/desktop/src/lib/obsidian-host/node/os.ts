// `os`: values come from the one-time `plugin_os_info` preload (state.ts); defaults before it.
import { getOsInfo } from "./state";

const typeOf = (platform: string): string =>
  platform === "darwin" ? "Darwin" : platform === "win32" ? "Windows_NT" : "Linux";

export const osModule = {
  homedir: (): string => getOsInfo().homedir,
  tmpdir: (): string => getOsInfo().tmpdir,
  platform: (): string => getOsInfo().platform,
  arch: (): string => getOsInfo().arch,
  type: (): string => typeOf(getOsInfo().platform),
  release: (): string => "0.0.0",
  version: (): string => "",
  machine: (): string => getOsInfo().arch,
  hostname: (): string => "localhost",
  endianness: (): "LE" | "BE" => "LE",
  userInfo: () => {
    const i = getOsInfo();
    return { username: i.username, uid: -1, gid: -1, shell: i.shell, homedir: i.homedir };
  },
  // Not exposed by the host: stubs so capability probes don't crash.
  cpus: (): unknown[] => [],
  availableParallelism: (): number => 1,
  totalmem: (): number => 0,
  freemem: (): number => 0,
  uptime: (): number => 0,
  loadavg: (): number[] => [0, 0, 0],
  networkInterfaces: (): Record<string, unknown> => ({}),
  get EOL(): string {
    return getOsInfo().platform === "win32" ? "\r\n" : "\n";
  },
  get devNull(): string {
    return getOsInfo().platform === "win32" ? "\\\\.\\nul" : "/dev/null";
  },
  constants: {
    signals: { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 } as Record<string, number>,
  },
};
