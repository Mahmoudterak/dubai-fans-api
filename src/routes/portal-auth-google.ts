/**
 * Dubai Fans Portal — Google Sign-In
 * POST /api/portal/auth/google
 *
 * Security:
 * - ID token validated server-side with google-auth-library (never trusted from client)
 * - Validates: iss, aud (allowlist), sub, email, email_verified, exp (library handles crypto)
 * - email_verified checked explicitly
 * - Google access/refresh tokens are never stored
 * - Session token returned in JSON body so the mobile app (Expo + SecureStore) can persist it —
 *   identical pattern to POST /auth/login. Cookie is also set for browser clients.
 * - New users created inside a single DB transaction; any failure rolls back entirely
 * - Race condition on (provider, provider_subject) unique constraint is caught and recovered
 *
 * Required env vars:
 *   GOOGLE_WEB_CLIENT_ID      — OAuth 2.0 Web client ID (used by expo-auth-session; required)
 *   GOOGLE_ANDROID_CLIENT_ID  — Android client ID (optional; add to allowlist for native builds)
 */
import { Router, type Request, type Response } from "express";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod/v4";
import { eq, and } from "drizzle-orm";
import rateLimit from "express-rate-limit";
import { db } from "@workspace/db";
import { portalUsers, portalProfiles, portalWallets, userIdentities } from "../vendor/db/schema/portal.js";
import { issuePortalToken, setPortalCookie } from "../lib/portalAuth.js";
import { logger } from "../lib/logger.js";

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  skip: () => process.env.NODE_ENV === "test",
});

/**
 * Build the audience allowlist from env vars.
 * Tokens signed for any ID in this list are accepted.
 * Never disable audience validation — verifyIdToken always receives a non-empty list.
 */
function getAllowedClientIds(): string[] {
  const ids: string[] = [];
  if (process.env.GOOGLE_WEB_CLIENT_ID)     ids.push(process.env.GOOGLE_WEB_CLIENT_ID);
  if (process.env.GOOGLE_ANDROID_CLIENT_ID) ids.push(process.env.GOOGLE_ANDROID_CLIENT_ID);
  return ids;
}

const GoogleSchema = z.object({
  idToken: z.string().min(1),
});

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Bump sessionVersion, issue a token, set HttpOnly cookie, and respond.
 * The token is also returned in the JSON body so Expo / React Native apps
 * can persist it in SecureStore — matching the exact contract of POST /auth/login.
 * Security: token travels only over HTTPS; never logged, never in URLs.
 */
async function issueSessionAndRespond(
  res: Response,
  user: { id: number; fullName: string; email: string; sessionVersion: number },
  statusCode = 200,
): Promise<void> {
  const [updated] = await db
    .update(portalUsers)
    .set({ sessionVersion: user.sessionVersion + 1, updatedAt: new Date() })
    .where(eq(portalUsers.id, user.id))
    .returning();

  const token = issuePortalToken(user.id, updated.sessionVersion);
  setPortalCookie(res, token);   // browser clients use the HttpOnly cookie

  // Mobile clients (Expo + SecureStore) read the token from the JSON body,
  // identical to the existing login/register session flow.
  res.status(statusCode).json({
    success: true,
    data: {
      id:       user.id,
      fullName: user.fullName,
      email:    user.email,
      token,   // stored in Expo SecureStore; never logged or sent to analytics
    },
  });
}

// ── POST /api/portal/auth/google ──────────────────────────────────────────────
router.post("/portal/auth/google", authLimiter, async (req: Request, res: Response): Promise<void> => {
  const allowedIds = getAllowedClientIds();
  if (allowedIds.length === 0) {
    res.status(503).json({
      success: false,
      error: { code: "GOOGLE_NOT_CONFIGURED", message: "لم يتم تهيئة تسجيل الدخول عبر Google." },
    });
    return;
  }

  const parsed = GoogleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "idToken مطلوب." },
    });
    return;
  }

  // ── 1. Validate the Google ID token server-side ────────────────────────────
  // google-auth-library verifies: RSA signature, iss (accounts.google.com),
  // aud (our allowlist), exp, iat. We also explicitly check email_verified.
  let googleSub: string;
  let googleEmail: string;
  let googleName: string;

  try {
    // Create a fresh client per request; use the first allowed ID as the primary
    const client = new OAuth2Client(allowedIds[0]);
    const ticket = await client.verifyIdToken({
      idToken: parsed.data.idToken,
      audience: allowedIds,   // all allowed client IDs
    });
    const payload = ticket.getPayload();

    if (!payload) {
      res.status(401).json({ success: false, error: { code: "INVALID_TOKEN", message: "رمز Google غير صالح." } });
      return;
    }

    if (!payload.email_verified) {
      res.status(401).json({
        success: false,
        error: { code: "EMAIL_NOT_VERIFIED", message: "البريد الإلكتروني غير موثق من Google." },
      });
      return;
    }

    googleSub   = payload.sub;
    googleEmail = (payload.email ?? "").toLowerCase();
    googleName  = payload.name ?? payload.email ?? "Google User";
  } catch (err) {
    logger.warn({ err }, "Google ID token verification failed");
    res.status(401).json({ success: false, error: { code: "INVALID_TOKEN", message: "فشل التحقق من رمز Google." } });
    return;
  }

  if (!googleEmail) {
    res.status(401).json({ success: false, error: { code: "NO_EMAIL", message: "لم يتم توفير بريد إلكتروني من Google." } });
    return;
  }

  try {
    // ── 2a. Existing identity linked to this Google subject ─────────────────
    const [existingIdentity] = await db
      .select({ identity: userIdentities, user: portalUsers })
      .from(userIdentities)
      .innerJoin(portalUsers, eq(userIdentities.userId, portalUsers.id))
      .where(and(
        eq(userIdentities.provider, "google"),
        eq(userIdentities.providerSubject, googleSub),
      ))
      .limit(1);

    if (existingIdentity) {
      const user = existingIdentity.user;
      if (!user.isActive) {
        res.status(403).json({ success: false, error: { code: "SUSPENDED", message: "تم تعليق الحساب." } });
        return;
      }
      await issueSessionAndRespond(res, user);
      return;
    }

    // ── 2b. Existing portal account with the same verified email ───────────
    const [existingUser] = await db
      .select()
      .from(portalUsers)
      .where(eq(portalUsers.email, googleEmail))
      .limit(1);

    if (existingUser) {
      if (!existingUser.isActive) {
        res.status(403).json({ success: false, error: { code: "SUSPENDED", message: "تم تعليق الحساب." } });
        return;
      }

      // Link Google identity to existing account
      try {
        await db.insert(userIdentities).values({
          userId:          existingUser.id,
          provider:        "google",
          providerSubject: googleSub,
          email:           googleEmail,
        });
      } catch (insertErr: any) {
        // 23505 = unique_violation: concurrent request already linked this identity
        if (insertErr?.code !== "23505") throw insertErr;
        logger.info({ googleSub }, "Google identity link race: already inserted by concurrent request");
      }

      await issueSessionAndRespond(res, existingUser);
      return;
    }

    // ── 2c. New account — all-or-nothing inside a transaction ─────────────
    // passwordHash is NULL: Google-only accounts have no password.
    // The password login route rejects null passwordHash with a clear USE_GOOGLE_AUTH error.
    let newUser: typeof existingUser;
    try {
      newUser = await db.transaction(async (tx) => {
        const [user] = await tx.insert(portalUsers).values({
          fullName:     googleName,
          email:        googleEmail,
          passwordHash: null,    // Google-only account; null rejected by login route
          isActive:     true,
        }).returning();

        await tx.insert(portalProfiles).values({ userId: user.id });
        await tx.insert(portalWallets).values({ userId: user.id, balance: "0.00" });
        await tx.insert(userIdentities).values({
          userId:          user.id,
          provider:        "google",
          providerSubject: googleSub,
          email:           googleEmail,
        });

        return user;
      });
    } catch (txErr: any) {
      // 23505 on portal_users.email: concurrent request registered the same email
      if (txErr?.code === "23505") {
        logger.info({ googleEmail }, "Google new-user race: email already taken by concurrent request");
        const [raceUser] = await db.select().from(portalUsers)
          .where(eq(portalUsers.email, googleEmail)).limit(1);
        if (raceUser) {
          if (!raceUser.isActive) {
            res.status(403).json({ success: false, error: { code: "SUSPENDED", message: "تم تعليق الحساب." } });
            return;
          }
          await db.insert(userIdentities).values({
            userId: raceUser.id, provider: "google",
            providerSubject: googleSub, email: googleEmail,
          }).catch(() => {}); // ignore if already linked
          await issueSessionAndRespond(res, raceUser);
          return;
        }
      }
      throw txErr;
    }

    await issueSessionAndRespond(res, newUser, 201);
  } catch (err) {
    logger.error({ err }, "Google sign-in error");
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "فشل تسجيل الدخول عبر Google." } });
  }
});

export default router;
