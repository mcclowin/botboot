process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { env } from "./env.js";
import agentRoutes from "./routes/agents.js";
import secretRoutes from "./routes/secrets.js";
import fileRoutes from "./routes/files.js";
import authRoutes from "./routes/auth.js";
import usageRoutes from "./routes/usage.js";
import diagnosticsRoutes from "./routes/diagnostics.js";
import testUiRoutes from "./routes/test-ui.js";
import { startUsagePoller } from "./lib/usage-poller.js";

const app = new Hono();

// Middleware
app.use("*", logger());
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
}));

// Health
app.get("/health", (c) => c.json({
  status: "ok",
  service: "botboot",
  version: "0.1.0",
}));

// Internal test UI
app.route("/", testUiRoutes);

// Routes
app.route("/v1/agents", agentRoutes);
app.route("/v1/agents", fileRoutes);     // /v1/agents/:id/files/*
app.route("/v1/secrets", secretRoutes);
app.route("/v1/auth", authRoutes);
app.route("/v1/usage", usageRoutes);
app.route("/v1/agents", usageRoutes);   // /v1/agents/:id/usage
app.route("/v1/agents", diagnosticsRoutes); // /v1/agents/:id/health, /v1/agents/:id/logs

// 404
app.notFound((c) => c.json({ error: "Not found" }, 404));

// Error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

// Start
console.log(`🤖⚡ BotBoot starting on port ${env.PORT}`);
startUsagePoller({
  enabled: env.USAGE_POLL_ENABLED,
  intervalMinutes: env.USAGE_POLL_INTERVAL_MINUTES,
  startupDelayMs: env.USAGE_POLL_STARTUP_DELAY_MS,
});
serve({ fetch: app.fetch, port: env.PORT, hostname: "0.0.0.0" });
console.log(`✅ BotBoot running at http://localhost:${env.PORT}`);
