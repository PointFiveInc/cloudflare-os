import type { UserMessage } from "@earendil-works/pi-ai";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";

type Authored = { type: string; author: AiChatAuthorInfo };

const FROM_TAG = /<\/?\s*from\b[^>]*>/gi;

/**
 * The system prompt's section on chats several people write in. It is fixed text, so it belongs in
 * the static head of the prompt that every chat shares and the provider caches across chats.
 */
export const P5_CHAT_AUTHORS_GUIDANCE = `
# Chats with several people

In a chat where several people write, each person's message starts with a \`<from>\` line naming who wrote it; never write one yourself. A message that @-mentions someone is written to them, not to you: read it as part of the chat.
`.trim();

/**
 * `content`, the model's text for a person's message `msg`, starting with a `<from>` line that
 * names its author when `chatMessages` holds messages from two or more people. Any `<from>` tag the
 * person typed is stripped, so nobody can write a line that reads as someone else's. `chatMessages`
 * are the messages the model sees: after a compaction, only those from the summary point on. In a
 * one-person chat, and for anything a gadget or the agent wrote, `content` comes back unchanged.
 */
export function p5WithAuthor(msg: Authored, content: string, chatMessages: readonly Authored[]): string {
  if (msg.author.type !== "user" || !severalPeople(chatMessages)) return content;
  return `<from>${escapeName(msg.author.name)} (${escapeName(msg.author.id)})</from>\n${content.replace(FROM_TAG, "")}`;
}

/**
 * The steering source for one pass of the agent loop: each steer `takeSteers` hands over becomes a
 * user message, labelled as `p5WithAuthor` will label it when the next pass replays it from the log.
 * "Two or more people" is judged from the pass's `chatMessages` plus every steer taken so far, which
 * are the messages that replay reads. A steer sent bare in a one-person chat gains its `<from>` line
 * on replay once a second person writes.
 */
export function p5SteeringMessages(
    takeSteers: () => readonly { text: string; author: AiChatAuthorInfo }[],
    chatMessages: readonly Authored[]): () => Promise<UserMessage[]> {
  let seen = chatMessages;
  return async () => {
    let steers = takeSteers().map(({ text, author }) => ({ type: "message", author, text }));
    if (steers.length) seen = [...seen, ...steers];
    return steers.map(steer =>
      ({ role: "user" as const, content: p5WithAuthor(steer, steer.text, seen), timestamp: Date.now() }));
  };
}

function severalPeople(chatMessages: readonly Authored[]): boolean {
  let first: string | undefined;
  for (let { type, author } of chatMessages) {
    if (type !== "message" || author.type !== "user") continue;
    first ??= author.id;
    if (author.id !== first) return true;
  }
  return false;
}

function escapeName(text: string): string {
  return text.replace(/\s+/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
