/**
 * bootstrapPortalAdmin
 *
 * Idempotent first-boot provisioning for the portal admin table.
 * Runs after migrations, before the server accepts traffic.
 *
 * Creates one super-admin row using ADMIN_EMAIL + ADMIN_PASSWORD when:
 *   1. Both env vars are present, and
 *   2. portal_admin_users has zero rows.
 *
 * This guarantees that a freshly migrated database always has a usable
 * admin account without any out-of-band seed script.
 */
import bcrypt from "bcryptjs";
import { db } from "../vendor/db/index.js";
import { portalAdminUsers } from "../vendor/db/schema/portal.js";
import { logger } from "./logger.js";

export async function bootstrapPortalAdmin(): Promise<void> {
  const adminEmail    = process.env["ADMIN_EMAIL"];
  const adminPassword = process.env["ADMIN_PASSWORD"];

  if (!adminEmail || !adminPassword) {
    logger.warn(
      "bootstrapPortalAdmin: ADMIN_EMAIL or ADMIN_PASSWORD not set — skipping super-admin provisioning",
    );
    return;
  }

  try {
    // Count existing admins — only seed when the table is truly empty.
    const existing = await db.select({ id: portalAdminUsers.id }).from(portalAdminUsers).limit(1);
    if (existing.length > 0) {
      logger.debug("bootstrapPortalAdmin: portal_admin_users is non-empty — skipping");
      return;
    }

    const passwordHash = await bcrypt.hash(adminPassword, 10);
    await db.insert(portalAdminUsers).values({
      fullName:     "Super Admin",
      email:        adminEmail.toLowerCase(),
      passwordHash,
      role:         "super_admin",
      isActive:     true,
    });

    logger.info(
      { email: adminEmail.toLowerCase() },
      "bootstrapPortalAdmin: initial super-admin created",
    );
  } catch (err) {
    // Log but don't crash — a pre-existing admin row is the expected state
    // after the first boot; other errors are worth surfacing.
    logger.error({ err }, "bootstrapPortalAdmin: failed to provision super-admin");
  }
}
