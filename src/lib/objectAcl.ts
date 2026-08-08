/**
 * Re-exports ACL types from the storage module so existing imports of
 * "../lib/objectAcl" continue to work without modification.
 *
 * The GCS-specific File parameter is gone — ACL logic now operates on
 * StorageObject.customMetadata["aclPolicy"] via StorageService.
 */
export {
  ObjectAccessGroupType,
  ObjectPermission,
  type ObjectAccessGroup,
  type ObjectAclRule,
  type ObjectAclPolicy,
} from "./storage/index.js";
