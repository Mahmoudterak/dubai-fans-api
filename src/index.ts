import { runMigrations } from "@workspace/db/migrate";
import app from "./app";
import { logger } from "./lib/logger";
import { initSitemap } from "./lib/sitemap";
import { scheduleResetTokenCleanup } from "./routes/company-auth";
import { scheduleAibosCleanup } from "./lib/aibos-cleanup";
import { bootstrapPortalAdmin } from "./lib/bootstrapPortalAdmin.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Apply any pending database migrations before accepting traffic.
try {
  await runMigrations();
} catch (err) {
  logger.error({ err }, "Database migration failed — refusing to start");
  process.exit(1);
}

// Seed the initial portal super-admin if portal_admin_users is empty.
// Idempotent: no-op when at least one admin row already exists.
await bootstrapPortalAdmin();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Populate sitemap cache from the database (non-blocking)
  initSitemap().catch((e) => logger.error({ err: e }, "initSitemap failed"));

  // Purge stale password-reset tokens now and every 24h thereafter
  scheduleResetTokenCleanup();

  // Purge anonymous AI Business OS data older than 30 days, every 7 days
  scheduleAibosCleanup();
});
