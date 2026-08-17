/**
 * Portal audit log helper — records admin actions for sensitive operations.
 *
 * This function intentionally does NOT catch errors. Callers that require a
 * guaranteed audit trail (e.g. CSV exports of customer/order PII) must let the
 * error propagate so the operation fails closed — no data is returned to the
 * client unless an audit record was successfully persisted.
 */
import { db } from "@workspace/db";
import { portalAuditLogs } from "../vendor/db/schema/portal.js";

export async function auditLog(params: {
  adminId?: number;
  adminEmail?: string;
  action: string;
  entity: string;
  entityId?: number;
  description: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(portalAuditLogs).values({
    adminId:     params.adminId,
    adminEmail:  params.adminEmail,
    action:      params.action,
    entity:      params.entity,
    entityId:    params.entityId,
    description: params.description,
    metadata:    params.metadata,
  });
}
