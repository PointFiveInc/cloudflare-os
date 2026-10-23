import type { AffectedCollaborator, AiChatAuthorInfo, CollaboratorRole } from "@gadgets/workshop-shared/api";
import type { P5Mark } from "@gadgets/workshop-shared/p5-marks";
import { retryOnDoReset } from "./do-retry";
import { createWorkshopLogger } from "./observability";
import type { SharingManager } from "./sharing";
import type { OverseerStorage } from "./storage-schema/overseer-storage";
import type { GadgetRecord } from "./storage-schema/user-storage.js";
import type { UserDurableObject } from "./user.js";

const logger = createWorkshopLogger("workshop.p5.marks");

/** One change to a person's mark: clear it, or set it, listing the workspace first if it is not yet listed. */
export type P5MarkChange =
  | { clear: true }
  | { mark: P5Mark; listing: { title: string; owner: AiChatAuthorInfo; role: CollaboratorRole } };

/** The slice of the Overseer that the marks read. */
export interface P5MarksHost {
  ctx: Pick<DurableObjectState, "id">;
  storage: Pick<OverseerStorage, "title" | "chatMeta">;
  users: DurableObjectNamespace<UserDurableObject>;
  ownerId?: string;
  logger: ReturnType<typeof createWorkshopLogger>;
  getSharingManager(): Promise<Pick<SharingManager, "listCollaborators">>;
  refreshAffectedCollaboratorListings(affected: AffectedCollaborator[]): Promise<void>;
}

type UserStub = DurableObjectStub<UserDurableObject>;

/**
 * After Cloudflare's grant: lists the workspace for the person at once, with a share mark, at the
 * role the grant left them with. Logged, never thrown into the share.
 */
export async function p5LeaveShareMark(host: P5MarksHost, recipient: UserStub, role: CollaboratorRole,
    sharer: Promise<AiChatAuthorInfo>): Promise<void> {
  try {
    let [by, owner] = await Promise.all([sharer, ownerProfile(host)]);
    await recipient.p5Mark(host.ctx.id.toString(),
        { mark: { kind: "share", by: by.name }, listing: { title: host.storage.title.get(), owner, role } });
  } catch (error) {
    logger.warn("share mark not written", { event: "p5.marks.share.failed", error });
  }
}

/**
 * Once a message that names people is committed: a mention mark for each of them, pointing at
 * `chatId`. The chat's title goes in only for a chat that existed before the message. Each person's
 * mark is logged on failure, never thrown into the send.
 */
export async function p5LeaveMentionMarks(host: P5MarksHost, chatId: number, existingChat: boolean,
    sender: AiChatAuthorInfo, mentioned: readonly { id: string }[], owner: AiChatAuthorInfo): Promise<void> {
  await Promise.all(mentioned.map(async person => {
    try {
      let chatTitle = existingChat ? host.storage.chatMeta.get(chatId)?.title : undefined;
      let mark: P5Mark = { kind: "mention", by: sender.name, chatId, ...chatTitle === undefined ? {} : { chatTitle } };
      await host.users.get(host.users.idFromName(person.id)).p5Mark(host.ctx.id.toString(),
          { mark, listing: { title: host.storage.title.get(), owner, role: "build" } });
    } catch (error) {
      logger.warn("mention mark not written", { event: "p5.marks.mention.failed", error });
    }
  }));
}

/**
 * The one writer of a mark, run inside the person's own User Durable Object. A share marks only a
 * workspace the person has not listed yet, or one still marked; an already opened listing stays
 * as it is. A mention always marks.
 */
export async function p5ApplyMark(
    user: Pick<UserDurableObject, "recordSharedGadgetOpen">,
    gadgets: { get(id: string): GadgetRecord | undefined; put(record: GadgetRecord): void },
    workspaceId: string, change: P5MarkChange): Promise<void> {
  let record = gadgets.get(workspaceId);
  if ("clear" in change) {
    if (record?.p5Mark === undefined) return;
    delete record.p5Mark;
    gadgets.put(record);
    return;
  }
  if (record === undefined) {
    await user.recordSharedGadgetOpen(workspaceId, change.listing.title, change.listing.owner, change.listing.role);
    record = gadgets.get(workspaceId);
    if (record === undefined) return;
  } else if (change.mark.kind === "share" && record.p5Mark === undefined) {
    return;
  }
  record.p5Mark = change.mark;
  gadgets.put(record);
}

/**
 * At the owner's delete: takes the workspace off every collaborator's list through Cloudflare's own
 * listing refresh, as a removal does. Cloudflare's delete forgets only the owner's listing, and a
 * share lists the workspace before anyone opens it. Logged, never thrown into the delete.
 */
export async function p5ForgetSharedListings(host: P5MarksHost): Promise<void> {
  try {
    let collaborators = (await host.getSharingManager()).listCollaborators();
    await host.refreshAffectedCollaboratorListings(collaborators.map(({ profile, addedBy, role }) =>
      ({ profile, addedBy, oldRole: role ?? "build", newRole: null })));
  } catch (error) {
    logger.warn("shared listings not forgotten", { event: "p5.marks.delete.failed", error });
  }
}

/** At any open of the workspace, the owner's included: clears the opener's mark. Logged, never thrown into the open. */
export async function p5ClearMark(user: UserStub, workspaceId: string): Promise<void> {
  try {
    await user.p5Mark(workspaceId, { clear: true });
  } catch (error) {
    logger.warn("mark not cleared", { event: "p5.marks.clear.failed", error });
  }
}

function ownerProfile(host: P5MarksHost): Promise<AiChatAuthorInfo> {
  return retryOnDoReset(() => host.users.get(host.users.idFromString(host.ownerId!)).whoami(), host.logger);
}
