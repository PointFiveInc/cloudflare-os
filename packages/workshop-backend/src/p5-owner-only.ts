import type { SharingManager } from "./sharing";
import type { OverseerStorage } from "./storage-schema/overseer-storage";

/** True when os.pointfive.co's collaboration switch is on. The Workshop's one reader of it. */
export function collaborationOn(env: Cloudflare.Env): boolean {
  return env.P5_COLLABORATION === "true";
}

/** The slice of the Overseer that owner-only sharing reads and writes. */
export interface OwnerOnlyHost {
  env: Cloudflare.Env;
  ownerProfileId?: string;
  storage: Pick<OverseerStorage, "ownerInvitesOnly">;
}

/**
 * Only the owner shares, by name, and no share link works: Cloudflare's `ownerInvitesOnly` flag,
 * set without taking access from anyone. The flag counts only the owner's direct grants, so each
 * person with access first gets one from the owner at the role they have now; an existing grant
 * is only ever raised. Synchronous and throw-free: it runs on the owner's own open, and nothing
 * awaits between the flag read and its write, so no grant, link or redemption lands in between.
 */
export function p5OwnerOnly(host: OwnerOnlyHost, sharing: SharingManager): void {
  let { env, ownerProfileId, storage } = host;
  if (!collaborationOn(env) || ownerProfileId === undefined || storage.ownerInvitesOnly.get()) return;
  let owner = { profileId: ownerProfileId, isOwner: true };
  for (let { profile, role = "build" } of sharing.listCollaborators()) {
    sharing.addCollaborator({ caller: owner, profile, role });
  }
  storage.ownerInvitesOnly.put(true);
}
