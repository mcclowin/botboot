import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { listProviders } from "../../src/providers/index.js";

describe("providers", () => {
  describe("listProviders", () => {
    it("should include hetzner", () => {
      const providers = listProviders();
      assert.ok(providers.includes("hetzner"));
    });
  });
});
