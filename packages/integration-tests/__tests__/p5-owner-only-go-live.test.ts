import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createOpenGadgetError, getOpenGadgetErrorCode, OPEN_GADGET_ERROR_CODES,
  type AuthenticatedApi, type CollaboratorInfo,
} from "@gadgets/workshop-shared/api";
import { type Harness, startHarness } from "../src/harness.js";
import { mockChatCompletion } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, nextUsernames, signUp } from "../src/rpc-client.js";
import { workshopSwitchOn } from "./p5-switch.js";

let harness: Harness | undefined;
const network = new NetworkInterceptor({ handlers: [mockChatCompletion("Test chat")] });

beforeAll(async () => {
  network.install();
  harness = await startHarness({ gatekeepers: [] });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

function requireHarness(): Harness {
  if (harness === undefined) throw new Error("Workshop harness did not start");
  return harness;
}

const LINKS_OFF = createOpenGadgetError(OPEN_GADGET_ERROR_CODES.shareLinksDisabled).message;
const OWNER_ADDS_ONLY = "Only the workspace owner can add people";

const rolesOf = (collaborators: CollaboratorInfo[]) => Object.fromEntries(
    collaborators.map(({ profile, role = "build" }) => [profile.id, role]));

async function signedIn<T>(
    username: string, body: (api: RpcStub<AuthenticatedApi>) => Promise<T>): Promise<T> {
  using publicApi = connect(requireHarness().url);
  using api = await logIn(publicApi, username);
  return await body(api);
}

/** The role `username` opens the workspace with, or the code it is refused with. */
function openAs(username: string, workspaceId: string, shareKey?: string): Promise<string> {
  return signedIn(username, async api => {
    try {
      using workspace = await api.openGadget(workspaceId, shareKey);
      return (await workspace.getMetadata()).role ?? "build";
    } catch (error) {
      return getOpenGadgetErrorCode(error) ?? String(error);
    }
  });
}

async function refusal(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "allowed";
}

it("the go-live deploy keeps everyone's access and lets nobody new in", async () => {
  const [owner, lead, joiner, added, newcomer] =
      nextUsernames("golive", "golivelead", "golivejoiner", "goliveadded", "golivenew");
  if (!owner || !lead || !joiner || !added || !newcomer) throw new Error("Missing test username");
  for (const username of [owner, lead, joiner, added, newcomer]) {
    using publicApi = connect(requireHarness().url);
    using _api = await signUp(publicApi, username);
  }

  const { workspaceId, linkKey, before } = await signedIn(owner, async api => {
    using workspace = await api.newGadget();
    const { id } = await workspace.getMetadata();
    await workspace.newChat("Make this workspace visible without an agent", null);
    await workspace.addCollaborator(lead, "build");
    const link = await workspace.createShareLink("use", "team");
    await signedIn(joiner, async joinerApi => {
      using _joined = await joinerApi.openGadget(id, link.key);
    });
    await signedIn(lead, async leadApi => {
      using leadWorkspace = await leadApi.openGadget(id);
      await leadWorkspace.addCollaborator(added, "build");
    });
    expect((await workspace.getMetadata()).ownerInvitesOnly).toBe(false);
    return {
      workspaceId: id, linkKey: link.key, before: rolesOf(await workspace.listCollaborators()),
    };
  });
  expect(before).toEqual({ [lead]: "build", [joiner]: "use", [added]: "build" });

  await requireHarness().redeployWorkshop(workshopSwitchOn());

  expect({
    lead: await openAs(lead, workspaceId),
    joiner: await openAs(joiner, workspaceId),
    joinerOnTheirLink: await openAs(joiner, workspaceId, linkKey),
    added: await openAs(added, workspaceId),
  }).toEqual({ lead: "build", joiner: "use", joinerOnTheirLink: "use", added: "build" });

  const newcomerOnTheLink = await openAs(newcomer, workspaceId, linkKey);
  const leadAdds = await signedIn(lead, async api => {
    using workspace = await api.openGadget(workspaceId);
    return refusal(() => workspace.addCollaborator(newcomer, "use"));
  });
  await signedIn(owner, async api => {
    using workspace = await api.openGadget(workspaceId);
    expect({
      newcomerOnTheLink,
      newLink: await refusal(() => workspace.createShareLink("use")),
      leadAdds,
    }).toEqual({
      newcomerOnTheLink: OPEN_GADGET_ERROR_CODES.shareLinksDisabled,
      newLink: LINKS_OFF,
      leadAdds: expect.stringContaining(OWNER_ADDS_ONLY),
    });
    expect((await workspace.getMetadata()).ownerInvitesOnly).toBe(true);
    expect(rolesOf(await workspace.listCollaborators())).toEqual(before);

    expect((await workspace.addCollaborator(newcomer, "use"))?.role).toBe("use");
  });
  expect(await openAs(newcomer, workspaceId)).toBe("use");
});
