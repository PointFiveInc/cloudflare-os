import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NEVER_SHAREABLE, neverShareable } from "@gadgets/workshop-shared/p5-share-safety";
import { GMAIL_RESOURCE, SUPPORTED_RESOURCES } from "../src/resources";

/**
 * Google types whose gatekeeper checks each collaborator against their own Google account and has no
 * lock that shuts everyone else out: a share may still be refused at open, until Google grants access.
 */
const SHAREABLE = [
  "https://docs.google.com/document/d/:docId/*",
  "https://docs.google.com/spreadsheets/d/:spreadsheetId/*",
  "https://docs.google.com/presentation/d/:presentationId/*",
  "https://calendar.google.com/calendar/:calendarId/*",
  "https://drive.google.com/file/d/:fileId/view",
  "https://chat.google.com/:kind(room|dm)/:spaceId",
  "https://chat.google.com/:kind(room|dm)/:spaceId/:threadId{/:messageId}?",
  "https://bigquery.googleapis.com/:projectId/*",
];

const SRC = join(import.meta.dirname, "../src");
const offered = SUPPORTED_RESOURCES.map(resource => resource.urlPattern);

function sources(): [file: string, source: string][] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter(file => file.endsWith(".ts") && !file.endsWith(".d.ts"))
    .toSorted()
    .map(file => [file, readFileSync(join(SRC, file), "utf8")]);
}

function addObserverBodies(source: string): string[] {
  return [...source.matchAll(
    /(?<![\w$#.])(?:(?:async\s+)?addObserver\s*\([^)]*\)[^{;]*|addObserver\s*[:=]\s*(?:async\s*)?\([^)]*\)[^{;=]*=>\s*)\{/g)]
    .map(({ 0: head, index }) => {
      let start = index + head.length;
      let end = start;
      for (let depth = 1; depth > 0 && end < source.length; end++) {
        depth += source[end] === "{" ? 1 : source[end] === "}" ? -1 : 0;
      }
      return source.slice(start, end - 1);
    });
}

function onlyThrows(body: string): boolean {
  let code = body.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
    token => token.startsWith("/") ? "" : '""');
  return /^\s*throw\b[^;]*;\s*$/.test(code);
}

function locksPerFile(): Record<string, Record<string, number>> {
  let files = sources();
  let perFile = (count: (source: string) => number) => Object.fromEntries(
    files.map(([file, source]) => [file, count(source)] as const).filter(([, found]) => found !== 0));
  return {
    ...Object.fromEntries(["authorizeWithheld(", ".prepareWithheld()", "privateObservers(", "withholdFromObservers"]
      .map(lock => [lock, perFile(source => source.split(lock).length - 1)])),
    "addObserver that only throws": perFile(source => addObserverBodies(source).filter(onlyThrows).length),
  };
}

describe("share safety: which Google types a workspace can be shared with", () => {
  it("classifies every type Google offers exactly once, by a pattern Google still offers", () => {
    expect(offered.filter(pattern => SHAREABLE.includes(pattern) === (neverShareable("google", pattern) !== undefined)),
      "a new or renamed Google type: add it to SHAREABLE here, or to NEVER_SHAREABLE in workshop-shared's " +
      "p5-share-safety.ts if its gatekeeper can lock out everyone but the person who connected it").toEqual([]);
    let listed = [...SHAREABLE, ...NEVER_SHAREABLE.filter(entry => entry.vendorId === "google")
      .map(entry => entry.typeUrlPattern)];
    expect(listed.filter(pattern => pattern === undefined || !offered.includes(pattern)),
      "Google no longer offers this type under this pattern: re-check which Google types are shareable").toEqual([]);
  });

  it("lets the agent create only shareable types", () => {
    expect(SUPPORTED_RESOURCES.filter(resource => resource.creatable && !SHAREABLE.includes(resource.urlPattern))
      .map(resource => resource.urlPattern),
      "a creatable type that refuses collaborators needs a refusal where the agent's creation is approved").toEqual([]);
  });

  it("never shares Gmail, whose gatekeeper admits nobody but the person who connected it", () => {
    expect({
      entry: neverShareable("google", GMAIL_RESOURCE.urlPattern)?.name,
      onlyThrows: addObserverBodies(readFileSync(join(SRC, "gmail.ts"), "utf8")).map(onlyThrows),
    }, "Gmail's gatekeeper now admits other people, or its type left NEVER_SHAREABLE: re-check Gmail's entry")
      .toEqual({ entry: "Gmail", onlyThrows: [true] });
  });

  it("counts every lock Google's gatekeeper can put on a connection, so a new one gets classified", () => {
    expect(locksPerFile(),
      "Google's gatekeeper gained or lost a lock that can shut a connection to everyone but its connector: find " +
      "each type the changed site reaches and classify it, in SHAREABLE here or in NEVER_SHAREABLE in " +
      "workshop-shared's p5-share-safety.ts with a test of its real refusal, then update these counts").toEqual({
      "authorizeWithheld(": { "drive-session.ts": 6 },
      ".prepareWithheld()": { "google.ts": 1 },
      "privateObservers(": {},
      "withholdFromObservers": {},
      "addObserver that only throws": { "gmail.ts": 1 },
    });
  });
});
