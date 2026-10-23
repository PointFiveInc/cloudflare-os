// Pins the shapes of Cloudflare's code that PointFive's p5- changes lean on, so a merge from
// Cloudflare that moves one turns red here instead of quietly skipping our change. Counts read
// Cloudflare's files only: our own p5- files never count.

import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BACKEND = "workshop-backend/src";
const SHARED = "workshop-shared/src";

type Source = {
  path: string;
  /** The file with every comment blanked to spaces; offsets and line numbers match the file. */
  code: string;
  /** `code` with the insides of strings, templates and regular expressions blanked too. */
  masked: string;
};

const REGEX_AFTER_WORDS = new Set([
  "await", "case", "delete", "do", "else", "in", "instanceof", "new", "of", "return", "throw",
  "typeof", "void", "yield",
]);

function blank(chars: string[], from: number, to: number): void {
  for (let at = from; at < to; at++) {
    if (chars[at] !== "\n") chars[at] = " ";
  }
}

function blankText(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

function quotedEnd(source: string, start: number): number {
  let at = start + 1;
  while (at < source.length && source[at] !== source[start] && source[at] !== "\n") {
    at += source[at] === "\\" ? 2 : 1;
  }
  return at + 1;
}

/** The end of the regular expression literal at `start`, or -1 when that slash divides. */
function regexEnd(source: string, start: number): number {
  let inClass = false;
  for (let at = start + 1; at < source.length; at++) {
    const char = source[at];
    if (char === "\n") return -1;
    if (char === "\\") at++;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      let end = at + 1;
      while (/[a-z]/.test(source[end] ?? "")) end++;
      return end;
    }
  }
  return -1;
}

function lex(source: string): Pick<Source, "code" | "masked"> {
  const code = [...source];
  const masked = [...source];
  const substitutions: number[] = [];
  let depth = 0;
  let regexAllowed = true;
  let at = 0;

  const template = (start: number): number => {
    let end = start;
    while (end < source.length && source[end] !== "`" && !(source[end] === "$" && source[end + 1] === "{")) {
      end += source[end] === "\\" ? 2 : 1;
    }
    if (source[end] === "`") {
      blank(masked, start - 1, end + 1);
      regexAllowed = false;
      return end + 1;
    }
    blank(masked, start - 1, end + 2);
    substitutions.push(depth);
    regexAllowed = true;
    return end + 2;
  };

  while (at < source.length) {
    const char = source[at]!;
    const next = source[at + 1];
    const regex = char === "/" && regexAllowed ? regexEnd(source, at) : -1;
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", at);
      const stop = end === -1 ? source.length : end;
      blank(code, at, stop);
      blank(masked, at, stop);
      at = stop;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", at + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(code, at, stop);
      blank(masked, at, stop);
      at = stop;
    } else if (char === '"' || char === "'") {
      const end = quotedEnd(source, at);
      blank(masked, at + 1, end - 1);
      regexAllowed = false;
      at = end;
    } else if (char === "`") {
      at = template(at + 1);
    } else if (char === "}" && substitutions.at(-1) === depth) {
      substitutions.pop();
      at = template(at + 1);
    } else if (regex !== -1) {
      blank(masked, at + 1, regex);
      regexAllowed = false;
      at = regex;
    } else if (/[\w$]/.test(char)) {
      let end = at + 1;
      while (/[\w$]/.test(source[end] ?? "")) end++;
      regexAllowed = REGEX_AFTER_WORDS.has(source.slice(at, end));
      at = end;
    } else {
      if (char === "{") depth++;
      if (char === "}") depth--;
      if (!/\s/.test(char)) regexAllowed = !/[)\]]/.test(char);
      at++;
    }
  }
  return { code: code.join(""), masked: masked.join("") };
}

/**
 * Cloudflare's own `.ts` files under `packages/<root>`, comments blanked. Skips every p5- file and
 * the build output in `generated/`. `.ts` only: `lex` reads no JSX.
 */
function cloudflareSources(root: string): Source[] {
  return readdirSync(join(PACKAGES, root), { recursive: true, encoding: "utf8" })
    .filter(path => path.endsWith(".ts"))
    .filter(path => !path.split(sep).some(part => part === "generated" || part.startsWith("p5-")))
    .toSorted()
    .map(path => ({
      path: `${root}/${path.split(sep).join("/")}`,
      ...lex(readFileSync(join(PACKAGES, root, path), "utf8")),
    }));
}

/** Each place `token` occurs in the code of `sources`, as `path:line`. */
function occurrences(sources: Source[], token: string): string[] {
  return sources.flatMap(({ path, code }) => {
    const places: string[] = [];
    for (let at = code.indexOf(token); at !== -1; at = code.indexOf(token, at + token.length)) {
      places.push(`${path}:${code.slice(0, at).split("\n").length}`);
    }
    return places;
  });
}

/** `source` with everything outside `from`..`to` blanked; offsets and line numbers still match. */
function within(source: Source, from: number, to: number): Source {
  const keep = (text: string) =>
    blankText(text.slice(0, from)) + text.slice(from, to) + blankText(text.slice(to));
  return { path: source.path, code: keep(source.code), masked: keep(source.masked) };
}

/** The braces that open at the end of `header`'s first match in `source`, or nothing when it has none. */
function bracedAfter(source: Source, header: RegExp): Source {
  const found = header.exec(source.masked);
  if (found === null) return within(source, 0, 0);
  const open = found.index + found[0].length - 1;
  let depth = 0;
  for (let at = open; at < source.masked.length; at++) {
    if (source.masked[at] === "{") depth++;
    if (source.masked[at] === "}" && --depth === 0) return within(source, open, at + 1);
  }
  return within(source, 0, 0);
}

/** The body of the method or function `name` declared in `source`, or nothing when there is none. */
function memberBody(source: Source, name: string): Source {
  const modifiers = "(?:(?:export|public|private|protected|static|override|async|function)\\s+)*";
  return bracedAfter(source, new RegExp(`^[ \\t]*${modifiers}${name}\\s*[(<][^;{]*\\{`, "m"));
}

/** The body of the class or interface `name` declared in `source`, or nothing when there is none. */
function typeBody(source: Source, name: string): Source {
  return bracedAfter(source, new RegExp(`^(?:export\\s+)?(?:class|interface)\\s+${name}\\b[^{]*\\{`, "m"));
}

/** Each declaration of the method `name` in an interface's `body`, up to its `;`, whitespace collapsed. */
function declarations(body: Source, name: string): string[] {
  return [...body.code.matchAll(new RegExp(`^[ \\t]*${name}\\s*[(<][^;]*;`, "gm"))]
    .map(([declaration]) => declaration.replace(/\s+/g, " ").trim());
}

/**
 * The `type` tag of each object in the union type alias `name` declared in `source`, in order, read
 * up to the alias's closing `;`. Tags of objects nested inside a member are not read.
 */
function unionTypeTags(source: Source, name: string): string[] {
  const header = new RegExp(`^(?:export\\s+)?type\\s+${name}\\s*=`, "m").exec(source.masked);
  if (header === null) return [];
  const tag = /type\s*:\s*"(\w+)"/y;
  const tags: string[] = [];
  let depth = 0;
  for (let at = header.index + header[0].length; at < source.masked.length; at++) {
    const char = source.masked[at]!;
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === ";" && depth === 0) break;
    else if (char === "t" && depth === 1 && !/[\w$]/.test(source.masked[at - 1]!)) {
      tag.lastIndex = at;
      const found = tag.exec(source.code);
      if (found !== null) tags.push(found[1]!);
    }
  }
  return tags;
}

function sourceAt(sources: Source[], path: string): Source {
  const source = sources.find(entry => entry.path === path);
  if (source === undefined) throw new Error(`${path} is not among Cloudflare's sources`);
  return source;
}

/**
 * A person's two ways into a chat, as Cloudflare's `Overseer` interface declares them. Every hook on
 * a person's message sits in the client's implementations of these two.
 */
const CHAT_ENTRY_POINTS = {
  newChat: [
    "newChat(initialMessage: string | SlashCommandRequest, modelId: string | null, capsules?: " +
      "CapsuleSpecifier[], attachments?: ChatAttachmentHandle[], formats?: MessageFormatRef[]): Promise<number>;",
  ],
  sendChatMessage: [
    "sendChatMessage(chatId: number, message: string | SlashCommandRequest, modelId: string | null, " +
      "capsules?: CapsuleSpecifier[], attachments?: ChatAttachmentHandle[], formats?: MessageFormatRef[]): " +
      "Promise<void>;",
  ],
};

/**
 * The kinds of record in a chat's log, as Cloudflare's `AiChatMessageBody` declares them. Only a
 * `message` carries a person's typed words to the model, and replay gives it its author's line.
 */
const CHAT_RECORD_TYPES = [
  "message", "slashCommand", "changes", "merge", "revert", "action", "useGadget", "catalogChange", "error",
  "agentCallback", "agentNudge", "connectionRequest",
];

function chatEntryPoints(): typeof CHAT_ENTRY_POINTS {
  const overseer = typeBody(sourceAt(cloudflareSources(SHARED), `${SHARED}/api.ts`), "Overseer");
  return {
    newChat: declarations(overseer, "newChat"),
    sendChatMessage: declarations(overseer, "sendChatMessage"),
  };
}

describe("the source walker", () => {
  it("reads Cloudflare's backend files from disk and never a p5- file", () => {
    const onDisk = readdirSync(join(PACKAGES, BACKEND), { recursive: true, encoding: "utf8" });
    const sources = cloudflareSources(BACKEND);
    const paths = sources.map(source => source.path);

    expect(onDisk.filter(path => basename(path).startsWith("p5-"))).not.toEqual([]);
    expect(paths.filter(path => basename(path).startsWith("p5-"))).toEqual([]);
    expect(paths.filter(path => path.includes("/generated/"))).toEqual([]);
    expect(paths).toEqual(expect.arrayContaining([`${BACKEND}/overseer.ts`, `${BACKEND}/server.ts`]));
    for (const file of ["overseer.ts", "server.ts"]) {
      const source = sourceAt(sources, `${BACKEND}/${file}`);
      expect(source.code).toHaveLength(readFileSync(join(PACKAGES, BACKEND, file), "utf8").length);
    }
    expect(sourceAt(sources, `${BACKEND}/overseer.ts`).code).toContain("getSharingManager(");
    expect(sourceAt(sources, `${BACKEND}/server.ts`).code).toContain("overseer.open(");
  });

  it("blanks comments and keeps strings, templates and regular expressions", () => {
    const source = [
      "const url = \"https://example.com/*\"; // gone",
      "/* gone",
      "   gone */ const quote = 'it\\'s // kept';",
      "const pattern = /\\/\\/ kept [/*]/g, half = total / 2; // gone",
      "const text = `a ${url.replace(/\\//g, \"}\")} // kept ${`${quote}`} /* kept */`; /* gone */",
    ].join("\n");

    const { code, masked } = lex(source);

    expect(code).toHaveLength(source.length);
    expect(code.split("\n").map(line => line.trimEnd())).toEqual([
      "const url = \"https://example.com/*\";",
      "",
      `${" ".repeat(11)}const quote = 'it\\'s // kept';`,
      "const pattern = /\\/\\/ kept [/*]/g, half = total / 2;",
      "const text = `a ${url.replace(/\\//g, \"}\")} // kept ${`${quote}`} /* kept */`;",
    ]);
    expect(masked).not.toMatch(/kept|https|[{}]/);
  });

  it("finds a method's body by its braces, past braces in strings, and keeps its line numbers", () => {
    const source = {
      path: "example.ts",
      ...lex([
        "class Example {",
        "  async before() { return '}'; }",
        "  async target(): Promise<void> {",
        "    const close = \"}\";",
        "    if (ready) { new Thing(close); }",
        "  }",
        "  after() { new Thing(); }",
        "}",
      ].join("\n")),
    };

    expect(occurrences([source], "new Thing(")).toEqual(["example.ts:5", "example.ts:7"]);
    expect(occurrences([memberBody(source, "target")], "new Thing(")).toEqual(["example.ts:5"]);
    expect(occurrences([memberBody(source, "missing")], "new Thing(")).toEqual([]);
  });

  it("finds a class's or an interface's body, a member inside it, and an interface's declarations", () => {
    const source = {
      path: "example.ts",
      ...lex([
        "class First { target() { new Thing(); } }",
        "export class Second extends First implements Shape {",
        "  async target(): Promise<void> { new Thing(\"{\"); }",
        "}",
        "export interface Shape extends Base {",
        "  /** Gone. */",
        "  target(",
        "      first: string | null, // gone",
        "      second?: number[]): Promise<void>;",
        "  other(): void;",
        "}",
      ].join("\n")),
    };

    expect(occurrences([memberBody(typeBody(source, "Second"), "target")], "new Thing(")).toEqual(["example.ts:3"]);
    expect(occurrences([typeBody(source, "Secon")], "new Thing(")).toEqual([]);
    expect(declarations(typeBody(source, "Shape"), "target"))
      .toEqual(["target( first: string | null, second?: number[]): Promise<void>;"]);
    expect(declarations(typeBody(source, "Shape"), "missing")).toEqual([]);
  });

  it("reads the type tag of each object in a union type alias, past nested objects, strings and comments", () => {
    const source = {
      path: "example.ts",
      ...lex([
        "type Before = { type: \"before\" };",
        "export type Body = {",
        "  /** type: \"comment\" */",
        "  type: \"first\";",
        "  nested: { type: \"nested\"; label: \"};\" };",
        "} | {",
        "  type: \"second\",",
        "  subtype: \"third\";",
        "} | Named;",
        "type After = { type: \"after\" };",
      ].join("\n")),
    };

    expect(unionTypeTags(source, "Body")).toEqual(["first", "second"]);
    expect(unionTypeTags(source, "Bod")).toEqual([]);
  });
});

describe("Cloudflare code PointFive's changes lean on", () => {
  it("owner-only sharing: one add, one link redemption, six collaborator writes, and one sharing manager, " +
      "built in getSharingManager", () => {
    const backend = cloudflareSources(BACKEND);
    const getSharingManager = memberBody(sourceAt(backend, `${BACKEND}/overseer.ts`), "getSharingManager");
    const found = {
      addCollaborator: occurrences(backend, ".addCollaborator("),
      redeemShareKey: occurrences(backend, ".redeemShareKey("),
      collaboratorWrites: occurrences(backend, "collaborators.put("),
      sharingManagers: occurrences(backend, "new SharingManager("),
      sharingManagersInGetSharingManager: occurrences([getSharingManager], "new SharingManager("),
    };

    expect(Object.fromEntries(Object.entries(found).map(([pin, places]) => [pin, places.length])),
      "a new way to add someone, redeem a link, write a collaborator, or reach sharing without " +
      "getSharingManager skips p5-owner-only.ts: re-check it and its hooks in getSharingManager and " +
      `open(). Found: ${JSON.stringify(found, null, 2)}`).toEqual({
      addCollaborator: 1,
      redeemShareKey: 1,
      collaboratorWrites: 6,
      sharingManagers: 1,
      sharingManagersInGetSharingManager: 1,
    });
  });

  it("share safety: one connection lookup, in newGatekeeper; the one add, in addCollaborator; one creation applied",
      () => {
    const backend = cloudflareSources(BACKEND);
    const overseer = sourceAt(backend, `${BACKEND}/overseer.ts`);
    const userFile = `${BACKEND}/user.ts`;
    const found = {
      lookupCallers: occurrences(backend.filter(source => source.path !== userFile), "getGatekeeperClassFor("),
      lookupCallersInNewGatekeeper: occurrences([memberBody(overseer, "newGatekeeper")], "getGatekeeperClassFor("),
      lookupInUserFile: occurrences([sourceAt(backend, userFile)], "getGatekeeperClassFor("),
      addsInAddCollaborator: occurrences([memberBody(overseer, "addCollaborator")], ".addCollaborator("),
      creationsApplied: occurrences(backend, "applyCreation("),
    };

    expect(Object.fromEntries(Object.entries(found).map(([pin, places]) => [pin, places.length])),
      "a new way to connect an account's resource, to add someone, or to apply a created resource skips " +
      "p5-share-safety.ts: re-check it and its hooks in newGatekeeper and addCollaborator. user.ts holds the " +
      `lookup's definition and the vendor call it makes. Found: ${JSON.stringify(found, null, 2)}`).toEqual({
      lookupCallers: 1,
      lookupCallersInNewGatekeeper: 1,
      lookupInUserFile: 2,
      addsInAddCollaborator: 1,
      creationsApplied: 1,
    });
  });

  it("marks: one workspace open in the Worker, in #openGadgetInternal, and one workspace delete, in the " +
      "client's deleteSelf", () => {
    const backend = cloudflareSources(BACKEND);
    const server = sourceAt(backend, `${BACKEND}/server.ts`);
    const client = typeBody(sourceAt(backend, `${BACKEND}/overseer.ts`), "OverseerClientInterface");
    const deleteSelf = memberBody(client, "deleteSelf");
    const found = {
      opens: occurrences([server], "overseer.open("),
      opensInOpenGadgetInternal: occurrences([memberBody(server, "#openGadgetInternal")], "overseer.open("),
      ownerListRemovals: occurrences(backend, ".deleteGadget("),
      ownerListRemovalsInDeleteSelf: occurrences([deleteSelf], ".deleteGadget("),
      storageWipes: occurrences(backend, "storage.deleteAll()"),
      storageWipesInDeleteSelf: occurrences([deleteSelf], "storage.deleteAll()"),
    };

    expect(Object.fromEntries(Object.entries(found).map(([pin, places]) => [pin, places.length])),
      "a new way for the Worker to open a workspace skips the mark clear in p5-marks.ts, and a new way to " +
      "delete one skips its shared-listings clean-up: re-check it and its hooks in #openGadgetInternal and " +
      `the client's deleteSelf. Found: ${JSON.stringify(found, null, 2)}`).toEqual({
      opens: 1,
      opensInOpenGadgetInternal: 1,
      ownerListRemovals: 1,
      ownerListRemovalsInDeleteSelf: 1,
      storageWipes: 1,
      storageWipesInDeleteSelf: 1,
    });
  });

  it("\"@\": one steer, behind the mention check in the client's sendChatMessage, and two calls each of newChat " +
      "and sendChatMessage, one in each client wrapper", () => {
    const backend = cloudflareSources(BACKEND);
    const client = typeBody(sourceAt(backend, `${BACKEND}/overseer.ts`), "OverseerClientInterface");
    const clientNewChat = memberBody(client, "newChat");
    const clientSendChatMessage = memberBody(client, "sendChatMessage");
    const found = {
      steers: occurrences(backend, ".steerRunningTurn("),
      steersBehindTheMentionCheck: occurrences([clientSendChatMessage],
        "if (!mentioned.length && this.impl.steerRunningTurn("),
      newChats: occurrences(backend, ".newChat("),
      newChatsInTheClientNewChat: occurrences([clientNewChat], ".newChat("),
      sendChatMessages: occurrences(backend, ".sendChatMessage("),
      sendChatMessagesInTheClientSendChatMessage: occurrences([clientSendChatMessage], ".sendChatMessage("),
    };

    expect(Object.fromEntries(Object.entries(found).map(([pin, places]) => [pin, places.length])),
      "a new way to steer a running turn, or to send a person's message into a chat, skips p5-at-mentions.ts, so " +
      "an \"@\" could reach the agent: re-check it and its hooks in the client's newChat and sendChatMessage. The " +
      "other newChat and sendChatMessage are the external message entry, which stays unhooked. " +
      `Found: ${JSON.stringify(found, null, 2)}`).toEqual({
      steers: 1,
      steersBehindTheMentionCheck: 1,
      newChats: 2,
      newChatsInTheClientNewChat: 1,
      sendChatMessages: 2,
      sendChatMessagesInTheClientSendChatMessage: 1,
    });
  });

  it("the chat entry points: the Overseer declares newChat and sendChatMessage once each, as the hooks expect",
      () => {
    expect(chatEntryPoints(), "a changed or added chat entry point can carry a person's message past the hooks " +
      "in the client's newChat and sendChatMessage, or to the model without its author's <from> line: re-check " +
      "every p5- hook there, and p5-chat-authors.ts's hooks in agent.ts").toEqual(CHAT_ENTRY_POINTS);
  });

  it("authors: one steering source, in agent.ts, no follow-up source, and the chat log's twelve kinds of record",
      () => {
    const backend = cloudflareSources(BACKEND);
    const found = {
      steeringSources: occurrences(backend, "getSteeringMessages"),
      steeringSourcesInAgent: occurrences([sourceAt(backend, `${BACKEND}/agent.ts`)], "getSteeringMessages"),
      followUpSources: occurrences(backend, "getFollowUpMessages"),
    };

    expect(Object.fromEntries(Object.entries(found).map(([pin, places]) => [pin, places.length])),
      "a second way for a person's words to reach the model during a turn skips p5-chat-authors.ts, so they " +
      "reach it with no <from> line: re-check its hooks at agent.ts's replay and steering source. " +
      `Found: ${JSON.stringify(found, null, 2)}`).toEqual({
      steeringSources: 1,
      steeringSourcesInAgent: 1,
      followUpSources: 0,
    });
    expect(unionTypeTags(sourceAt(cloudflareSources(SHARED), `${SHARED}/api.ts`), "AiChatMessageBody"),
      "a new or renamed kind of chat record can carry a person's words to the model past replay's labelled " +
      "message: re-check p5-chat-authors.ts's hook in agent.ts's replay").toEqual(CHAT_RECORD_TYPES);
  });
});
