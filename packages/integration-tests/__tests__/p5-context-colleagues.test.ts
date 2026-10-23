import { fileURLToPath, URL } from "node:url";
import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import { WORKSPACE_ROLE_CAP } from "@gadgets/workshop-shared/p5-share-safety";
import type { ContextApi, ContextLibrary } from "../../gatekeeper-context/src/context-types.js";
import { startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, nextUsernames, signUp, waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";
import { contextSwitchOn } from "./p5-switch.js";

const CONTEXT_DIR = fileURLToPath(new URL("../../gatekeeper-context/", import.meta.url));
const VENDOR_ID = "context";
const DOCUMENT_PATH = "plan.md";
const DOCUMENT = { description: "Owner-only launch plan", body: "Launch code: private-context." };
const CAP_REFUSED = `This binding already answers for ${WORKSPACE_ROLE_CAP} collaborators, the most it can ` +
    "verify on every read. Remove one before adding another.";
let harness: Harness;

type ContextUser = Disposable & {
  username: string;
  api: RpcStub<AuthenticatedApi>;
  account: ConnectedAccount;
  context: RpcStub<ContextApi>;
};
const network = new NetworkInterceptor({ handlers: [] });

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [{ binding: "CONTEXT", dir: CONTEXT_DIR, patch: contextSwitchOn }],
  });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

async function newAccount(prefix: string): Promise<ContextUser> {
  using stack = new DisposableStack();
  const [username] = nextUsernames(prefix);
  if (username === undefined) throw new Error("Missing test username");
  const api = stack.use(await signUp(stack.use(connect(harness.url)), username));
  await api.provisionAmbientAccount(VENDOR_ID);
  const account = await waitFor("the Context account to be provisioned", async () =>
    (await listConnectedAccounts(api)).find(entry => entry.vendorId === VENDOR_ID) ?? null);
  const frame = await api.getGatekeeperApp(VENDOR_ID);
  if (frame === null) throw new Error("The Context management app is unavailable");
  const context = stack.use(frame.ui as unknown as RpcStub<ContextApi>);
  return Object.assign(stack.move(), { username, api, account, context });
}

async function privateWorkspace(owner: ContextUser) {
  using stack = new DisposableStack();
  const collection = await owner.context.createContextCollection(
    `${owner.username} private collection`, "Private discovery metadata", "private");
  await owner.context.putContextDocument(collection.id, DOCUMENT_PATH, DOCUMENT);
  const workspace = stack.use(await owner.api.newGadget());
  const { id: workspaceId } = await workspace.getMetadata();
  const requirement = await waitFor("the workspace's ambient Context binding", async () =>
    (await workspace.listObserverRequirements("build"))
      .find(entry => entry.vendorId === VENDOR_ID) ?? null);
  const binding = stack.use(await workspace.getGatekeeperById(requirement.gatekeeperId));
  const session = stack.use(await binding.openSession() as RpcStub<ContextLibrary>);
  const docId = `${collection.id}/${DOCUMENT_PATH}`;
  return Object.assign(stack.move(), {
    collection, workspace, workspaceId, session, docId, gatekeeperId: requirement.gatekeeperId,
  });
}

/** The role `user` opens the workspace as, or the refusal they meet. */
async function roleOnOpen(user: ContextUser, workspaceId: string): Promise<string> {
  try {
    using opened = await user.api.openGadget(workspaceId);
    return (await opened.getMetadata()).role ?? "build";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

it.concurrent.each(["list", "read"] as const)(
  "a private collection's %s never prevents a \"Workspace\" collaborator without collection access opening",
  async reveal => {
    using owner = await newAccount("p5contentowner");
    using observer = await newAccount("p5contentobserver");
    using state = await privateWorkspace(owner);
    const { collection, workspace, workspaceId, session, docId } = state;

    expect(await observer.context.getContextCollectionMetadata(collection.id)).toBeNull();
    if (reveal === "list") {
      expect(await session.list({ collectionId: collection.id })).toMatchObject({
        collectionId: collection.id,
        entries: [{ type: "document", docId, path: DOCUMENT_PATH, description: DOCUMENT.description }],
      });
    } else {
      expect(await session.read(docId)).toMatchObject({ docId, content: DOCUMENT.body });
    }

    await workspace.addCollaborator(observer.username, "build");
    expect(await roleOnOpen(observer, workspaceId)).toBe("build");
  },
);

it.concurrent("a collaborator who joined first is not blocked by the owner's later private read", async () => {
  using owner = await newAccount("p5joinedowner");
  using observer = await newAccount("p5joinedobserver");
  using state = await privateWorkspace(owner);
  const { workspace, workspaceId, session, docId } = state;

  await workspace.addCollaborator(observer.username, "build");
  expect(await roleOnOpen(observer, workspaceId)).toBe("build");

  expect(await session.read(docId)).toMatchObject({ docId, content: DOCUMENT.body });
  expect(await roleOnOpen(observer, workspaceId)).toBe("build");
});

it.concurrent("a \"Workspace\" collaborator's own session in the workspace reads the owner's private note",
    async () => {
  using owner = await newAccount("p5readerowner");
  using observer = await newAccount("p5readerobserver");
  using state = await privateWorkspace(owner);
  const { workspace, workspaceId, docId, gatekeeperId } = state;

  await workspace.addCollaborator(observer.username, "build");
  expect(await roleOnOpen(observer, workspaceId)).toBe("build");
  using opened = await observer.api.openGadget(workspaceId);
  using binding = await opened.getGatekeeperById(gatekeeperId);
  using notes = await binding.openSession() as RpcStub<ContextLibrary>;
  expect(await notes.read(docId)).toMatchObject({ docId, content: DOCUMENT.body });
});

it(`admits ${WORKSPACE_ROLE_CAP} "Workspace" collaborators one by one after the owner's private read, and ` +
    "refuses a \"Gadget only\" user of a gadget bound to Skills one past them at open", async () => {
  using owner = await newAccount("p5capowner");
  using state = await privateWorkspace(owner);
  const { workspace, workspaceId, session, docId, gatekeeperId } = state;
  using gadget = await workspace.createGadget("Skills notes", undefined, "SKILLS_NOTES");
  await gadget.bind("SKILLS", gatekeeperId);
  expect((await workspace.listObserverRequirements("use")).map(need => need.gatekeeperId))
    .toEqual([gatekeeperId]);
  expect(await session.read(docId)).toMatchObject({ docId, content: DOCUMENT.body });

  using people = new DisposableStack();
  const [onePast, ...colleagues] = await Promise.all(
    ["p5caponepast", ...Array.from({ length: WORKSPACE_ROLE_CAP }, (_, n) => `p5cap${n}x`)]
      .map(async prefix => people.use(await newAccount(prefix))));
  if (!onePast) throw new Error("Missing the user one past the cap");
  for (const colleague of colleagues) {
    expect(await workspace.addCollaborator(colleague.username, "build")).toMatchObject({ role: "build" });
    expect(await roleOnOpen(colleague, workspaceId)).toBe("build");
  }
  expect(await session.read(docId)).toMatchObject({ docId, content: DOCUMENT.body });

  expect(await workspace.addCollaborator(onePast.username, "use")).toMatchObject({ role: "use" });
  expect(await roleOnOpen(onePast, workspaceId)).toContain(CAP_REFUSED);
});
