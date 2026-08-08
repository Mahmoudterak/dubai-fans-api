/**
 * Google Cloud Storage backend (Replit sidecar — local dev only).
 *
 * This backend is active when `pnpm start` runs in the Replit environment
 * where the sidecar at 127.0.0.1:1106 is available.
 *
 * In Cloudflare Workers the R2 backend is used instead. This file is still
 * bundled into dist/index.mjs (Node.js build) but never into dist/worker.mjs
 * (CF Workers build), so the Replit sidecar reference never reaches CF Workers.
 */

import { randomUUID } from "crypto";
import { Readable } from "stream";
import { File, Storage } from "@google-cloud/storage";
import { ObjectNotFoundError, type StorageBackend, type StorageObject } from "./types.js";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

const _gcsClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  } as Record<string, unknown>,
  projectId: "",
});

function parseObjectPath(path: string): { bucketName: string; objectName: string } {
  if (!path.startsWith("/")) path = `/${path}`;
  const parts = path.split("/");
  return { bucketName: parts[1], objectName: parts.slice(2).join("/") };
}

async function signObjectURL(opts: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  ttlSec: number;
}): Promise<string> {
  const res = await fetch(`${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: opts.bucketName,
      object_name: opts.objectName,
      method: opts.method,
      expires_at: new Date(Date.now() + opts.ttlSec * 1000).toISOString(),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Failed to sign URL: ${res.status}`);
  const { signed_url } = (await res.json()) as { signed_url: string };
  return signed_url;
}

function gcsFileToStorageObject(file: File, key: string): StorageObject {
  return {
    key,
    getBody() {
      const nodeStream = file.createReadStream();
      return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    },
    contentType: "application/octet-stream", // overridden in downloadObject via metadata
    size: undefined,
    customMetadata: {},
  };
}

export class GCSStorageBackend implements StorageBackend {
  readonly supportsProxyUpload = false;

  private getPublicSearchPaths(): string[] {
    const raw = process.env.PUBLIC_OBJECT_SEARCH_PATHS ?? "";
    return raw
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
  }

  private getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR ?? "";
    if (!dir) throw new Error("PRIVATE_OBJECT_DIR not set");
    return dir;
  }

  async searchPublicObject(filePath: string): Promise<StorageObject | null> {
    for (const searchPath of this.getPublicSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;
      const { bucketName, objectName } = parseObjectPath(fullPath);
      const file = _gcsClient.bucket(bucketName).file(objectName);
      const [exists] = await file.exists();
      if (exists) return gcsFileToStorageObject(file, fullPath);
    }
    return null;
  }

  async getEntityObject(objectPath: string): Promise<StorageObject> {
    if (!objectPath.startsWith("/objects/")) throw new ObjectNotFoundError();
    const parts = objectPath.slice(1).split("/"); // ["objects", "uploads", uuid]
    if (parts.length < 2) throw new ObjectNotFoundError();
    const entityId = parts.slice(1).join("/"); // "uploads/<uuid>"

    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
    const gcsPath = `${entityDir}${entityId}`; // "/<bucket>/<privateDir>/uploads/<uuid>"

    const { bucketName, objectName } = parseObjectPath(gcsPath);
    const file = _gcsClient.bucket(bucketName).file(objectName);
    const [exists] = await file.exists();
    if (!exists) throw new ObjectNotFoundError();

    // Read GCS metadata to populate StorageObject fields
    let contentType = "application/octet-stream";
    let size: number | undefined;
    let customMetadata: Record<string, string> = {};
    try {
      const [meta] = await file.getMetadata();
      contentType = (meta.contentType as string) ?? contentType;
      size = meta.size ? Number(meta.size) : undefined;
      const raw = meta?.metadata?.["custom:aclPolicy"];
      if (raw) customMetadata = { aclPolicy: raw as string };
    } catch { /* metadata not critical */ }

    return {
      key: gcsPath,
      getBody() {
        const nodeStream = file.createReadStream();
        return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
      },
      contentType,
      size,
      customMetadata,
    };
  }

  async storeEntityObject(): Promise<void> {
    throw new Error("GCS backend does not support proxy upload (supportsProxyUpload=false)");
  }

  async updateEntityAcl(objectPath: string, metadata: Record<string, string>): Promise<void> {
    if (!objectPath.startsWith("/objects/")) return;
    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) return;
    const entityId = parts.slice(1).join("/");
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
    const gcsPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(gcsPath);
    const file = _gcsClient.bucket(bucketName).file(objectName);
    await file.setMetadata({ metadata: { "custom:aclPolicy": metadata["aclPolicy"] } });
  }

  async getEntityUploadURL(): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    const uuid = randomUUID();
    const fullPath = `${privateObjectDir}/uploads/${uuid}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    return signObjectURL({ bucketName, objectName, method: "PUT", ttlSec: 900 });
  }

  normalizeEntityPath(rawPath: string): string {
    if (!rawPath.startsWith("https://storage.googleapis.com/")) return rawPath;
    const url = new URL(rawPath);
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
    const rawObjectPath = url.pathname; // "/<bucket>/<privateDir>/uploads/<uuid>"
    if (!rawObjectPath.startsWith(entityDir)) return rawObjectPath;
    const entityId = rawObjectPath.slice(entityDir.length); // "uploads/<uuid>"
    return `/objects/${entityId}`;
  }
}
