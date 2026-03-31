/**
 * Test setup — set required env vars before any modules load.
 * Use with: node --import tsx --import ./test/setup.ts --test ...
 */
process.env.DATABASE_URL ??= "sqlite://test.db";
process.env.SECRETS_ENCRYPTION_KEY ??= "a".repeat(64);
