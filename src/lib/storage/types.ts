/**
 * Storage abstraction types.
 * Backend-agnostic representation of a stored object — works for both
 * Cloudflare R2 and Google Cloud Storage (Replit sidecar, local dev only).
 */

export interface StorageObject {
  /** Backend-opaque storage key (R2 key or GCS path). */
  key: string;
  /**
   * Returns the raw body stream — must be called at most once per object
   * since the underlying stream is not replayable.
   */
  getBody(): ReadableStream<Uint8Array> | null;
  contentType: string;
  size: number | undefined;
  /** Custom metadata stored alongside the object. */
  customMetadata: Record<string, string>;
}

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export interface StorageBackend {
  /**
   * Search public-asset prefixes for a file by its relative path.
   * Returns the first matching StorageObject, or null if not found.
   */
  searchPublicObject(filePath: string): Promise<StorageObject | null>;

  /**
   * Retrieve an uploaded entity object by its canonical /objects/... path.
   * Throws ObjectNotFoundError when the object does not exist.
   */
  getEntityObject(objectPath: string): Promise<StorageObject>;

  /**
   * Store an uploaded entity object.
   * uuid — bare UUID (no slashes); the backend chooses the final storage key.
   */
  storeEntityObject(
    uuid: string,
    contentType: string,
    body: ReadableStream<Uint8Array> | ArrayBuffer,
  ): Promise<string>; // returns canonical /objects/uploads/<uuid> path

  /**
   * Update the ACL policy metadata for an existing entity object.
   * objectPath — canonical /objects/... path as returned by normalizeEntityPath.
   */
  updateEntityAcl(objectPath: string, metadata: Record<string, string>): Promise<void>;

  /**
   * Generate an upload URL/path for a new entity upload.
   * R2 backend returns a Worker proxy path; GCS backend returns a signed GCS URL.
   */
  getEntityUploadURL(): Promise<string>;

  /**
   * Normalise a raw upload URL/path (from getEntityUploadURL) to the canonical
   * /objects/... entity path stored in the database.
   */
  normalizeEntityPath(rawPath: string): string;

  /** True when the backend supports the PUT /api/admin/upload-slot/:uuid proxy route. */
  readonly supportsProxyUpload: boolean;
}
