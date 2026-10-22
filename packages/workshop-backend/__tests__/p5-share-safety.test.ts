import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollaboratorInfo } from "@gadgets/workshop-shared/api";
import { WORKSPACE_ROLE_CAP } from "@gadgets/workshop-shared/p5-share-safety";
import { SHARE_SAFETY_REFUSALS } from "../src/p5-share-safety.js";
import { UserDurableObject } from "../src/user.js";
import { inWorkspace, neverSignedIn, signedIn, type Connection, type Workspace } from "./p5-workspace.js";

const GMAIL = {
  vendorId: "google", typeUrlPattern: "https://mail.google.com/*", resourceUrl: "https://mail.google.com/mail/u/0/",
};
const CHAT_ACCOUNT = {
  vendorId: "google", typeUrlPattern: "https://chat.google.com/", resourceUrl: "https://chat.google.com/",
};
const CHAT_CONVERSATION = {
  vendorId: "google", typeUrlPattern: "https://chat.google.com/:kind(room|dm)/:spaceId",
  resourceUrl: "https://chat.google.com/room/AAAAteam",
};
const DRIVE_ACCOUNT = {
  vendorId: "google", typeUrlPattern: "https://drive.google.com/drive/my-drive",
  resourceUrl: "https://drive.google.com/drive/my-drive",
};
const DRIVE_FOLDER = {
  vendorId: "google", typeUrlPattern: "https://drive.google.com/drive/folders/:folderId",
  resourceUrl: "https://drive.google.com/drive/folders/1plans",
};
const DRIVE_FILE = {
  vendorId: "google", typeUrlPattern: "https://drive.google.com/file/d/:fileId/view",
  resourceUrl: "https://drive.google.com/file/d/1brief/view",
};
const SHEET = {
  vendorId: "google", typeUrlPattern: "https://docs.google.com/spreadsheets/d/:spreadsheetId/*",
  resourceUrl: "https://docs.google.com/spreadsheets/d/1plan/edit",
};
const SALESFORCE = {
  vendorId: "salesforce", typeUrlPattern: "https://:domain.my.salesforce.com/",
  resourceUrl: "https://pointfive.my.salesforce.com/",
};
const BRAIN: Connection = { vendorId: "brain", ambient: true };

function refusal(call: Promise<unknown>): Promise<string | undefined> {
  return call.then(() => undefined, (error: Error) => error.message);
}

function namesOf(collaborators: CollaboratorInfo[]): Record<string, string | undefined> {
  return Object.fromEntries(collaborators.map(({ profile, role }) => [profile.name, role]));
}

/** Makes the connecting person's account resolve `resourceUrl` to `connection`'s type, as their real account would. */
function resolvesTo(connection: { vendorId: string; typeUrlPattern: string }) {
  return vi.spyOn(UserDurableObject.prototype, "getGatekeeperClassFor")
      .mockResolvedValue({ class: undefined as never, ...connection });
}

/** Stops each connect the rules let through just before Cloudflare creates its gatekeeper, and lists its vendor. */
function connectionsMade(workspace: Workspace): string[] {
  let made: string[] = [];
  workspace.impl.addGatekeeper = async (_class: unknown, spec: { vendorId: string }) => {
    made.push(spec.vendorId);
    return { getId: async () => 0 };
  };
  return made;
}

afterEach(() => vi.restoreAllMocks());

describe("a share the granted role could be locked out of", { timeout: 60_000 }, () => {
  it.each([
    ["Gmail", GMAIL], ["a whole Google Chat account", CHAT_ACCOUNT], ["a whole Google Drive", DRIVE_ACCOUNT],
    ["a Google Drive folder", DRIVE_FOLDER], ["Salesforce", SALESFORCE],
  ])("refuses a workspace holding %s at \"Workspace\", in one sentence, and adds nobody", async (name, connection) => {
    let owner = await signedIn("Izzy Owner");
    let akiva = await signedIn("Akiva Lead");
    await inWorkspace(owner, async workspace => {
      workspace.connect(connection);
      using client = await workspace.open(owner);
      expect(await client.addCollaborator(neverSignedIn(), "build")).toBeNull();
      expect(await refusal(client.addCollaborator(akiva.profile.id, "build"))).toBe(SHARE_SAFETY_REFUSALS.share(name));
      expect(await client.listCollaborators()).toEqual([]);
    });
  });

  it("lets \"Gadget only\" in while Gmail is used only in chats, and refuses it once a gadget reads Salesforce",
      async () => {
    let owner = await signedIn("Izzy Owner");
    let akiva = await signedIn("Akiva Lead");
    let dana = await signedIn("Dana Writer");
    await inWorkspace(owner, async workspace => {
      workspace.connect(GMAIL);
      using client = await workspace.open(owner);
      await expect(client.addCollaborator(akiva.profile.id, "use")).resolves.toMatchObject({ role: "use" });

      workspace.connect(SALESFORCE, { inGadget: true });
      expect(await refusal(client.addCollaborator(dana.profile.id, "use")))
          .toBe(SHARE_SAFETY_REFUSALS.share("Salesforce"));
      expect(namesOf(await client.listCollaborators())).toEqual({ "Akiva Lead": "use" });
    });
  });

  it("passes a Chat conversation, a Drive file, a Sheet and a wrapper connector at \"Workspace\"", async () => {
    let owner = await signedIn("Izzy Owner");
    let akiva = await signedIn("Akiva Lead");
    await inWorkspace(owner, async workspace => {
      for (let connection of [CHAT_CONVERSATION, DRIVE_FILE, SHEET, BRAIN]) workspace.connect(connection);
      using client = await workspace.open(owner);
      await expect(client.addCollaborator(akiva.profile.id, "build")).resolves.toMatchObject({ role: "build" });
    });
  });
});

describe(`the "Workspace" cap of ${WORKSPACE_ROLE_CAP}`, { timeout: 120_000 }, () => {
  it("takes the last place, refuses one past it, re-adds someone already in, leaves \"Gadget only\" out of the " +
      "count, and refuses raising a \"Gadget only\" person past it", async () => {
    expect(WORKSPACE_ROLE_CAP).toBe(20);
    let owner = await signedIn("Izzy Owner");
    let builders = await Promise.all(Array.from({ length: WORKSPACE_ROLE_CAP - 1 }, () => signedIn("Bob Builder")));
    let users = await Promise.all(Array.from({ length: 2 }, () => signedIn("Uma Gadgets")));
    let last = await signedIn("Erin Last");
    let past = await signedIn("Finn Past");
    await inWorkspace(owner, async workspace => {
      for (let builder of builders) workspace.share(builder, "build");
      for (let user of users) workspace.share(user, "use");
      using client = await workspace.open(owner);

      await expect(client.addCollaborator(last.profile.id, "build")).resolves.toMatchObject({ role: "build" });
      expect(await refusal(client.addCollaborator(past.profile.id, "build"))).toBe(SHARE_SAFETY_REFUSALS.cap);
      await expect(client.addCollaborator(builders[0]!.profile.id, "build")).resolves.toMatchObject({ role: "build" });
      await expect(client.addCollaborator(past.profile.id, "use")).resolves.toMatchObject({ role: "use" });
      expect(await refusal(client.addCollaborator(users[0]!.profile.id, "build"))).toBe(SHARE_SAFETY_REFUSALS.cap);

      let roles = (await client.listCollaborators()).map(collaborator => collaborator.role);
      expect(roles.filter(role => role === "build")).toHaveLength(WORKSPACE_ROLE_CAP);
      expect(roles.filter(role => role === "use")).toHaveLength(3);
    });
  });
});

describe("a connection that can lock out everyone else, in a shared workspace", { timeout: 60_000 }, () => {
  it("refuses the owner's Gmail while a \"Gadget only\" collaborator can open, and binds nothing", async () => {
    let owner = await signedIn("Izzy Owner");
    let akiva = await signedIn("Akiva Lead");
    let resolve = resolvesTo(GMAIL);
    await inWorkspace(owner, async workspace => {
      let made = connectionsMade(workspace);
      workspace.share(akiva, "use");
      using client = await workspace.open(owner);
      expect(await refusal(client.newGatekeeper(3, GMAIL.resourceUrl))).toBe(SHARE_SAFETY_REFUSALS.connect("Gmail"));
      expect(resolve).toHaveBeenCalledWith(3, GMAIL.resourceUrl);
      expect(made).toEqual([]);
    });
  });

  it("refuses a collaborator connecting their own Salesforce in the owner's workspace", async () => {
    let owner = await signedIn("Izzy Owner");
    let akiva = await signedIn("Akiva Lead");
    let resolve = resolvesTo(SALESFORCE);
    await inWorkspace(owner, async workspace => {
      let made = connectionsMade(workspace);
      workspace.share(akiva, "build");
      using client = await workspace.open(akiva);
      expect(await refusal(client.newGatekeeper(4, SALESFORCE.resourceUrl)))
          .toBe(SHARE_SAFETY_REFUSALS.connect("Salesforce"));
      expect(resolve).toHaveBeenCalledWith(4, SALESFORCE.resourceUrl);
      expect(made).toEqual([]);
    });
  });

  it("refuses the owner's whole Drive and Drive folder while a \"Workspace\" collaborator can open, and binds nothing",
      async () => {
    let owner = await signedIn("Izzy Owner");
    let akiva = await signedIn("Akiva Lead");
    let resolve = resolvesTo(DRIVE_ACCOUNT);
    await inWorkspace(owner, async workspace => {
      let made = connectionsMade(workspace);
      workspace.share(akiva, "build");
      using client = await workspace.open(owner);
      expect(await refusal(client.newGatekeeper(3, DRIVE_ACCOUNT.resourceUrl))).toBe("You can't connect a whole " +
          "Google Drive in a shared workspace, because it can lock out everyone but the person who connects it; " +
          "connect it in a workspace you haven't shared.");
      resolve.mockResolvedValue({ class: undefined as never, ...DRIVE_FOLDER });
      expect(await refusal(client.newGatekeeper(3, DRIVE_FOLDER.resourceUrl)))
          .toBe(SHARE_SAFETY_REFUSALS.connect("a Google Drive folder"));
      expect(resolve).toHaveBeenLastCalledWith(3, DRIVE_FOLDER.resourceUrl);
      expect(made).toEqual([]);
    });
  });

  it("passes the owner's Gmail while nobody is shared, and a Sheet, a Chat conversation and a Drive file once shared",
      async () => {
    let owner = await signedIn("Izzy Owner");
    let akiva = await signedIn("Akiva Lead");
    let resolve = resolvesTo(GMAIL);
    await inWorkspace(owner, async workspace => {
      let made = connectionsMade(workspace);
      using client = await workspace.open(owner);
      await expect(client.newGatekeeper(3, GMAIL.resourceUrl)).resolves.toBeDefined();

      workspace.share(akiva, "build");
      for (let connection of [SHEET, CHAT_CONVERSATION, DRIVE_FILE]) {
        resolve.mockResolvedValue({ class: undefined as never, ...connection });
        await expect(client.newGatekeeper(3, connection.resourceUrl)).resolves.toBeDefined();
      }
      expect(made).toEqual(["google", "google", "google", "google"]);
    });
  });
});
