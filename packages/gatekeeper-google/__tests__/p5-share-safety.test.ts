import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NEVER_SHAREABLE, neverShareable } from "@gadgets/workshop-shared/p5-share-safety";
import { GMAIL_RESOURCE, SUPPORTED_RESOURCES } from "../src/resources";

/**
 * Google types whose gatekeeper checks each collaborator against their own Google account: a share
 * may still be refused at open, but it is never certain to fail.
 */
const SHAREABLE = [
  "https://docs.google.com/document/d/:docId/*",
  "https://docs.google.com/spreadsheets/d/:spreadsheetId/*",
  "https://docs.google.com/presentation/d/:presentationId/*",
  "https://calendar.google.com/calendar/:calendarId/*",
  "https://drive.google.com/drive/my-drive",
  "https://drive.google.com/drive/folders/:folderId",
  "https://drive.google.com/file/d/:fileId/view",
  "https://chat.google.com/:kind(room|dm)/:spaceId",
  "https://chat.google.com/:kind(room|dm)/:spaceId/:threadId{/:messageId}?",
  "https://bigquery.googleapis.com/:projectId/*",
];

const offered = SUPPORTED_RESOURCES.map(resource => resource.urlPattern);

function addObserverBody(file: string, className: string): string {
  let source = readFileSync(join(import.meta.dirname, "../src", file), "utf8");
  let classStart = source.indexOf(`export class ${className} `);
  let start = classStart < 0 ? -1 : source.indexOf("async addObserver(", classStart);
  return start < 0 ? `no addObserver in ${className}` : source.slice(start, source.indexOf("\n  }\n", start));
}

describe("share safety: which Google types a workspace can be shared with", () => {
  it("classifies every type Google offers exactly once, by a pattern Google still offers", () => {
    expect(offered.filter(pattern => SHAREABLE.includes(pattern) === (neverShareable("google", pattern) !== undefined)),
      "a new or renamed Google type: add it to SHAREABLE here, or to NEVER_SHAREABLE in workshop-shared's " +
      "p5-share-safety.ts if its gatekeeper refuses everyone but the person who connected it").toEqual([]);
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
      onlyThrows: /\)[^{]*\{\s*throw new Error\([^;]*\);\s*$/.test(addObserverBody("gmail.ts", "GmailGatekeeperImpl")),
    }, "Gmail's gatekeeper now admits other people, or its type left NEVER_SHAREABLE: re-check Gmail's entry")
      .toEqual({ entry: "Gmail", onlyThrows: true });
  });
});
