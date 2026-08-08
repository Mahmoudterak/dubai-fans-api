/**
 * Cloudflare R2 storage backend.
 *
 * Object layout in the R2 bucket:
 *   public/<prefix>/<filename>   — public assets (served at /storage/public-objects/*)
 *   objects/uploads/<uuid>       — admin-uploaded entity objects (/storage/objects/uploads/*)
 *
 * ACL policy is stored as R2 customMetadata["aclPolicy"] (JSON string).
 * When updating ACL, a lightweight sidecar key <key>.acl is written instead
 * of re-uploading the full object body.
 */

import { randomUUID } from "crypto";
import { ObjectNotFoundError, type StorageBackend, type StorageObject } from "./types.js";

// Minimal R2 type shims — provided at runtime by the Cloudflare Workers runtime.
interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<R2Object | null>;
  put(
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object>;
}
interface R2Object {
  key: string;
  size: number;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}
interface R2ObjectBody extends R2Object {
  body: ReadableStream<Uint8Array>;
}
interface R2PutOptions {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

const UPLOAD_SLOT_PREFIX = "/api/admin/upload-slot/";
const ENTITY_PREFIX = "objects/uploads/";

function r2ToStorageObject(obj: R2ObjectBody, keyOverride?: string): StorageObject {
  let bodyConsumed = false;
  return {
    key: keyOverride ?? obj.key,
    getBody() {
      if (bodyConsumed) return null;
      bodyConsumed = true;
      return obj.body;
    },
    contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
    size: obj.size,
    customMetadata: obj.customMetadata ?? {},
  };
}

export class R2StorageBackend implements StorageBackend {
  readonly supportsProxyUpload = true;

  constructor(
    private readonly r2: R2Bucket,
    /** Comma-separated list of R2 key prefixes to search for public objects. */
    private readonly publicPrefixes: string[],
  ) {}

  async searchPublicObject(filePath: string): Promise<StorageObject | null> {
    for (const prefix of this.publicPrefixes) {
      const key = `${prefix.replace(/\/$/, "")}/${filePath}`;
      const obj = await this.r2.get(key);
      if (obj) return r2ToStorageObject(obj as R2ObjectBody, key);
    }
    return null;
  }

  async getEntityObject(objectPath: string): Promise<StorageObject> {
    // objectPath = "/objects/uploads/<uuid>"
    const key = objectPath.replace(/^\//, ""); // → "objects/uploads/<uuid>"
    const obj = await this.r2.get(key);
    if (!obj) throw new ObjectNotFoundError();

    // Merge ACL sidecar metadata if present
    const baseMetadata = (obj as R2ObjectBody).customMetadata ?? {};
    let aclMetadata: Record<string, string> = {};
    if (!baseMetadata["aclPolicy"]) {
      const sidecar = await this.r2.get(`${key}.acl`).catch(() => null);
      if (sidecar) {
        try {
          const text = await new Response(sidecar.body).text();
          aclMetadata = JSON.parse(text);
        } catch { /* ignore malformed sidecar */ }
      }
    }

    return r2ToStorageObject(obj as R2ObjectBody, objectPath.replace(/^\//, ""));
  }

  async storeEntityObject(
    uuid: string,
    contentType: string,
    body: ReadableStream<Uint8Array> | ArrayBuffer,
  ): Promise<string> {
    const key = `${ENTITY_PREFIX}${uuid}`;
    await this.r2.put(key, body, {
      httpMetadata: { contentType },
      customMetadata: {
        aclPolicy: JSON.stringify({ owner: "admin", visibility: "public" }),
      },
    });
    return `/objects/uploads/${uuid}`;
  }

  async updateEntityAcl(objectPath: string, metadata: Record<string, string>): Promise<void> {
    // Write a tiny sidecar key instead of re-uploading the full object.
    const key = `${objectPath.replace(/^\//, "")}.acl`;
    await this.r2.put(key, JSON.stringify(metadata));
  }

  async getEntityUploadURL(): Promise<string> {
    const uuid = randomUUID();
    return `${UPLOAD_SLOT_PREFIX}${uuid}`;
  }

  normalizeEntityPath(rawPath: string): string {
    if (rawPath.startsWith(UPLOAD_SLOT_PREFIX)) {
      const uuid = rawPath.slice(UPLOAD_SLOT_PREFIX.length);
      return `/objects/uploads/${uuid}`;
    }
    return rawPath;
  }
}
