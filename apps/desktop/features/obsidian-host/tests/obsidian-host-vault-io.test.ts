import { describe, expect, it } from "vite-plus/test";
import { statFromProbe } from "../web/host/api/vault-io-tauri";

describe("statFromProbe", () => {
  it("reports folders the directory listing hides as folders", () => {
    expect(statFromProbe({ exists: true, is_file: false, is_dir: true, size: null }).type).toBe(
      "folder",
    );
  });
  it("reports files with their size, and unknown entries as empty files", () => {
    expect(statFromProbe({ exists: true, is_file: true, is_dir: false, size: 12 })).toMatchObject({
      type: "file",
      size: 12,
    });
    expect(statFromProbe(undefined)).toMatchObject({ type: "file", size: 0 });
  });
});
