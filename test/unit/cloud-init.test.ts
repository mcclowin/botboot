import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCloudInit } from "../../src/lib/cloud-init.js";
import { getRuntime } from "../../src/runtimes/index.js";

describe("cloud-init", () => {
  it("should generate a valid bash script for openclaw", () => {
    const runtime = getRuntime("openclaw");
    const script = buildCloudInit({
      runtime,
      config: { name: "test-agent" },
      secrets: { ANTHROPIC_API_KEY: "sk-test" },
      files: { "SOUL.md": "You are a helpful assistant" },
    });

    assert.ok(script.startsWith("#!/bin/bash"));
    assert.ok(script.includes("set -euo pipefail"));
    assert.ok(script.includes("botboot-provision.log"));
    assert.ok(script.includes("apt-get"));
    assert.ok(script.includes("openclaw"));
    assert.ok(script.includes("botboot-agent.service"));
    assert.ok(script.includes("systemctl"));
    assert.ok(script.includes("Provisioning complete"));
  });

  it("should generate a valid bash script for hermes", () => {
    const runtime = getRuntime("hermes");
    const script = buildCloudInit({
      runtime,
      config: { name: "test-hermes" },
      secrets: { ANTHROPIC_API_KEY: "sk-test" },
      files: { "SOUL.md": "You are Hermes" },
    });

    assert.ok(script.startsWith("#!/bin/bash"));
    assert.ok(script.includes("hermes"));
    assert.ok(script.includes("uv") || script.includes("python"));
    assert.ok(script.includes("botboot-agent.service"));
  });

  it("should include SSH key forwarding", () => {
    const runtime = getRuntime("openclaw");
    const script = buildCloudInit({
      runtime,
      config: { name: "test" },
      secrets: {},
      files: {},
    });

    assert.ok(script.includes("authorized_keys"));
  });

  it("should handle multiple files", () => {
    const runtime = getRuntime("openclaw");
    const script = buildCloudInit({
      runtime,
      config: { name: "test" },
      secrets: { ANTHROPIC_API_KEY: "sk-test" },
      files: {
        "SOUL.md": "Identity file",
        "AGENTS.md": "Behavior rules",
        "USER.md": "Owner info",
        "WORKFLOWS.md": "Custom workflows",
        "memory/brand.md": "Brand notes",
      },
    });

    assert.ok(script.includes("SOUL.md"));
    assert.ok(script.includes("AGENTS.md"));
    assert.ok(script.includes("WORKFLOWS.md"));
    assert.ok(script.includes("brand.md"));
  });
});
