import type { AiChatAuthorInfo, SlashCommandRequest } from "@gadgets/workshop-shared/api";
import {
  findAtMentions, otherPeopleInChat, type AtMentionCandidate,
} from "@gadgets/workshop-shared/p5-at-mentions";
import { retryOnDoReset } from "./do-retry";
import { createWorkshopLogger } from "./observability";
import type { SharingManager } from "./sharing";
import type { UserDurableObject } from "./user.js";

const logger = createWorkshopLogger("workshop.p5.at-mentions");

/** The slice of the Overseer the "@" reads. */
export interface P5AtMentionHost {
  ownerId?: string;
  users: DurableObjectNamespace<UserDurableObject>;
  logger: ReturnType<typeof createWorkshopLogger>;
  getSharingManager(): Promise<Pick<SharingManager, "listCollaborators">>;
}

/**
 * The people a message names, in the order it names them. `owner` is the owner's profile read to
 * find them, which their mention marks list the workspace under; it is set whenever anyone is named.
 */
export type P5AtMentioned = AtMentionCandidate[] & { owner?: AiChatAuthorInfo };

/**
 * The people in the chat a person's message names with "@": the owner and the "Workspace"
 * collaborators, minus the sender. Only a string message can name anyone. A message that names
 * someone goes to people only: it is sent with no model and never steers a running turn. A failure
 * to read the people logs and names nobody, so the message is sent as Cloudflare sends it.
 */
export async function p5AtMention(host: P5AtMentionHost, sender: AiChatAuthorInfo,
    message: string | SlashCommandRequest): Promise<P5AtMentioned> {
  if (typeof message !== "string" || !message.includes("@")) return [];
  try {
    let owner = await retryOnDoReset(
        () => host.users.get(host.users.idFromString(host.ownerId!)).whoami(), host.logger);
    let people = otherPeopleInChat(owner, (await host.getSharingManager()).listCollaborators(), sender.id);
    let mentioned = findAtMentions(message, people);
    return mentioned.length ? Object.assign(mentioned, { owner }) : [];
  } catch (error) {
    logger.warn("people in the chat not read", { event: "p5.at-mentions.read.failed", error });
    return [];
  }
}
