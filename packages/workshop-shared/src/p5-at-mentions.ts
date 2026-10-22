import type { CollaboratorInfo } from "./api";

/** Someone an "@" can name. */
export type AtMentionCandidate = { id: string; name: string };

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * The people an "@" by `senderId` can name: the workspace's owner and its "Workspace" collaborators,
 * the people in its chats, minus the sender.
 */
export function otherPeopleInChat(
    owner: AtMentionCandidate, collaborators: readonly CollaboratorInfo[], senderId: string): AtMentionCandidate[] {
  let builders = collaborators.filter(collaborator => (collaborator.role ?? "build") === "build");
  return [owner, ...builders.map(collaborator => collaborator.profile)].filter(person => person.id !== senderId);
}

/** One "@" in a text: where it stands, and everyone it names. */
export type AtMentionSpan<P extends AtMentionCandidate> = { start: number; end: number; people: P[] };

/**
 * Each "@" in `text`, where it stands: at each "@" that starts a word, the longest listed name after
 * it (any case) that ends a word, with everyone who has that name. `end` is the index just past the
 * name.
 */
export function atMentionSpans<P extends AtMentionCandidate>(text: string, people: readonly P[]): AtMentionSpan<P>[] {
  let spans: AtMentionSpan<P>[] = [];
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (at > 0 && WORD_CHAR.test(text[at - 1])) continue;
    let matches = people.filter(person => {
      let name = person.name.trim();
      let end = at + 1 + name.length;
      return name !== "" && text.slice(at + 1, end).toLowerCase() === name.toLowerCase() &&
          !WORD_CHAR.test(text[end] ?? "");
    });
    if (matches.length === 0) continue;
    let longest = Math.max(...matches.map(person => person.name.trim().length));
    let named = matches.filter(person => person.name.trim().length === longest);
    spans.push({ start: at, end: at + 1 + longest, people: named });
  }
  return spans;
}

/** Everyone `text` names: the people of its `atMentionSpans`. People who share a name are all named. */
export function findAtMentions<P extends AtMentionCandidate>(text: string, people: readonly P[]): P[] {
  let found = new Map<string, P>();
  for (let span of atMentionSpans(text, people)) for (let person of span.people) found.set(person.id, person);
  return [...found.values()];
}

/**
 * The picks a send of `text` grants: the people it names when read over the people in the chat and
 * the picks together, as the hint reads it, kept to the picks. A typed name never grants, and a pick
 * whose name is only the start of a longer name in the chat is not named.
 */
export function atMentionGrants<P extends AtMentionCandidate>(
    text: string, inChat: readonly AtMentionCandidate[], picks: readonly P[]): P[] {
  let picked = new Map(picks.map(person => [person.id, person]));
  return findAtMentions(text, [...inChat, ...picks]).flatMap(person => picked.get(person.id) ?? []);
}

/**
 * The "@" token the caret ends, on `findAtMentions`' own word rule: an "@" at the start or after a
 * non-word character, up to the caret, at most 40 characters, no new line; null when there is none.
 */
export function atMentionToken(text: string, caret: number): { start: number; query: string } | null {
  let at = caret > 0 ? text.lastIndexOf("@", caret - 1) : -1;
  if (at === -1 || (at > 0 && WORD_CHAR.test(text[at - 1]))) return null;
  let query = text.slice(at + 1, caret);
  return query.length <= 40 && !query.includes("\n") ? { start: at, query } : null;
}
