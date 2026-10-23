import type {
  AiChatAuthorInfo, AiChatMessage, AiChatMetadata, MergeChangesResult, WorkpieceId,
} from "@gadgets/workshop-shared/api";
import type { CodeContent } from "@gadgets/workshop-shared/code-change";
import { readAdminConfig } from "./admin-config.js";
import { chatChangeStatuses } from "./agent-compaction.js";
import { retryOnDoReset } from "./do-retry.js";
import type { createWorkshopLogger } from "./observability.js";
import { turnEndAcceptOn } from "./p5-admin-toggles.js";
import type { AdminConfig } from "./storage-schema/admin-settings-storage.js";
import { chatKey, chatKeyPrefix } from "./storage-schema/overseer-storage.js";
import type { UserChatContext, UserDurableObject } from "./user.js";

const AGENT_RUNNING = "Agent is running, wait for it to finish.";
const ACTIVELY_EDITED = "The chat's code is being actively edited; please retry.";
const CLASH_MARK = /^(?:<<<<<<< |>>>>>>> )/m;

/** What the agent is told while the Turn-end accept switch is on. */
export const P5_TURN_END_ACCEPT_GUIDANCE = "## When your changes go live\n\n" +
    "Your changes to a Gadget go live for everyone who uses it as soon as your turn finishes: nobody clicks Accept " +
    "changes, so never ask anyone to. Only if your turn is stopped or fails do your changes wait for the person to " +
    "keep or discard them.";

/** The slice of the Overseer a turn-end accept drives. */
export interface P5TurnEndAcceptHost {
  ctx: { waitUntil(promise: Promise<unknown>): void };
  env: Cloudflare.Env;
  users: DurableObjectNamespace<UserDurableObject>;
  logger: ReturnType<typeof createWorkshopLogger>;
  storage: { chats: { list(options: { prefix: string; start?: string }): Iterable<AiChatMessage> } };
  getChatMetaOrThrow(chatId: number): AiChatMetadata;
  getCurrentChatContent(chatId: number, meta: AiChatMetadata): Promise<CodeContent>;
  nextChatSequencePeek(chatId: number): number;
  withChatLock<T>(chatId: number, fn: () => Promise<T>): Promise<T>;
  mergeChanges(chatId: number, userMeta: UserChatContext, clientUserId: string): Promise<MergeChangesResult>;
  updateChatFromMainline(chatId: number, author: AiChatAuthorInfo): Promise<{ conflictPaths: string[] }>;
}

/**
 * The admin's agent instructions, followed by what the agent is told of turn-end accept while its switch is on: one
 * deployment-wide text, so every chat's prompt shares its cached prefix. With the switch off, Cloudflare's text as is.
 */
export function p5InstanceInstructions(config: AdminConfig): string {
  if (!turnEndAcceptOn(config)) return config.instanceInstructions;
  return [config.instanceInstructions.trim(), P5_TURN_END_ACCEPT_GUIDANCE].filter(Boolean).join("\n\n");
}

/**
 * Called where an agent turn finished: not stopped, no failure; a turn ending on an approval card finished. While the
 * Turn-end accept switch is on, accepts the chat's changes with Cloudflare's own accept, as the person who started the
 * turn. A leftover clash mark, a turn running again or a hand edit in progress leaves them pending.
 */
export function p5TurnEndAccept(host: P5TurnEndAcceptHost, chatId: number, initiatorUserId: string): void {
  host.ctx.waitUntil(acceptIfOn(host, chatId, initiatorUserId));
}

async function acceptIfOn(host: P5TurnEndAcceptHost, chatId: number, initiatorUserId: string): Promise<void> {
  if (!await switchedOn(host.env)) return;
  try {
    await host.withChatLock(chatId, () => accept(host, chatId, initiatorUserId));
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    if (message === AGENT_RUNNING || message === ACTIVELY_EDITED) return;
    host.logger.warn("turn-end accept failed",
        { event: "p5.turn_end_accept.failed", chatId, durableObjectId: initiatorUserId, error });
  }
}

/** An admin config that cannot be read reads off, as a missing switch does; the turn's own read of it logged why. */
async function switchedOn(env: Cloudflare.Env): Promise<boolean> {
  try {
    return turnEndAcceptOn(await readAdminConfig(env));
  } catch {
    return false;
  }
}

async function accept(host: P5TurnEndAcceptHost, chatId: number, initiatorUserId: string): Promise<void> {
  let person = await retryOnDoReset(
      () => host.users.get(host.users.idFromString(initiatorUserId)).getChatContext(null), host.logger);
  let from = host.nextChatSequencePeek(chatId);
  let acceptUnlessClash = async () => await holdsClashMark(host, chatId)
      ? "clash" : (await host.mergeChanges(chatId, person, initiatorUserId)).outcome;
  if (await acceptUnlessClash() === "stale") {
    await host.updateChatFromMainline(chatId, person.profile);
    await acceptUnlessClash();
  }
  if (mergedSince(host, chatId, from)) {
    host.logger.info("turn-end accept",
        { event: "p5.turn_end_accept.accepted", chatId, durableObjectId: initiatorUserId });
  }
}

/** Whether an accept was recorded at or after `sequence`: `mergeChanges` also answers "merged" for nothing to merge. */
function mergedSince(host: P5TurnEndAcceptHost, chatId: number, sequence: number): boolean {
  let recorded = host.storage.chats.list({ prefix: chatKeyPrefix(chatId), start: chatKey(chatId, sequence) });
  return [...recorded].some(message => message.type === "merge");
}

/** The browser's check before its accept (`features/chat/mergeConflicts.ts`), over the chat's files. */
async function holdsClashMark(host: P5TurnEndAcceptHost, chatId: number): Promise<boolean> {
  let messages = [...host.storage.chats.list({ prefix: chatKeyPrefix(chatId) })];
  let statuses = chatChangeStatuses(messages);
  let files = messages.flatMap(message => message.type === "changes" && !statuses.has(message.sequence)
    ? conflictedFiles(message) : []);
  if (files.length === 0) return false;
  let content = await host.getCurrentChatContent(chatId, host.getChatMetaOrThrow(chatId));
  return files.some(([gadgetId, path]) => {
    let text = content.get(gadgetId)?.get(path);
    return typeof text === "string" && CLASH_MARK.test(text);
  });
}

function conflictedFiles(message: AiChatMessage & { type: "changes" }): [WorkpieceId, string][] {
  let merges = [...message.blueprintMerges ?? [], ...message.mainlineMerge?.gadgets ?? []];
  let files = merges.flatMap(merge => merge.conflictPaths.map(path => [merge.gadgetId, path] as [WorkpieceId, string]));
  if (message.mainlineMerge?.gadgets !== undefined) return files;
  for (let qualified of message.mainlineMerge?.conflictPaths ?? []) {
    let path = qualified.slice(qualified.indexOf("/") + 1);
    for (let [gadgetId, entries] of Object.entries(message.change ?? {})) {
      if (entries.some(([changed]) => changed === path)) files.push([Number(gadgetId), path]);
    }
  }
  return files;
}
