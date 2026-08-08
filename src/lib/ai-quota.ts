/**
 * Atomic daily quota reservation for AI Business OS tools.
 *
 * Uses a single conditional upsert on `ai_usage_quotas` so concurrent
 * requests can never exceed the configured cap: the increment happens
 * atomically in the database BEFORE the OpenAI call, and a row is only
 * returned when the counter was still below the limit.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export type QuotaKind = "audit" | "plan" | "chat" | "business_audit";

/** Server-local day bucket, e.g. "2026-08-02". */
export function todayBucket(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Atomically reserve one unit of today's quota.
 * Returns true if reserved (caller may proceed), false if the cap is reached.
 */
export async function reserveDailyQuota(
  principal: string,
  kind: QuotaKind,
  limit: number,
): Promise<boolean> {
  const day = todayBucket();
  const result = await db.execute(sql`
    INSERT INTO ai_usage_quotas (principal, kind, day, used)
    VALUES (${principal}, ${kind}, ${day}, 1)
    ON CONFLICT (principal, kind, day)
    DO UPDATE SET used = ai_usage_quotas.used + 1
    WHERE ai_usage_quotas.used < ${limit}
    RETURNING used
  `);
  return (result.rows?.length ?? 0) > 0;
}

/**
 * Release a previously reserved unit (e.g. when the OpenAI call fails),
 * so failed attempts don't consume the user's daily allowance.
 */
export async function releaseDailyQuota(
  principal: string,
  kind: QuotaKind,
  day: string = todayBucket(),
): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE ai_usage_quotas
      SET used = GREATEST(used - 1, 0)
      WHERE principal = ${principal} AND kind = ${kind} AND day = ${day}
    `);
  } catch (err) {
    console.error("[ai-quota] release failed:", err);
  }
}
