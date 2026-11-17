// The TypeScript half of the agent roles contract (ADR "Define agent roles once and map them to
// each agent backend through adapters"): the same invariants as the Rust test in
// `src-tauri/src/agent/roles.rs`, over the same `shared/agent-roles.json`.
import { describe, expect, it } from "vite-plus/test";
import registry from "@shared/agent-roles.json";
import {
  AGENT_ROLES,
  AGENT_TIERS,
  claudeTierSettingKey,
} from "@features/agent/web/lib/agent-roles";
import { SETTINGS_SCHEMA } from "@/lib/settings-schema";

const TOOL_NAMES = [
  "Read",
  "Glob",
  "Grep",
  "Bash",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "Task",
  "Agent",
];
const VENDOR_WORDS = ["haiku", "sonnet", "opus", "claude", "anthropic", "gpt"];

const texts = (role: (typeof registry.roles)[number]): string[] => [
  role.purpose,
  role.prompt,
  ...Object.values(role.promptByCapability),
  role.delegation.lead,
  role.delegation.summary,
  ...role.delegation.tasks.map((t) => (typeof t === "string" ? t : t.text)),
];

describe("agent roles registry", () => {
  const capabilities = Object.keys(registry.capabilities);

  it("has the three tiers and the built-in roles", () => {
    expect(registry.version).toBe(1);
    expect(AGENT_TIERS).toEqual(["cheap", "standard", "strong"]);
    expect(AGENT_ROLES.map((r) => r.id)).toEqual(["explorer", "worker"]);
    expect(capabilities).toEqual([
      "read",
      "search",
      "writer-cli-read",
      "edit",
      "write",
      "bash-limited",
      "memory-directory",
    ]);
  });

  it("uses unique lowercase slugs, known tiers and known capabilities", () => {
    const ids = AGENT_ROLES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const role of AGENT_ROLES) {
      expect(role.id, role.id).toMatch(/^[a-z0-9-]+$/);
      expect(AGENT_TIERS, role.id).toContain(role.tier);
      for (const cap of role.capabilities)
        expect(capabilities, `${role.id}: ${cap}`).toContain(cap);
    }
  });

  it("grants no role the memory-directory capability (it is a session setting)", () => {
    for (const role of AGENT_ROLES)
      expect(role.capabilities, role.id).not.toContain("memory-directory");
  });

  it("keeps read-only roles away from every writing capability", () => {
    for (const role of AGENT_ROLES) {
      if (role.readOnly) {
        for (const cap of ["edit", "write", "bash-limited"])
          expect(role.capabilities, role.id).not.toContain(cap);
      } else {
        expect(
          (role.capabilities as string[]).some((c) => c === "edit" || c === "write"),
          role.id,
        ).toBe(true);
      }
    }
  });

  it("names no tool and no vendor model in any neutral text", () => {
    for (const role of AGENT_ROLES) {
      for (const text of texts(role)) {
        for (const word of text.split(/[^A-Za-z0-9-]+/).filter(Boolean)) {
          expect(TOOL_NAMES, `${role.id}: ${word} in "${text}"`).not.toContain(word);
          expect(VENDOR_WORDS, `${role.id}: ${word} in "${text}"`).not.toContain(
            word.toLowerCase(),
          );
        }
      }
    }
  });

  it("only gates text on capabilities the role holds, and tokens are such capabilities", () => {
    for (const role of AGENT_ROLES) {
      for (const cap of Object.keys(role.promptByCapability))
        expect(role.capabilities, role.id).toContain(cap);
      for (const t of role.delegation.tasks)
        if (typeof t !== "string") expect(role.capabilities, role.id).toContain(t.capability);
      for (const m of role.prompt.matchAll(/\{([^}]*)\}/g))
        expect(role.capabilities, `${role.id}: {${m[1]}}`).toContain(m[1]);
    }
  });

  it("has one Claude model setting per tier, under the agent feature's prefix", () => {
    for (const tier of AGENT_TIERS) {
      const def = SETTINGS_SCHEMA.find((d) => d.key === claudeTierSettingKey(tier));
      expect(def, tier).toBeDefined();
      expect(def!.type).toBe("string");
      expect(def!.scope).toBe("global");
    }
  });
});
