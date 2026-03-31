import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Set required env vars before importing
process.env.DATABASE_URL ??= "sqlite://test.db";
process.env.SECRETS_ENCRYPTION_KEY = "a".repeat(64); // 32 bytes hex

import { encrypt, decrypt, hashApiKey, generateApiKey } from "../../src/lib/crypto.js";

describe("crypto", () => {
  describe("encrypt/decrypt", () => {
    it("should round-trip a secret", () => {
      const secret = "sk-ant-abc123-very-secret-key";
      const encrypted = encrypt(secret);
      const decrypted = decrypt(encrypted);
      assert.equal(decrypted, secret);
    });

    it("should produce different ciphertexts for same input (random IV)", () => {
      const secret = "same-input";
      const a = encrypt(secret);
      const b = encrypt(secret);
      assert.notEqual(a, b);
      // But both decrypt to same value
      assert.equal(decrypt(a), secret);
      assert.equal(decrypt(b), secret);
    });

    it("should handle empty strings", () => {
      const encrypted = encrypt("");
      assert.equal(decrypt(encrypted), "");
    });

    it("should handle unicode", () => {
      const secret = "你好世界 🤖⚡ مرحبا";
      const encrypted = encrypt(secret);
      assert.equal(decrypt(encrypted), secret);
    });

    it("should reject invalid blob format", () => {
      assert.throws(() => decrypt("not-valid"), /Invalid encrypted blob/);
    });
  });

  describe("hashApiKey", () => {
    it("should produce consistent hashes", () => {
      const key = "bb_test123";
      assert.equal(hashApiKey(key), hashApiKey(key));
    });

    it("should produce different hashes for different keys", () => {
      assert.notEqual(hashApiKey("bb_key1"), hashApiKey("bb_key2"));
    });

    it("should produce a 64-char hex string (SHA-256)", () => {
      const hash = hashApiKey("bb_test");
      assert.equal(hash.length, 64);
      assert.match(hash, /^[0-9a-f]{64}$/);
    });
  });

  describe("generateApiKey", () => {
    it("should generate a key with bb_ prefix", () => {
      const { key, prefix, hash } = generateApiKey();
      assert.ok(key.startsWith("bb_"));
      assert.ok(prefix.startsWith("bb_"));
      assert.ok(prefix.endsWith("..."));
      assert.equal(hash.length, 64);
    });

    it("should generate unique keys", () => {
      const a = generateApiKey();
      const b = generateApiKey();
      assert.notEqual(a.key, b.key);
      assert.notEqual(a.hash, b.hash);
    });

    it("hash should match the generated key", () => {
      const { key, hash } = generateApiKey();
      assert.equal(hashApiKey(key), hash);
    });
  });
});
