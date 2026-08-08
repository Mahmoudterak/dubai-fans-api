/**
 * Backwards-compatibility shim.
 *
 * All route files import { ObjectStorageService, ObjectNotFoundError } from
 * "../lib/objectStorage.js" — this shim preserves those imports unchanged
 * while the real implementation lives in ./storage/index.ts.
 */
export { StorageService as ObjectStorageService, ObjectNotFoundError } from "./storage/index.js";
export type { StorageObject } from "./storage/index.js";
