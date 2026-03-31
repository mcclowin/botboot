import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Set required env vars before importing (providers/index imports env.ts)
process.env.DATABASE_URL ??= "sqlite://test.db";

import { listProviders } from "../../src/providers/index.js";

describe("providers", () => {
  describe("listProviders", () => {
    it("should include hetzner", () => {
      const providers = listProviders();
      assert.ok(providers.includes("hetzner"));
    });
  });
});
