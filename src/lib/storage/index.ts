/**
 * StorageService — backend-agnostic object storage layer.
 *
 * Wraps either the R2 backend (CF Workers, wrangler dev) or the GCS backend
 * (Replit pnpm start, local dev with Replit sidecar).
 *
 * Call initStorage() once from the Worker fetch handler (or from index.ts for
 * Node.js) before the first request is served.
 *
 * All route files continue to import from "../lib/objectStorage.js" which
 * re-exports ObjectStorageService = StorageService from this module.
 */

import { randomUUID } from "crypto";
import { logger } from "../logger.js";
import { R2StorageBackend } from "./r2-backend.js";
// #gcs-backend resolves to gcs-backend-stub.ts under the "workerd" condition
// (wrangler dev / CF Workers) and to gcs-backend.ts on Node.js.
import { GCSStorageBackend } from "#gcs-backend";
import {
  ObjectNotFoundError,
  type StorageBackend,
  type StorageObject,
} from "./types.js";

export { ObjectNotFoundError };
export type { StorageObject };

// ── ACL types (kept here so objectAcl.ts can re-export them without GCS deps) ──

export enum ObjectAccessGroupType {}
export interface ObjectAccessGroup { type: ObjectAccessGroupType; id: string; }
export enum ObjectPermission { READ = "read", WRITE = "write" }
export interface ObjectAclRule { group: ObjectAccessGroup; permission: ObjectPermission; }
export interface ObjectAclPolicy {
  owner: string;
  visibility: "public" | "private";
  aclRules?: ObjectAclRule[];
}

function checkAclPolicy({
  userId,
  policy,
  requestedPermission,
}: {
  userId?: string;
  policy: ObjectAclPolicy;
  requestedPermission: ObjectPermission;
}): boolean {
  if (policy.visibility === "public" && requestedPermission === ObjectPermission.READ) return true;
  if (!userId) return false;
  if (policy.owner === userId) return true;
  // ObjectAccessGroupType is currently empty — no group rules to evaluate
  return false;
}

// ── Backend singleton ──────────────────────────────────────────────────────────

let _backend: StorageBackend | null = null;

// Cached once — prefix configuration does not change between requests.
let _r2Prefixes: string[] | null = null;

/**
 * Initialise or refresh the storage backend.
 *
 * CF Workers (worker.ts fetch): called on EVERY request with the current
 * request's env.R2 binding.  The env.R2 proxy is request-scoped in both
 * Miniflare and the production Workers runtime — caching it across requests
 * causes r2.get/put to silently fail.  We therefore rebuild the R2 backend
 * on each request (cheap: just wraps the binding) while parsing the prefix
 * config only once.
 *
 * Node.js / GCS path: no env.R2 is passed; backend is initialised once and
 * never replaced (existing behaviour unchanged).
 */
export function initStorage(env?: {
  R2?: unknown;
  PUBLIC_R2_PREFIXES?: string;
}): void {
  if (env?.R2) {
    // Parse prefix config exactly once; rebuild backend wrapper every request.
    if (!_r2Prefixes) {
      _r2Prefixes = (env.PUBLIC_R2_PREFIXES ?? "public/assets")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      logger.info("Storage backend: Cloudflare R2");
    }
    _backend = new R2StorageBackend(
      env.R2 as Parameters<typeof R2StorageBackend>[0],
      _r2Prefixes,
    );
  } else if (!_backend) {
    // GCS / Node.js: initialise once; never replace.
    _backend = new GCSStorageBackend();
    logger.info("Storage backend: Google Cloud Storage (Replit sidecar)");
  }
}

function getBackend(): StorageBackend {
  if (!_backend) {
    // Auto-init with GCS for Node.js environments where initStorage() was not called.
    _backend = new GCSStorageBackend();
  }
  return _backend;
}

// ── Public StorageService ──────────────────────────────────────────────────────

export class StorageService {
  /** Search public-asset prefixes for a file by relative path. */
  async searchPublicObject(filePath: string): Promise<StorageObject | null> {
    return getBackend().searchPublicObject(filePath);
  }

  /** Build an HTTP Response that streams the object body with correct headers. */
  async downloadObject(obj: StorageObject, cacheTtlSec = 3600): Promise<Response> {
    let isPublic = false;
    try {
      const aclStr = obj.customMetadata["aclPolicy"];
      if (aclStr) isPublic = (JSON.parse(aclStr) as ObjectAclPolicy).visibility === "public";
    } catch { /* treat as private on parse error */ }

    const headers: Record<string, string> = {
      "Content-Type": obj.contentType,
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
    };
    if (obj.size !== undefined) headers["Content-Length"] = String(obj.size);

    return new Response(obj.getBody(), { headers });
  }

  /**
   * Generate an upload destination.
   * R2 backend: returns a Worker proxy path  /api/admin/upload-slot/<uuid>
   * GCS backend: returns a signed GCS PUT URL
   */
  async getObjectEntityUploadURL(): Promise<string> {
    return getBackend().getEntityUploadURL();
  }

  /**
   * Resolve an uploaded entity object by its canonical /objects/... path.
   * Throws ObjectNotFoundError when not found.
   */
  async getObjectEntityFile(objectPath: string): Promise<StorageObject> {
    return getBackend().getEntityObject(objectPath);
  }

  /**
   * Convert a raw upload URL/path (returned by getObjectEntityUploadURL) to
   * the canonical /objects/... path stored in the database.
   */
  normalizeObjectEntityPath(rawPath: string): string {
    return getBackend().normalizeEntityPath(rawPath);
  }

  /**
   * Store an object uploaded via the Worker proxy route.
   * Only available with the R2 backend.
   */
  async storeEntityObject(
    uuid: string,
    contentType: string,
    body: ReadableStream<Uint8Array> | ArrayBuffer,
  ): Promise<string> {
    return getBackend().storeEntityObject(uuid, contentType, body);
  }

  /**
   * Update the ACL policy metadata for an existing entity object.
   * rawPath: raw upload URL or canonical /objects/... path.
   * Returns the normalised /objects/... path.
   */
  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy,
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/objects/")) return normalizedPath;
    await getBackend().updateEntityAcl(normalizedPath, {
      aclPolicy: JSON.stringify(aclPolicy),
    });
    return normalizedPath;
  }

  /** Check whether a user may access an entity object under the given ACL policy. */
  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: StorageObject;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    const aclStr = objectFile.customMetadata["aclPolicy"];
    if (!aclStr) return false;
    try {
      const policy = JSON.parse(aclStr) as ObjectAclPolicy;
      return checkAclPolicy({
        userId,
        policy,
        requestedPermission: requestedPermission ?? ObjectPermission.READ,
      });
    } catch {
      return false;
    }
  }

  /** True when the active backend accepts proxy uploads via PUT /api/admin/upload-slot/:uuid */
  get supportsProxyUpload(): boolean {
    return getBackend().supportsProxyUpload;
  }
}
