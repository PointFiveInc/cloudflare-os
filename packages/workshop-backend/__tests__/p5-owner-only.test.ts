import { describe, expect, it } from "vitest";
import {
  OPEN_GADGET_ERROR_CODES, createOpenGadgetError, getOpenGadgetErrorCode, type CollaboratorInfo,
} from "@gadgets/workshop-shared/api";
import { asThemselves, inWorkspace, signedIn, type Person, type Workspace } from "./p5-workspace.js";

const LINKS_OFF = createOpenGadgetError(OPEN_GADGET_ERROR_CODES.shareLinksDisabled).message;
const NOT_OWNER_ADDS = "Only the workspace owner can add people to a workspace that contains sensitive data.";
const DENIED = OPEN_GADGET_ERROR_CODES.workspaceAccessDenied;
const LINK_REFUSED = OPEN_GADGET_ERROR_CODES.shareLinksDisabled;
const RESTRICTED_READ = {
  title: "Read an account", description: "The gadget read an account.", containsRestrictedData: true,
  ownerInvitesOnly: true,
};

const NAMES = {
  olive: "Olive Owner",
  bob: "Bob Lead",
  carol: "Carol Added",
  dave: "Dave Linked",
  erin: "Erin Linked",
  frank: "Frank Both",
  gina: "Gina Removed",
  hank: "Hank Revoked",
  nora: "Nora New",
} as const;
type Cast = Record<keyof typeof NAMES, Person>;

async function signedInCast(): Promise<Cast> {
  let people = await Promise.all(
      Object.entries(NAMES).map(async ([key, name]) => [key, await signedIn(name)] as const));
  return Object.fromEntries(people) as Cast;
}

function refusal(call: Promise<unknown>): Promise<string | undefined> {
  return call.then(() => undefined, (error: Error) => error.message);
}

function rolesOf(collaborators: CollaboratorInfo[]): Record<string, string | undefined> {
  return Object.fromEntries(collaborators.map(({ profile, role }) => [profile.name, role]));
}

/** The role `person` opens the workspace with, through its real `open()`, or the code it is refused with. */
async function openedAs(workspace: Workspace, person: Person, shareKey?: string): Promise<string | undefined> {
  try {
    using client = await workspace.open(person, shareKey);
    return (await client.getMetadata()).role;
  } catch (error) {
    return getOpenGadgetErrorCode(error) ?? (error as Error).message;
  }
}

async function openings(workspace: Workspace, people: Person[]): Promise<Record<string, string | undefined>> {
  let roles: Record<string, string | undefined> = {};
  for (let person of people) roles[person.profile.name] = await openedAs(workspace, person);
  return roles;
}

/**
 * Before go-live, with Cloudflare's rules: Bob is the owner's lead; Dave joins by the owner's link; Bob adds Carol and
 * shares a "use" link Erin joins by; Frank is the owner's "use" and Bob's "build". Gina was removed and Hank's link
 * was revoked, so both are already out.
 */
async function sharedTheCloudflareWay(workspace: Workspace, cast: Cast) {
  let { olive, bob, carol, dave, erin, frank, gina, hank } = cast;
  using owner = await workspace.open(olive);
  await owner.addCollaborator(bob.profile.id, "build");
  let ownerLink = await owner.createShareLink("build", "team");
  expect(await openedAs(workspace, dave, ownerLink.key)).toBe("build");
  using lead = await workspace.open(bob);
  await lead.addCollaborator(carol.profile.id, "build");
  let leadLink = await lead.createShareLink("use");
  expect(await openedAs(workspace, erin, leadLink.key)).toBe("use");
  await owner.addCollaborator(frank.profile.id, "use");
  await lead.addCollaborator(frank.profile.id, "build");
  await owner.addCollaborator(gina.profile.id, "use");
  await owner.removeCollaborator(gina.profile.id, []);
  let revokedLink = await owner.createShareLink("build");
  expect(await openedAs(workspace, hank, revokedLink.key)).toBe("build");
  await owner.revokeShareLink(revokedLink.linkId, []);

  let roles = rolesOf(await owner.listCollaborators());
  expect(roles).toEqual({
    "Bob Lead": "build", "Carol Added": "build", "Dave Linked": "build", "Erin Linked": "use", "Frank Both": "build",
  });
  expect(workspace.impl.storage.ownerInvitesOnly.get()).toBe(false);
  return { ownerLink, leadLink, revokedLink, roles };
}

describe("owner-only sharing with P5_COLLABORATION on", { timeout: 60_000 }, () => {
  it("keeps everyone who has access on go-live day at their exact role", async () => {
    let cast = await signedInCast();
    await inWorkspace(cast.olive, async workspace => {
      let { roles } = await sharedTheCloudflareWay(workspace, cast);

      workspace.switchOn();
      using owner = await workspace.open(cast.olive);
      expect(rolesOf(await owner.listCollaborators())).toEqual(roles);
      expect(workspace.impl.storage.ownerInvitesOnly.get()).toBe(true);
      let { bob, carol, dave, erin, frank } = cast;
      expect(await openings(workspace, [bob, carol, dave, erin, frank])).toEqual(roles);
    });
  });

  it("keeps out the people already out: someone removed, and someone whose link was revoked", async () => {
    let cast = await signedInCast();
    await inWorkspace(cast.olive, async workspace => {
      let { revokedLink, roles } = await sharedTheCloudflareWay(workspace, cast);

      workspace.switchOn();
      expect(await openings(workspace, [cast.gina, cast.hank]))
          .toEqual({ "Gina Removed": DENIED, "Hank Revoked": DENIED });
      expect(await openedAs(workspace, cast.hank, revokedLink.key)).toBe(DENIED);
      expect(workspace.impl.storage.ownerInvitesOnly.get()).toBe(true);
      using owner = await workspace.open(cast.olive);
      expect(rolesOf(await owner.listCollaborators())).toEqual(roles);
    });
  });

  it("refuses every new way in, while an old joiner's key still opens and the owner still adds by name",
      async () => {
    let cast = await signedInCast();
    let { olive, bob, dave, nora } = cast;
    await inWorkspace(olive, async workspace => {
      let { ownerLink, leadLink, roles } = await sharedTheCloudflareWay(workspace, cast);

      workspace.switchOn();
      using owner = await workspace.open(olive);
      expect(await refusal(owner.createShareLink("use"))).toBe(LINKS_OFF);
      expect(await refusal(owner.newShareLinkKey(ownerLink.linkId))).toBe(LINKS_OFF);
      expect(await openedAs(workspace, nora, ownerLink.key)).toBe(LINK_REFUSED);
      expect(await openedAs(workspace, nora, leadLink.key)).toBe(LINK_REFUSED);
      using lead = await workspace.open(bob);
      expect(await refusal(lead.addCollaborator(nora.profile.id, "use"))).toBe(NOT_OWNER_ADDS);
      expect(await refusal(lead.createShareLink("use"))).toBe(LINKS_OFF);
      expect(rolesOf(await owner.listCollaborators())).toEqual(roles);

      expect(await openedAs(workspace, dave, ownerLink.key)).toBe("build");
      await owner.addCollaborator(nora.profile.id, "use");
      expect(await openedAs(workspace, nora)).toBe("use");
    });
  });

  it("lets a first sensitive read after go-live revoke nobody and restart nothing", async () => {
    let cast = await signedInCast();
    await inWorkspace(cast.olive, async workspace => {
      let { roles } = await sharedTheCloudflareWay(workspace, cast);
      let restartsBefore = workspace.restarts.length;

      workspace.switchOn();
      workspace.impl.storage.gatekeepers.put({ id: 1, resourceTitle: "CRM", class: {} });
      await workspace.impl.authorizeObservation(1, RESTRICTED_READ, { from: "user" });
      expect(workspace.restarts.slice(restartsBefore)).toEqual([]);
      expect(workspace.impl.storage.ownerInvitesOnly.get()).toBe(true);
      using owner = await workspace.open(cast.olive);
      expect(rolesOf(await owner.listCollaborators())).toEqual(roles);
    });
  });

  it("makes a workspace created after go-live owner-only from its first share", async () => {
    let [olive, bob, carol] = await Promise.all([NAMES.olive, NAMES.bob, NAMES.carol].map(name => signedIn(name)));
    await inWorkspace(olive!, async workspace => {
      workspace.switchOn();
      using owner = await workspace.open(olive!);
      expect(await refusal(owner.createShareLink("build"))).toBe(LINKS_OFF);
      await owner.addCollaborator(bob!.profile.id, "build");
      using lead = await workspace.open(bob!);
      expect((await lead.getMetadata()).ownerInvitesOnly).toBe(true);
      expect(await refusal(lead.addCollaborator(carol!.profile.id, "use"))).toBe(NOT_OWNER_ADDS);
      expect(rolesOf(await owner.listCollaborators())).toEqual({ "Bob Lead": "build" });
    });
  });

  it("shows owner-only on the owner's first metadata read, as the sidebar and Workspaces list take it", async () => {
    let [olive, bob] = await Promise.all([NAMES.olive, NAMES.bob].map(name => signedIn(name)));
    let id = await inWorkspace(olive!, async workspace => {
      using owner = await workspace.open(olive!);
      await owner.addCollaborator(bob!.profile.id, "build");
      workspace.switchOn();
    });
    let first = await asThemselves(olive!, async api => (await api.openGadget(id).getMetadata()).ownerInvitesOnly);
    expect(first).toBe(true);
  });

  it("keeps the people a removed lead added before go-live", async () => {
    let cast = await signedInCast();
    let { olive, bob, carol, erin, frank } = cast;
    await inWorkspace(olive, async workspace => {
      await sharedTheCloudflareWay(workspace, cast);

      workspace.switchOn();
      using owner = await workspace.open(olive);
      expect((await owner.previewRemoveCollaborator(bob.profile.id)).map(({ profile }) => profile.name))
          .toEqual(["Bob Lead"]);
      await owner.removeCollaborator(bob.profile.id, []);
      expect(await openings(workspace, [bob, carol, erin, frank])).toEqual({
        "Bob Lead": DENIED, "Carol Added": "build", "Erin Linked": "use", "Frank Both": "build",
      });
    });
  });
});

describe("with P5_COLLABORATION unset", { timeout: 60_000 }, () => {
  it("keeps Cloudflare's behaviour: links and a lead's adds work, and the read that sets the flag revokes",
      async () => {
    let cast = await signedInCast();
    await inWorkspace(cast.olive, async workspace => {
      await sharedTheCloudflareWay(workspace, cast);
      let restartsBefore = workspace.restarts.length;

      using owner = await workspace.open(cast.olive);
      expect((await owner.getMetadata()).ownerInvitesOnly).toBe(false);
      let ownerGrants = (await owner.listCollaborators())
          .filter(({ addedBy }) => addedBy.some(edge => edge.type === "user" && edge.sharer === cast.olive.profile.id))
          .map(({ profile }) => profile.name);
      expect(ownerGrants.toSorted()).toEqual(["Bob Lead", "Frank Both"]);

      workspace.impl.storage.gatekeepers.put({ id: 1, resourceTitle: "CRM", class: {} });
      await workspace.impl.authorizeObservation(1, RESTRICTED_READ, { from: "user" });
      expect(workspace.restarts.slice(restartsBefore))
          .toEqual(["Gadget restarted to revoke access for people the owner did not add directly."]);
      expect(rolesOf(await owner.listCollaborators())).toEqual({ "Bob Lead": "build", "Frank Both": "use" });
    });
  });
});
