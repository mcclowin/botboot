import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { enrichAgentsWithLiveStatus } from "../../src/routes/agents.js";
import { classifyFileReadResult } from "../../src/routes/files.js";

describe("API route logic regressions", () => {
  it("uses each agent's actual provider when enriching live status", async () => {
    const providerCalls: string[] = [];
    const agents = [
      {
        id: "agent-1",
        provider: "hetzner",
        server_id: "srv-1",
      },
    ];

    const enriched = await enrichAgentsWithLiveStatus(agents, ((name?: string) => {
      providerCalls.push(name || "");
      return {
        getMachine: async () => ({ state: name === "hetzner" ? "running" : "unknown" }),
      };
    }) as any);

    assert.equal(providerCalls[0], "hetzner");
    assert.equal((enriched[0] as any).liveStatus, "running");
  });

  it("classifies non-file SSH failures as 502 instead of fake 404", () => {
    const failure = classifyFileReadResult("memory/activity-log.md", {
      stderr: "",
      exitCode: "ENOENT",
    });

    assert.equal(failure.status, 502);
    assert.equal(failure.body.error, "Failed to read file on agent");
    assert.equal((failure.body as any).exitCode, "ENOENT");
  });

  it("keeps actual missing files as 404", () => {
    const failure = classifyFileReadResult("memory/activity-log.md", {
      stderr: "cat: /home/agent/.openclaw/workspace/memory/activity-log.md: No such file or directory",
      exitCode: 1,
    });

    assert.equal(failure.status, 404);
    assert.equal(failure.body.error, "File not found: memory/activity-log.md");
  });
});
