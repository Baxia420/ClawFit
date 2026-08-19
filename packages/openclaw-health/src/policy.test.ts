import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("OpenClaw health-tool policy", () => {
  it("keeps the setup allowlist aligned with the plugin manifest", async () => {
    const policy = JSON.parse(await readFile(new URL("../../../openclaw/policy.json", import.meta.url), "utf8")) as { healthTools: string[] };
    const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as { contracts: { tools: string[] } };

    expect(new Set(policy.healthTools).size).toBe(policy.healthTools.length);
    expect([...policy.healthTools].sort()).toEqual([...manifest.contracts.tools].sort());
    expect(policy.healthTools).toContain("create_pending_meal");
  });
});
