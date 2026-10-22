/**
 * Connections whose gatekeeper refuses everyone but the person who connected it, or can shut to
 * everyone but them for good: a whole Drive or a Drive folder does after one read it can't check
 * against anyone else, such as an empty search. A workspace that needs one can't be shared. An entry
 * with no `typeUrlPattern` covers the whole vendor. Each entry is backed by a test of its gatekeeper's
 * own refusal.
 */
export const NEVER_SHAREABLE: readonly { vendorId: string; typeUrlPattern?: string; name: string }[] = [
  { vendorId: "google", typeUrlPattern: "https://mail.google.com/*", name: "Gmail" },
  { vendorId: "google", typeUrlPattern: "https://chat.google.com/", name: "a whole Google Chat account" },
  { vendorId: "google", typeUrlPattern: "https://drive.google.com/drive/my-drive", name: "a whole Google Drive" },
  {
    vendorId: "google", typeUrlPattern: "https://drive.google.com/drive/folders/:folderId",
    name: "a Google Drive folder",
  },
  { vendorId: "salesforce", name: "Salesforce" },
];

/**
 * The most people one workspace takes at the "Workspace" role. The Workshop refuses a share one past
 * it. Context admits this many observers only while its collaboration switch is on, and Cloudflare's
 * own limit otherwise.
 */
export const WORKSPACE_ROLE_CAP = 20;

/**
 * The `NEVER_SHAREABLE` entry a connection falls under, if any. Both values are compared exactly, the
 * pattern as stored when the connection was made: Cloudflare treats a resource type's `urlPattern` as
 * its lasting identity. A connection stored without a pattern matches only a whole-vendor entry.
 */
export function neverShareable(vendorId: string, typeUrlPattern: string | undefined) {
  return NEVER_SHAREABLE.find(entry => entry.vendorId === vendorId &&
      (entry.typeUrlPattern === undefined || entry.typeUrlPattern === typeUrlPattern));
}
