/**
 * Stub for GCS backend — used only in the CF Workers build.
 *
 * The GCS backend imports @google-cloud/storage and Node.js stream APIs that
 * are unavailable in Cloudflare Workers. This stub satisfies the import while
 * ensuring that any call throws clearly rather than silently failing.
 *
 * In CF Workers the R2 backend is always used (env.R2 binding is present).
 * This stub is never instantiated at runtime — it exists only to satisfy
 * static imports during the worker bundle build.
 */

import { ObjectNotFoundError, type StorageBackend, type StorageObject } from "./types.js";
import type { ObjectAclPolicy } from "./index.js";

export class GCSStorageBackend implements StorageBackend {
  readonly supportsProxyUpload = false;

  async searchPublicObject(_filePath: string): Promise<StorageObject | null> {
    throw new Error("GCS backend not available in Cloudflare Workers — use R2");
  }

  async getEntityObject(_objectPath: string): Promise<StorageObject> {
    throw new ObjectNotFoundError();
  }

  async storeEntityObject(
    _uuid: string,
    _contentType: string,
    _body: ReadableStream<Uint8Array> | ArrayBuffer,
  ): Promise<void> {
    throw new Error("GCS backend not available in Cloudflare Workers — use R2");
  }

  async updateEntityAcl(_objectPath: string, _metadata: Record<string, string>): Promise<void> {
    throw new Error("GCS backend not available in Cloudflare Workers — use R2");
  }

  async getEntityUploadURL(): Promise<string> {
    throw new Error("GCS backend not available in Cloudflare Workers — use R2");
  }

  normalizeEntityPath(rawPath: string): string {
    return rawPath;
  }
}
