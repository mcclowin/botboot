import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const schemaPath = resolve(process.cwd(), "sql/schema.sql");
const schemaSql = readFileSync(schemaPath, "utf8");
const sql = postgres(databaseUrl, {
  max: 1,
  idle_timeout: 5,
  connect_timeout: 10,
});

try {
  await sql.unsafe(schemaSql);
  console.log(`Migrated schema from ${schemaPath}`);
} finally {
  await sql.end({ timeout: 5 });
}
