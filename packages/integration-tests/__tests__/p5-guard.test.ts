// Pins the shapes of Cloudflare's code that PointFive's p5- changes lean on, so a merge from
// Cloudflare that moves one turns red here instead of quietly skipping our change. Counts read
// Cloudflare's files only: our own p5- files never count.

import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BACKEND = "workshop-backend/src";

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

/** The body of the method or function `name` declared in `source`, or nothing when there is none. */
function memberBody(source: Source, name: string): Source {
  const modifiers = "(?:(?:export|public|private|protected|static|override|async|function)\\s+)*";
  const header = new RegExp(`^[ \\t]*${modifiers}${name}\\s*[(<][^;{]*\\{`, "m").exec(source.masked);
  if (header === null) return within(source, 0, 0);
  const open = header.index + header[0].length - 1;
  let depth = 0;
  for (let at = open; at < source.masked.length; at++) {
    if (source.masked[at] === "{") depth++;
    if (source.masked[at] === "}" && --depth === 0) return within(source, open, at + 1);
  }
  return within(source, 0, 0);
}

function sourceAt(sources: Source[], path: string): Source {
  const source = sources.find(entry => entry.path === path);
  if (source === undefined) throw new Error(`${path} is not among Cloudflare's sources`);
  return source;
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

  it("marks: one workspace open in the Worker, in #openGadgetInternal", () => {
    const server = sourceAt(cloudflareSources(BACKEND), `${BACKEND}/server.ts`);
    const found = {
      opens: occurrences([server], "overseer.open("),
      opensInOpenGadgetInternal: occurrences([memberBody(server, "#openGadgetInternal")], "overseer.open("),
    };

    expect(Object.fromEntries(Object.entries(found).map(([pin, places]) => [pin, places.length])),
      "a new way for the Worker to open a workspace skips the mark clear in p5-marks.ts: re-check it and " +
      `its hook in #openGadgetInternal. Found: ${JSON.stringify(found, null, 2)}`).toEqual({
      opens: 1,
      opensInOpenGadgetInternal: 1,
    });
  });
});
