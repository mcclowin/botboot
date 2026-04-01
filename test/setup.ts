/**
 * Test setup — load .env.test first, then provide safe fallbacks.
 * Use with: node --import tsx --import ./test/setup.ts --test ...
 */
import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const testEnvPath = resolve(process.cwd(), ".env.test");
if (existsSync(testEnvPath)) {
  config({ path: testEnvPath, override: false });
}

process.env.DATABASE_URL ??= "postgresql://botboot:botboot-local@localhost:5432/botboot";
process.env.SECRETS_ENCRYPTION_KEY ??= "a".repeat(64);
