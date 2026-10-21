import type { AiChatAuthorInfo, CollaboratorRole, ObserverBindingNeed } from "@gadgets/workshop-shared/api";
import { neverShareable, WORKSPACE_ROLE_CAP } from "@gadgets/workshop-shared/p5-share-safety";
import type { SharingManager } from "./sharing";
import type { OverseerStorage } from "./storage-schema/overseer-storage";

/** Each refusal in one sentence: the share and the cap to the owner, the connect to whoever connects. */
export const SHARE_SAFETY_REFUSALS = {
  share: (name: string) => `This workspace uses ${name}, which works only for the person who connected it, so ` +
      "they couldn't open it; share a workspace without it instead.",
  connect: (name: string) => `You can't connect ${name} in a shared workspace, because it works only for the ` +
      "person who connects it; connect it in a workspace you haven't shared.",
  cap: `This workspace already has ${WORKSPACE_ROLE_CAP} people with "Workspace" access, the most it allows; ` +
      "remove one of them in the Share window to make room.",
};

/** The slice of the Overseer the share and connect checks read. */
export interface ShareSafetyHost {
  storage: Pick<OverseerStorage, "gatekeepers">;
  listObserverRequirements(role: CollaboratorRole): ObserverBindingNeed[];
  getSharingManager(): Promise<Pick<SharingManager, "listCollaborators">>;
}

/**
 * Refuses a share the granted role could never open: a connection that role is verified against
 * refuses everyone but its connector. Then refuses a "Workspace" share one past the cap, counting the
 * other people listed at "Workspace", so re-adding someone already in passes.
 */
export async function refuseUnsafeShare(
    host: ShareSafetyHost, profile: AiChatAuthorInfo, role: CollaboratorRole): Promise<void> {
  for (let need of host.listObserverRequirements(role)) {
    let spec = host.storage.gatekeepers.get(need.gatekeeperId)?.creationSpec;
    let found = neverShareable(need.vendorId, spec?.type === "gatekeeper" ? spec.typeUrlPattern : undefined);
    if (found) throw new Error(SHARE_SAFETY_REFUSALS.share(found.name));
  }
  if (role !== "build") return;
  let others = (await host.getSharingManager()).listCollaborators().filter(collaborator =>
    (collaborator.role ?? "build") === "build" && collaborator.profile.id !== profile.id);
  if (others.length >= WORKSPACE_ROLE_CAP) throw new Error(SHARE_SAFETY_REFUSALS.cap);
}

/**
 * Refuses connecting one of those connections while anyone else can open the workspace, at either
 * role: it would lock them out, or run a collaborator's own account for everyone there.
 */
export async function refuseUnsafeConnect(
    host: ShareSafetyHost, vendorId: string, typeUrlPattern: string): Promise<void> {
  let found = neverShareable(vendorId, typeUrlPattern);
  if (found && (await host.getSharingManager()).listCollaborators().length > 0) {
    throw new Error(SHARE_SAFETY_REFUSALS.connect(found.name));
  }
}
