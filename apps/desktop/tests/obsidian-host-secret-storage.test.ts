import { describe, expect, it } from "vite-plus/test";
import { SecretStorage } from "../src/lib/obsidian-host/api/secret-storage";

describe("SecretStorage", () => {
  it("stores, lists and deletes secrets synchronously", () => {
    const s = new SecretStorage();
    expect(s.getSecret("a")).toBeNull();
    s.setSecret("a", "1");
    s.setSecret("b", "2");
    expect(s.getSecret("a")).toBe("1");
    expect(s.listSecrets()).toEqual(["a", "b"]);
    s.deleteSecret("a");
    expect(s.getSecret("a")).toBeNull();
  });
});
