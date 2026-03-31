import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getRuntime, listRuntimes } from "../../src/runtimes/index.js";

describe("runtimes", () => {
  describe("listRuntimes", () => {
    it("should include openclaw and hermes", () => {
      const runtimes = listRuntimes();
      assert.ok(runtimes.includes("openclaw"));
      assert.ok(runtimes.includes("hermes"));
    });
  });

  describe("getRuntime", () => {
    it("should return openclaw runtime", () => {
      const runtime = getRuntime("openclaw");
      assert.equal(runtime.name, "openclaw");
    });

    it("should return hermes runtime", () => {
      const runtime = getRuntime("hermes");
      assert.equal(runtime.name, "hermes");
    });

    it("should throw for unknown runtime", () => {
      assert.throws(() => getRuntime("unknown"), /Unknown runtime/);
    });
  });

  describe("OpenClaw runtime", () => {
    const runtime = getRuntime("openclaw");

    it("should have install commands with Node.js", () => {
      const cmds = runtime.installCommands();
      const joined = cmds.join("\n");
      assert.ok(joined.includes("nodejs"), "Should install Node.js");
      assert.ok(joined.includes("openclaw"), "Should install OpenClaw");
    });

    it("should create agent user", () => {
      const cmds = runtime.setupUserCommands();
      const joined = cmds.join("\n");
      assert.ok(joined.includes("agent"), "Should create agent user");
    });

    it("should write config with API key", () => {
      const cmds = runtime.writeConfigCommands(
        { name: "test-agent" },
        { ANTHROPIC_API_KEY: "sk-test-123" }
      );
      const joined = cmds.join("\n");
      assert.ok(joined.includes("openclaw.json"), "Should write openclaw.json");
      assert.ok(joined.includes("auth-profiles.json"), "Should write auth profiles");
    });

    it("should write workspace files", () => {
      const cmds = runtime.writeFileCommands({
        "SOUL.md": "You are a test agent",
        "USER.md": "# Owner\nName: Test",
      });
      const joined = cmds.join("\n");
      assert.ok(joined.includes("SOUL.md"));
      assert.ok(joined.includes("USER.md"));
      assert.ok(joined.includes(".openclaw/workspace"));
    });

    it("should generate valid systemd unit", () => {
      const unit = runtime.systemdUnit();
      assert.ok(unit.includes("[Unit]"));
      assert.ok(unit.includes("[Service]"));
      assert.ok(unit.includes("openclaw gateway run"));
      assert.ok(unit.includes("botboot-agent"));
    });

    it("should have correct paths", () => {
      assert.ok(runtime.workspacePath().includes(".openclaw/workspace"));
      assert.ok(runtime.configPath().includes(".openclaw"));
    });
  });

  describe("Hermes runtime", () => {
    const runtime = getRuntime("hermes");

    it("should have install commands with Python/uv", () => {
      const cmds = runtime.installCommands();
      const joined = cmds.join("\n");
      assert.ok(joined.includes("uv"), "Should install uv");
      assert.ok(joined.includes("hermes-agent"), "Should clone hermes-agent");
    });

    it("should write config.yaml and .env", () => {
      const cmds = runtime.writeConfigCommands(
        { name: "test-hermes", model: "anthropic/claude-sonnet-4" },
        { ANTHROPIC_API_KEY: "sk-test-456" }
      );
      const joined = cmds.join("\n");
      assert.ok(joined.includes("config.yaml"), "Should write config.yaml");
      assert.ok(joined.includes(".env"), "Should write .env");
    });

    it("should map SOUL.md to hermes path", () => {
      const cmds = runtime.writeFileCommands({
        "SOUL.md": "You are Hermes",
      });
      const joined = cmds.join("\n");
      assert.ok(joined.includes(".hermes/SOUL.md"), "SOUL.md should go to ~/.hermes/");
    });

    it("should generate valid systemd unit", () => {
      const unit = runtime.systemdUnit();
      assert.ok(unit.includes("hermes gateway"));
      assert.ok(unit.includes("botboot-agent"));
    });
  });
});
