/**
 * Portal admin authentication — login / logout / me
 *
 * POST /portal/admin/auth/login   — bcrypt password check, issues HMAC session cookie
 *                                   Protected by a rate limiter (10 failed attempts
 *                                   per IP per 15 min) to block online brute-force.
 * POST /portal/admin/auth/logout  — clears the session cookie
 * GET  /portal/admin/auth/me      — returns the active admin identity
 */
import bcrypt from "bcryptjs";
import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { portalAdminUsers } from "../vendor/db/schema/portal.js";
import {
  requirePortalAdmin,
  issueAdminToken,
  setAdminCookie,
  PORTAL_ADMIN_SESSION_COOKIE,
} from "../lib/portalAuth.js";
import { logger } from "../lib/logger.js";

const router = Router();

/**
 * Rate-limit failed login attempts: 10 per IP in a 15-minute window.
 * Successful requests are not counted (skipSuccessfulRequests: true).
 * Skipped in test environments so unit tests can call the endpoint freely.
 */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  skip: () => process.env.NODE_ENV === "test",
  message: { success: false, error: { code: "TOO_MANY_REQUESTS" } },
});

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

// POST /portal/admin/auth/login
router.post(
  "/portal/admin/auth/login",
  loginLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR" } });
      return;
    }
    const { email, password } = parsed.data;
    try {
      const [adm] = await db.select().from(portalAdminUsers)
        .where(eq(portalAdminUsers.email, email.toLowerCase())).limit(1);
      if (!adm || !adm.isActive) {
        res.status(401).json({ success: false, error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password." } });
        return;
      }
      const valid = await bcrypt.compare(password, adm.passwordHash);
      if (!valid) {
        res.status(401).json({ success: false, error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password." } });
        return;
      }
      const [updated] = await db.update(portalAdminUsers)
        .set({ sessionVersion: adm.sessionVersion + 1, updatedAt: new Date() })
        .where(eq(portalAdminUsers.id, adm.id)).returning();
      const token = issueAdminToken(adm.id, updated.sessionVersion);
      setAdminCookie(res, token);
      res.json({ success: true, data: { id: adm.id, fullName: adm.fullName, email: adm.email, role: adm.role } });
    } catch (err) {
      logger.error({ err }, "portal admin login error");
      res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } });
    }
  }
);

// POST /portal/admin/auth/logout
router.post("/portal/admin/auth/logout", (_req: Request, res: Response): void => {
  res.clearCookie(PORTAL_ADMIN_SESSION_COOKIE, { path: "/" });
  res.json({ success: true });
});

// GET /portal/admin/auth/me
router.get("/portal/admin/auth/me", requirePortalAdmin, (req: Request, res: Response): void => {
  const adm = (req as any).portalAdmin;
  res.json({ success: true, data: { id: adm.id, fullName: adm.fullName, email: adm.email, role: adm.role } });
});

export default router;
