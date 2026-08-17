/**
 * Role-based access control middleware for portal admin routes.
 * No database dependency — role is already on req.portalAdmin after
 * requirePortalAdmin has run.
 */
import type { Request, Response } from "express";

/**
 * Middleware factory: require that the authenticated portal admin has one of
 * the specified roles.  Must be placed AFTER requirePortalAdmin.
 *
 * Usage:
 *   router.put("/...", requirePortalAdmin, requireRole("super_admin", "manager"), handler)
 */
export function requireRole(...allowedRoles: string[]) {
  return function roleCheck(req: Request, res: Response, next: () => void): void {
    const adm = (req as any).portalAdmin;
    if (!adm) {
      res.status(401).json({ success: false, error: { code: "UNAUTHENTICATED" } });
      return;
    }
    if (!allowedRoles.includes(adm.role)) {
      res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Insufficient role." } });
      return;
    }
    next();
  };
}
