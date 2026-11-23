import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appBinary } from "./app-binary.mjs";

// Built by `pnpm run build:app`; app-binary.mjs knows where it lands on each OS.
const APP_BINARY = appBinary();

/** @type {import('node:child_process').ChildProcess | undefined} */
let proxy;

/** @type {import('@wdio/types').Options.Testrunner} */
export const config = {
  runner: "local",
  specs: ["./specs/**/*.spec.js"],
  maxInstances: 1,
  capabilities: [
    {
      "tauri:options": {
        application: APP_BINARY,
      },
    },
  ],
  hostname: "127.0.0.1",
  port: 4444,
  path: "/",
  framework: "mocha",
  reporters: ["spec"],
  logLevel: "warn",
  waitforTimeout: 15_000,
  connectionRetryTimeout: 30_000,
  connectionRetryCount: 0,
  mochaOpts: {
    ui: "bdd",
    timeout: 60_000,
  },

  onPrepare: async function () {
    if (!existsSync(APP_BINARY)) {
      throw new Error(
        `App binary not found at ${APP_BINARY}\n` +
          "Run `pnpm run build:app` first (or use `pnpm run test:e2e`).",
      );
    }

    proxy = spawn("tauri-webdriver", [], { stdio: "inherit" });
    proxy.on("error", (err) => {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
        console.error(
          "tauri-webdriver not found on PATH.\n" +
            "Install once with: cargo install tauri-webdriver --locked",
        );
      }
    });

    // Give the intermediary a moment to bind to localhost:4444 before wdio
    // tries to create a session.
    await new Promise((r) => setTimeout(r, 1500));
  },

  onComplete: async function () {
    if (proxy && !proxy.killed) {
      const exited = new Promise((r) => proxy.once("exit", r));
      proxy.kill("SIGTERM");
      // Wait for clean exit so a follow-up run doesn't hit "port in use".
      await exited;
    }
  },
};
