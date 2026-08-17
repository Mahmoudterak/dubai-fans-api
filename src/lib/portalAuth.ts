/**
 * Dubai Fans Portal — Auth helpers (HMAC-signed HttpOnly cookie sessions).
 * Reuses the same security pattern as instagram-auth.ts.
 */
import { createHmac, timingSafeEqual } from "crypto";
import type { Request, Response } from "express";
import { db } from "@workspace/db";
import { portalUsers, portalAdminUsers } from "../vendor/db/schema/portal.js";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";

export const PORTAL_SESSION_COOKIE       = "portal_session";
export const PORTAL_ADMIN_SESSION_COOKIE = "portal_admin_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET not set");
  return s;
}

export function issuePortalToken(userId: number, sessionVersion: number): string {
  const expires = (Date.now() + SESSION_TTL_MS).toString(16);
  const payload = `p.${userId}.${sessionVersion}.${expires}`;
  const sig     = createHmac("sha256", getSecret()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export function verifyPortalToken(token: string): { userId: number; sessionVersion: number } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 5) return null;
    const [prefix, userId, version, expires, sig] = parts;
    if (prefix !== "p") return null;
    const payload  = `p.${userId}.${version}.${expires}`;
    const expected = createHmac("sha256", getSecret()).update(payload).digest("hex");
    const sigBuf   = Buffer.from(sig,      "hex");
    const expBuf   = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
    if (Date.now() > parseInt(expires, 16)) return null;
    return { userId: parseInt(userId, 10), sessionVersion: parseInt(version, 10) };
  } catch { return null; }
}

export function issueAdminToken(adminId: number, sessionVersion: number): string {
  const expires = (Date.now() + SESSION_TTL_MS).toString(16);
  const payload = `a.${adminId}.${sessionVersion}.${expires}`;
  const sig     = createHmac("sha256", getSecret()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export function verifyAdminToken(token: string): { adminId: number; sessionVersion: number } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 5) return null;
    const [prefix, adminId, version, expires, sig] = parts;
    if (prefix !== "a") return null;
    const payload  = `a.${adminId}.${version}.${expires}`;
    const expected = createHmac("sha256", getSecret()).update(payload).digest("hex");
    const sigBuf   = Buffer.from(sig,      "hex");
    const expBuf   = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
    if (Date.now() > parseInt(expires, 16)) return null;
    return { adminId: parseInt(adminId, 10), sessionVersion: parseInt(version, 10) };
  } catch { return null; }
}

export function setPortalCookie(res: Response, token: string): void {
  res.cookie(PORTAL_SESSION_COOKIE, token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge:   SESSION_TTL_MS,
    path:     "/",
  });
}

export function setAdminCookie(res: Response, token: string): void {
  res.cookie(PORTAL_ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge:   SESSION_TTL_MS,
    path:     "/",
  });
}

/** Middleware: require authenticated portal customer */
export async function requirePortalUser(req: Request, res: Response, next: () => void): Promise<void> {
  const token = req.cookies?.[PORTAL_SESSION_COOKIE];
  if (!token) {
    res.status(401).json({ success: false, error: { code: "UNAUTHENTICATED", message: "يرجى تسجيل الدخول." } });
    return;
  }
  const parsed = verifyPortalToken(token);
  if (!parsed) {
    res.status(401).json({ success: false, error: { code: "INVALID_SESSION", message: "انتهت الجلسة. يرجى تسجيل الدخول مجدداً." } });
    return;
  }
  try {
    const [user] = await db.select().from(portalUsers).where(eq(portalUsers.id, parsed.userId)).limit(1);
    if (!user || user.sessionVersion !== parsed.sessionVersion) {
      res.status(401).json({ success: false, error: { code: "SESSION_INVALIDATED", message: "انتهت الجلسة. يرجى تسجيل الدخول مجدداً." } });
      return;
    }
    if (!user.isActive) {
      res.status(403).json({ success: false, error: { code: "SUSPENDED", message: "تم تعليق الحساب." } });
      return;
    }
    (req as any).portalUser = user;
    next();
  } catch (err) {
    logger.error({ err }, "requirePortalUser DB error");
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "فشل التحقق من الجلسة." } });
  }
}

/** Middleware: require authenticated portal admin */
export async function requirePortalAdmin(req: Request, res: Response, next: () => void): Promise<void> {
  const token = req.cookies?.[PORTAL_ADMIN_SESSION_COOKIE];
  if (!token) {
    res.status(401).json({ success: false, error: { code: "UNAUTHENTICATED", message: "Admin login required." } });
    return;
  }
  const parsed = verifyAdminToken(token);
  if (!parsed) {
    res.status(401).json({ success: false, error: { code: "INVALID_SESSION", message: "Session expired." } });
    return;
  }
  try {
    const [admin] = await db.select().from(portalAdminUsers).where(eq(portalAdminUsers.id, parsed.adminId)).limit(1);
    if (!admin || admin.sessionVersion !== parsed.sessionVersion) {
      res.status(401).json({ success: false, error: { code: "SESSION_INVALIDATED", message: "Session expired." } });
      return;
    }
    if (!admin.isActive) {
      res.status(403).json({ success: false, error: { code: "SUSPENDED", message: "Admin account inactive." } });
      return;
    }
    (req as any).portalAdmin = admin;
    next();
  } catch (err) {
    logger.error({ err }, "requirePortalAdmin DB error");
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Auth check failed." } });
  }
}
