import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { GadgetMetadataWithTimestamps } from "@gadgets/workshop-shared/api";
import type { P5Mark, P5Marked } from "@gadgets/workshop-shared/p5-marks";
import { p5LeaveMentionMarks } from "../src/p5-marks.js";
import { SharingManager } from "../src/sharing.js";
import { UserDurableObject } from "../src/user.js";
import { asThemselves, inWorkspace, signedIn, type Person, type Workspace } from "./p5-workspace.js";

type Listed = GadgetMetadataWithTimestamps & P5Marked;

const SHARED_BY_IZZY: P5Mark = { kind: "share", by: "Izzy Lazerson" };

async function listing(person: Person, workspaceId: string): Promise<Listed | undefined> {
  return (await person.user.listGadgets()).find(row => row.id === workspaceId);
}

async function markOf(person: Person, workspaceId: string): Promise<P5Mark | undefined> {
  return (await listing(person, workspaceId))?.p5Mark;
}

/** The marks a sent "@" leaves: `sender` names `people` in a new chat. */
function mentioned(workspace: Workspace, sender: Person, people: Person[], owner: Person, chatId = 3) {
  return p5LeaveMentionMarks(workspace.impl, chatId, false, sender.profile, people.map(person => person.profile),
      owner.profile);
}

/** Whether the person's list shows the workspace, and with which mark. */
async function rowOf(person: Person, workspaceId: string): Promise<string> {
  let row = await listing(person, workspaceId);
  return row === undefined ? "not listed" : row.p5Mark?.kind ?? "unmarked";
}

function settled(call: Promise<unknown>): Promise<string> {
  return call.then(() => "resolved", (error: Error) => `rejected: ${error.message}`);
}

/** Opens the workspace through the Worker's `/api`, as the browser does when the person clicks its row. */
async function opens(person: Person, workspaceId: string): Promise<string> {
  return asThemselves(person, async api => (await api.openGadget(workspaceId).getMetadata()).id);
}

function deletes(owner: Person, workspaceId: string): Promise<string> {
  return settled(asThemselves(owner, async api => { await api.openGadget(workspaceId).deleteSelf(); }));
}

/** How many keys the workspace's own storage still holds: none once a delete has run to the end. */
async function keysLeft(workspaceId: string): Promise<number> {
  let overseer = env.TEST_OVERSEER.get(env.TEST_OVERSEER.idFromString(workspaceId));
  return runInDurableObject(overseer, async (_instance, state) => (await state.storage.list()).size);
}

function warnedEvents(warn: MockInstance<typeof console.warn>): unknown[] {
  return warn.mock.calls.map(([entry]) => (entry as { event?: unknown } | undefined)?.event);
}

afterEach(() => vi.restoreAllMocks());

describe("a share", { timeout: 90_000 }, () => {
  it("lists the workspace for the person at once, with its title, owner, role and who shared it", async () => {
    let izzy = await signedIn("Izzy Lazerson");
    let akiva = await signedIn("Akiva Cohen");
    let bob = await signedIn("Bob Builder");
    let id = await inWorkspace(izzy, async workspace => {
      workspace.impl.storage.title.put("Q3 plan");
      using owner = await workspace.open(izzy);
      expect(await owner.addCollaborator(akiva.profile.id, "build")).toMatchObject({ role: "build" });
      expect(await listing(akiva, workspace.id)).toMatchObject({
        title: "Q3 plan", owner: izzy.profile, role: "build", p5Mark: SHARED_BY_IZZY,
      });
      using collaborator = await workspace.open(akiva);
      expect(await collaborator.addCollaborator(bob.profile.id, "use")).toMatchObject({ role: "use" });
      expect(await listing(bob, workspace.id)).toMatchObject({
        title: "Q3 plan", owner: izzy.profile, role: "use", p5Mark: { kind: "share", by: "Akiva Cohen" },
      });
    });
    expect(await listing(izzy, id)).not.toHaveProperty("p5Mark");
  });

  it("lists a lower re-share at the role Cloudflare leaves the person with", async () => {
    let izzy = await signedIn("Izzy Lazerson");
    let bob = await signedIn("Bob Builder");
    await inWorkspace(izzy, async workspace => {
      workspace.share(bob, "build");
      using owner = await workspace.open(izzy);
      expect(await owner.addCollaborator(bob.profile.id, "use")).toMatchObject({ role: "build" });
      expect(await listing(bob, workspace.id)).toMatchObject({ role: "build", p5Mark: SHARED_BY_IZZY });
    });
  });

  it("leaves a workspace the person already opened exactly as it was, unmarked", async () => {
    let izzy = await signedIn("Izzy Lazerson");
    let akiva = await signedIn("Akiva Cohen");
    let bob = await signedIn("Bob Builder");
    await inWorkspace(izzy, async workspace => {
      workspace.share(akiva, "use");
      using _seen = await workspace.open(akiva);
      await vi.waitFor(async () => expect(await listing(akiva, workspace.id)).toBeDefined());
      let before = await listing(akiva, workspace.id);
      using owner = await workspace.open(izzy);
      await owner.addCollaborator(akiva.profile.id, "build");
      await owner.addCollaborator(bob.profile.id, "build");
      expect(await listing(akiva, workspace.id)).toEqual(before);
      expect(await markOf(bob, workspace.id)).toEqual(SHARED_BY_IZZY);
    });
  });

  it("replaces an unopened mention with a newer share, and a share with a newer mention", async () => {
    let izzy = await signedIn("Izzy Lazerson");
    let bob = await signedIn("Bob Builder");
    let akiva = await signedIn("Akiva Cohen");
    await inWorkspace(izzy, async workspace => {
      workspace.share(akiva, "use");
      await mentioned(workspace, bob, [akiva], izzy);
      expect(await markOf(akiva, workspace.id)).toEqual({ kind: "mention", by: "Bob Builder", chatId: 3 });
      using owner = await workspace.open(izzy);
      await owner.addCollaborator(akiva.profile.id, "build");
      expect(await markOf(akiva, workspace.id)).toEqual(SHARED_BY_IZZY);
      await mentioned(workspace, izzy, [akiva], izzy, 0);
      expect(await markOf(akiva, workspace.id)).toEqual({ kind: "mention", by: "Izzy Lazerson", chatId: 0 });
    });
  });

  it("still shares, and logs it, when the person's mark cannot be written", async () => {
    let izzy = await signedIn("Izzy Lazerson");
    let akiva = await signedIn("Akiva Cohen");
    vi.spyOn(UserDurableObject.prototype, "p5Mark").mockRejectedValue(new Error("User Durable Object reset"));
    let warn = vi.spyOn(console, "warn");
    await inWorkspace(izzy, async workspace => {
      using owner = await workspace.open(izzy);
      expect(await settled(owner.addCollaborator(akiva.profile.id, "use"))).toBe("resolved");
      expect((await owner.listCollaborators()).map(({ profile, role }) => [profile.id, role]))
          .toEqual([[akiva.profile.id, "use"]]);
      expect(await listing(akiva, workspace.id)).toBeUndefined();
    });
    expect(warnedEvents(warn)).toContain("p5.marks.share.failed");
  });
});

describe("an open", { timeout: 90_000 }, () => {
  it("clears the opener's mark, the owner's and a collaborator's", async () => {
    let izzy = await signedIn("Izzy Lazerson");
    let akiva = await signedIn("Akiva Cohen");
    let id = await inWorkspace(izzy, async workspace => {
      using owner = await workspace.open(izzy);
      await owner.addCollaborator(akiva.profile.id, "build");
      await mentioned(workspace, akiva, [izzy], izzy);
    });
    expect(await markOf(akiva, id)).toEqual(SHARED_BY_IZZY);
    expect(await markOf(izzy, id)).toMatchObject({ kind: "mention", by: "Akiva Cohen" });
    for (let person of [akiva, izzy]) {
      expect(await opens(person, id)).toBe(id);
      let row = await listing(person, id);
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty("p5Mark");
    }
  });

  it("still opens, and logs it, when the mark cannot be cleared", async () => {
    let izzy = await signedIn("Izzy Lazerson");
    let akiva = await signedIn("Akiva Cohen");
    let id = await inWorkspace(izzy, async workspace => {
      using owner = await workspace.open(izzy);
      await owner.addCollaborator(akiva.profile.id, "build");
    });
    let clear = vi.spyOn(UserDurableObject.prototype, "p5Mark").mockRejectedValue(new Error("down"));
    let warn = vi.spyOn(console, "warn");
    expect(await settled(opens(akiva, id))).toBe("resolved");
    expect(clear).toHaveBeenCalledWith(id, { clear: true });
    expect(warnedEvents(warn)).toContain("p5.marks.clear.failed");
  });
});

describe("the owner's delete", { timeout: 90_000 }, () => {
  it("takes the workspace off every collaborator's list, and nothing else off any list", async () => {
    let izzy = await signedIn("Izzy Lazerson");
    let akiva = await signedIn("Akiva Cohen");
    let tal = await signedIn("Tal Opened");
    let bob = await signedIn("Bob Builder");
    let uma = await signedIn("Uma Opened");
    let izzyOther = await inWorkspace(izzy, async () => {});
    let akivaOwn = await inWorkspace(akiva, async () => {});
    let alsoShared = await inWorkspace(izzy, async workspace => {
      using owner = await workspace.open(izzy);
      await owner.addCollaborator(akiva.profile.id, "build");
    });
    let id = await inWorkspace(izzy, async workspace => {
      using owner = await workspace.open(izzy);
      for (let person of [akiva, tal]) await owner.addCollaborator(person.profile.id, "build");
      for (let person of [bob, uma]) await owner.addCollaborator(person.profile.id, "use");
      await mentioned(workspace, izzy, [bob], izzy);
    });
    for (let person of [tal, uma]) await opens(person, id);
    expect(await Promise.all([akiva, tal, bob, uma].map(person => rowOf(person, id))))
        .toEqual(["share", "unmarked", "mention", "unmarked"]);

    expect(await deletes(izzy, id)).toBe("resolved");
    for (let person of [izzy, akiva, tal, bob, uma]) expect(await listing(person, id)).toBeUndefined();
    expect(await listing(izzy, izzyOther)).toBeDefined();
    expect(await listing(akiva, akivaOwn)).toBeDefined();
    expect(await markOf(akiva, alsoShared)).toEqual(SHARED_BY_IZZY);
  });

  it("completes when one collaborator's User Durable Object refuses", async () => {
    let izzy = await signedIn("Izzy Lazerson");
    let akiva = await signedIn("Akiva Cohen");
    let bob = await signedIn("Bob Builder");
    let forget = UserDurableObject.prototype.forgetSharedGadget;
    vi.spyOn(UserDurableObject.prototype, "forgetSharedGadget").mockImplementation(async function (
        this: UserDurableObject, gadgetId: string) {
      if ((await this.whoami()).id === akiva.profile.id) throw new Error("the User Durable Object refused");
      return forget.call(this, gadgetId);
    });
    let id = await inWorkspace(izzy, async workspace => {
      using owner = await workspace.open(izzy);
      await owner.addCollaborator(akiva.profile.id, "build");
      await owner.addCollaborator(bob.profile.id, "use");
    });

    expect(await deletes(izzy, id)).toBe("resolved");
    expect(await keysLeft(id)).toBe(0);
    expect(await listing(izzy, id)).toBeUndefined();
    expect(await listing(bob, id)).toBeUndefined();
    expect(await listing(akiva, id)).toBeDefined();
  });

  it("completes, and logs it, when the collaborators cannot be read", async () => {
    let izzy = await signedIn("Izzy Lazerson");
    let akiva = await signedIn("Akiva Cohen");
    let id = await inWorkspace(izzy, async workspace => {
      using owner = await workspace.open(izzy);
      await owner.addCollaborator(akiva.profile.id, "build");
    });
    vi.spyOn(SharingManager.prototype, "listCollaborators").mockImplementation(() => {
      throw new Error("the collaborators cannot be read");
    });
    let warn = vi.spyOn(console, "warn");

    expect(await deletes(izzy, id)).toBe("resolved");
    expect(await keysLeft(id)).toBe(0);
    expect(await listing(izzy, id)).toBeUndefined();
    expect(await listing(akiva, id)).toBeDefined();
    expect(warnedEvents(warn)).toContain("p5.marks.delete.failed");
  });
});

describe("the mark on Cloudflare's listing record", { timeout: 90_000 }, () => {
  it("survives every Cloudflare writer of the record, and goes with the row", async () => {
    let izzy = await signedIn("Izzy Lazerson");
    let akiva = await signedIn("Akiva Cohen");
    let shared = crypto.randomUUID();
    let own = crypto.randomUUID();
    let mention: P5Mark = { kind: "mention", by: "Akiva Cohen", chatId: 3, chatTitle: "Q3 plan" };

    await akiva.user.p5Mark(shared,
        { mark: SHARED_BY_IZZY, listing: { title: "Q3 plan", owner: izzy.profile, role: "use" } });
    await akiva.user.recordSharedGadgetOpen(shared, "Q3 plan", izzy.profile, "build");
    await akiva.user.updateSharedGadgetRole(shared, "use");
    await akiva.user.ensureGadgetRegistered(shared, "Untitled Workspace");
    await akiva.user.updateTitle(shared, "Q4 plan");
    await akiva.user.updatePinned(shared, true);
    await akiva.user.setGadgetLastActive(shared, new Date(), undefined);
    await akiva.user.setWorkspaceNotificationMute(shared, { indefinite: true });
    expect(await listing(akiva, shared)).toMatchObject({
      title: "Q4 plan", owner: izzy.profile, role: "use", pinned: true, notificationMute: { indefinite: true },
      p5Mark: SHARED_BY_IZZY,
    });

    await izzy.user.newGadget(own, "Q3 plan");
    await izzy.user.setGadgetLastActive(own, new Date(), undefined);
    await izzy.user.p5Mark(own, { mark: mention, listing: { title: "Q3 plan", owner: izzy.profile, role: "build" } });
    await izzy.user.ensureGadgetRegistered(own, "Untitled Workspace");
    await izzy.user.updateTitle(own, "Q4 plan");
    await izzy.user.updatePinned(own, true);
    await izzy.user.setGadgetLastActive(own, new Date(), undefined);
    await izzy.user.setWorkspaceNotificationMute(own, { indefinite: true });
    expect(await listing(izzy, own)).toMatchObject({
      title: "Q4 plan", pinned: true, notificationMute: { indefinite: true }, p5Mark: mention,
    });

    await akiva.user.forgetSharedGadget(shared);
    await izzy.user.deleteGadget(own);
    expect(await akiva.user.getGadget(shared)).toBeNull();
    expect(await izzy.user.getGadget(own)).toBeNull();
    await akiva.user.recordSharedGadgetOpen(shared, "Q4 plan", izzy.profile, "use");
    expect(await listing(akiva, shared)).not.toHaveProperty("p5Mark");
  });
});
