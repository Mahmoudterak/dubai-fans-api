/**
 * Dubai Fans Portal — Admin CSV export endpoints
 *
 * GET /portal/admin/customers/export
 *   Streams all customer rows as CSV and writes a portalAuditLogs entry that
 *   captures the acting admin's identity and the exact column set requested.
 *
 * GET /portal/admin/orders/export
 *   Same for orders.
 *
 * Both endpoints accept an optional ?columns= query parameter (comma-separated
 * list of column names).  Unknown names are silently dropped; if every name is
 * unknown the full default set is used.
 */
import { Router, type Request, type Response } from "express";
import { asc } from "drizzle-orm";
import { db } from "@workspace/db";
import { portalUsers, portalOrders } from "../vendor/db/schema/portal.js";
import { requirePortalAdmin } from "../lib/portalAuth.js";
import { auditLog } from "../lib/portalAudit.js";
import { logger } from "../lib/logger.js";

const router = Router();

function admin(req: Request) { return (req as any).portalAdmin; }

// ── Column allow-lists ────────────────────────────────────────────────────────

export const CUSTOMER_COLUMNS = [
  "id", "fullName", "email", "mobile", "country", "isActive", "createdAt",
] as const;
export type CustomerCol = typeof CUSTOMER_COLUMNS[number];

export const ORDER_COLUMNS = [
  "id", "userId", "serviceId", "packageId", "status",
  "subtotal", "vatAmount", "total", "currency", "createdAt",
] as const;
export type OrderCol = typeof ORDER_COLUMNS[number];

// ── Helpers ───────────────────────────────────────────────────────────────────

export function parseCols<T extends string>(raw: string | undefined, allowed: readonly T[]): T[] {
  if (!raw) return [...allowed];
  const requested = raw.split(",").map(c => c.trim()).filter(c => allowed.includes(c as T)) as T[];
  return requested.length > 0 ? requested : [...allowed];
}

/**
 * Prefix values that begin with formula-trigger characters so spreadsheet
 * applications (Excel, LibreOffice, Google Sheets) cannot execute them as
 * formulas when an admin opens the exported file.
 * Affected prefixes: = + - @ \t \r
 */
function sanitizeCsvCell(raw: string): string {
  return /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
}

export function toCsv<T extends Record<string, unknown>>(rows: T[], cols: string[]): string {
  const header = cols.join(",");
  const body = rows
    .map(r =>
      cols
        .map(c => {
          const v = r[c];
          if (v == null) return "";
          return `"${sanitizeCsvCell(String(v)).replace(/"/g, '""')}"`;
        })
        .join(",")
    )
    .join("\n");
  return `${header}\n${body}`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/portal/admin/customers/export
router.get(
  "/portal/admin/customers/export",
  requirePortalAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const adm  = admin(req);
    const cols = parseCols(req.query.columns as string | undefined, CUSTOMER_COLUMNS);
    try {
      const rows = await db
        .select({
          id:        portalUsers.id,
          fullName:  portalUsers.fullName,
          email:     portalUsers.email,
          mobile:    portalUsers.mobile,
          country:   portalUsers.country,
          isActive:  portalUsers.isActive,
          createdAt: portalUsers.createdAt,
        })
        .from(portalUsers)
        .orderBy(asc(portalUsers.id));

      await auditLog({
        adminId:     adm.id,
        adminEmail:  adm.email,
        action:      "customers.export",
        entity:      "customer",
        description: `Exported ${rows.length} customers`,
        metadata:    { columns: cols, rowCount: rows.length },
      });

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="customers.csv"');
      res.send(toCsv(rows as Record<string, unknown>[], cols));
    } catch (err) {
      logger.error({ err }, "customers export error");
      res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } });
    }
  }
);

// GET /api/portal/admin/orders/export
router.get(
  "/portal/admin/orders/export",
  requirePortalAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const adm  = admin(req);
    const cols = parseCols(req.query.columns as string | undefined, ORDER_COLUMNS);
    try {
      const rows = await db
        .select({
          id:        portalOrders.id,
          userId:    portalOrders.userId,
          serviceId: portalOrders.serviceId,
          packageId: portalOrders.packageId,
          status:    portalOrders.status,
          subtotal:  portalOrders.subtotal,
          vatAmount: portalOrders.vatAmount,
          total:     portalOrders.total,
          currency:  portalOrders.currency,
          createdAt: portalOrders.createdAt,
        })
        .from(portalOrders)
        .orderBy(asc(portalOrders.id));

      await auditLog({
        adminId:     adm.id,
        adminEmail:  adm.email,
        action:      "orders.export",
        entity:      "order",
        description: `Exported ${rows.length} orders`,
        metadata:    { columns: cols, rowCount: rows.length },
      });

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="orders.csv"');
      res.send(toCsv(rows as Record<string, unknown>[], cols));
    } catch (err) {
      logger.error({ err }, "orders export error");
      res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } });
    }
  }
);

export default router;
