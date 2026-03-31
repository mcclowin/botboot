/**
 * Encryption utilities for stored secrets.
 * Uses AES-256-GCM with random IV per value.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

function getKey(): Buffer {
  // Read directly from process.env so tests can set it before import
  const key = process.env.SECRETS_ENCRYPTION_KEY;
  if (!key) {
    throw new Error("SECRETS_ENCRYPTION_KEY is required for secret storage");
  }
  return Buffer.from(key, "hex");
}

/**
 * Encrypt a plaintext secret.
 * Returns: iv:tag:ciphertext (all hex)
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypt a stored secret.
 */
export function decrypt(blob: string): string {
  const key = getKey();
  const parts = blob.split(":");
  if (parts.length !== 3 || !parts[0] || !parts[1]) {
    throw new Error("Invalid encrypted blob format");
  }
  const [ivHex, tagHex, encHex] = parts;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(encHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Hash an API key for storage (one-way).
 */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Generate a new API key with bb_ prefix.
 */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  const key = `bb_${raw}`;
  return {
    key,
    prefix: `bb_${raw.slice(0, 8)}...`,
    hash: hashApiKey(key),
  };
}
