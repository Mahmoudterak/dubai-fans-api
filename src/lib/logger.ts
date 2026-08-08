/**
 * Worker-compatible logger — thin console wrapper with the same call-site
 * interface as pino so no route files need to change.
 *
 * pino uses Node.js streams / worker_threads which are not available in
 * Cloudflare Workers even with nodejs_compat. This module is safe in both
 * CF Workers and plain Node.js (pnpm start).
 */

type LogArg = Record<string, unknown> | string;

function format(obj: LogArg, msg?: string): string {
  if (typeof obj === "string") return msg ? `${obj} — ${msg}` : obj;

  const { err, ...rest } = obj as Record<string, unknown>;
  const parts: string[] = [];
  if (msg) parts.push(msg);

  if (err) {
    const e = err as Error;
    parts.push(e?.message ?? String(e));
  }

  const keys = Object.keys(rest);
  if (keys.length > 0) {
    try {
      parts.push(JSON.stringify(rest));
    } catch {
      parts.push("[unstringifiable context]");
    }
  }

  return parts.join(" — ");
}

export const logger = {
  info(obj: LogArg, msg?: string): void  { console.info(format(obj, msg)); },
  warn(obj: LogArg, msg?: string): void  { console.warn(format(obj, msg)); },
  error(obj: LogArg, msg?: string): void { console.error(format(obj, msg)); },
  debug(obj: LogArg, msg?: string): void { console.debug(format(obj, msg)); },
};
