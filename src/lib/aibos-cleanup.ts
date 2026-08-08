/**
 * Scheduled cleanup for AI Business OS anonymous-session data.
 *
 * Anonymous rows (student_id IS NULL) accumulate indefinitely when sessions
 * are abandoned without a student ever logging in.  This job purges rows
 * older than AIBOS_ANON_MAX_AGE_MS on a configurable interval.
 *
 * messages rows are removed automatically via the ON DELETE CASCADE FK on
 * conversations.id — no explicit DELETE is needed there.
 *
 * The timer is unref'd so it never prevents a graceful process exit.
 */
import { db, aiAudits, aiPlans, conversations } from "@workspace/db";
import { and, isNull, lt }                      from "drizzle-orm";
import { logger }                               from "./logger.js";

/** Anonymous session rows older than this are eligible for deletion. */
export const AIBOS_ANON_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** How often the cleanup runs.  Default: every 7 days. */
export const AIBOS_CLEANUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete anonymous AI Business OS data older than AIBOS_ANON_MAX_AGE_MS.
 * Safe to call concurrently — each table is a single DELETE statement.
 */
export async function cleanupAibosAnonData(): Promise<void> {
  const cutoff = new Date(Date.now() - AIBOS_ANON_MAX_AGE_MS);
  try {
    const [audits, plans, convs] = await Promise.all([
      db.delete(aiAudits)
        .where(and(isNull(aiAudits.studentId), lt(aiAudits.createdAt, cutoff)))
        .returning({ id: aiAudits.id }),

      db.delete(aiPlans)
        .where(and(isNull(aiPlans.studentId), lt(aiPlans.createdAt, cutoff)))
        .returning({ id: aiPlans.id }),

      // messages cascade-delete automatically (ON DELETE CASCADE on conversation_id)
      db.delete(conversations)
        .where(and(isNull(conversations.studentId), lt(conversations.createdAt, cutoff)))
        .returning({ id: conversations.id }),
    ]);

    const total = audits.length + plans.length + convs.length;
    if (total > 0) {
      logger.info(
        { audits: audits.length, plans: plans.length, conversations: convs.length, cutoff },
        "Cleaned up anonymous AIBOS data",
      );
    }
  } catch (err) {
    logger.error({ err }, "AIBOS anonymous data cleanup failed");
  }
}

/**
 * Run cleanupAibosAnonData immediately and then every AIBOS_CLEANUP_INTERVAL_MS.
 * Returns the interval handle so callers can clear it if needed.
 */
export function scheduleAibosCleanup(): NodeJS.Timeout {
  void cleanupAibosAnonData();
  const timer = setInterval(() => {
    void cleanupAibosAnonData();
  }, AIBOS_CLEANUP_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
