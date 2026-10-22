import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type {
  AiChatMessage, AuthenticatedApi, GadgetMetadataWithTimestamps, Overseer,
} from "@gadgets/workshop-shared/api";
import type { P5Marked } from "@gadgets/workshop-shared/p5-marks";
import { WORKSPACE_ROLE_CAP } from "@gadgets/workshop-shared/p5-share-safety";
import { loadAllChatHistory } from "../src/agent-session.js";
import { startHarness, TEST_GATEKEEPER_DIR, type GatekeeperSpec, type Harness } from "../src/harness.js";
import {
  SCRIPTED_MODEL_ID, scriptedModelRouter, type ChatCompletionStep, type RoutedScriptedModel,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, nextUsernames, signUp, waitFor, waitForIdleChat,
} from "../src/rpc-client.js";
import { FakeGoogle, GOOGLE_BASE_URL } from "./google-fake.js";

const SALESFORCE_VENDOR_ID = "salesforce";

/** The fixture gatekeeper bound as vendor "salesforce", the one thing the Workshop knows Salesforce by. */
const SALESFORCE: GatekeeperSpec = {
  binding: SALESFORCE_VENDOR_ID.toUpperCase(),
  dir: TEST_GATEKEEPER_DIR,
  patch: config => { config.name = "gatekeeper-salesforce"; },
};

/** This tree's gatekeeper-google, from its prebuilt tree, with the fake's OAuth client. */
const GOOGLE: GatekeeperSpec = {
  binding: "GOOGLE",
  dir: resolve(dirname(fileURLToPath(import.meta.url)), "../../gatekeeper-google"),
  patch: config => {
    delete config.build;
    config.vars = {
      ...config.vars, BASE_URL: GOOGLE_BASE_URL, CLIENT_ID: "test-client", CLIENT_SECRET: "test-secret",
    };
  },
};

let harness: Harness;
const google = new FakeGoogle();
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler, google.handler] });

beforeAll(async () => {
  network.install();
  harness = await startHarness({ gatekeepers: [SALESFORCE, GOOGLE] });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

const PROMPT = "Build a habit tracker.";
const OWNER = "Izzy Owner";
const COLLEAGUE = "Dana Colleague";
const NEWCOMER = "Akiva Newcomer";
const AGENT_RUNNING = "Agent is running, wait for it to finish.";
const shareRefused = (name: string) => `This workspace uses ${name}, which can lock out everyone but the person ` +
    "who connected it; share a workspace without it instead.";
const CAP_REFUSED = `This workspace already has ${WORKSPACE_ROLE_CAP} people with "Workspace" access, the most ` +
    "it allows; remove one of them in the Share window to make room.";

const history = (ws: RpcStub<Overseer>, chatId: number) =>
  loadAllChatHistory(before => ws.getChatHistory(chatId, before));
const texts = (messages: AiChatMessage[]) =>
  messages.flatMap(message => message.type === "message" ? [message.message] : []);

/** Long enough for a turn started by mistake to ask the model. */
const settle = () => new Promise(done => setTimeout(done, 500));

async function listingOf(api: RpcStub<AuthenticatedApi>, workspaceId: string)
    : Promise<(GadgetMetadataWithTimestamps & P5Marked) | undefined> {
  const rows: GadgetMetadataWithTimestamps[] = await api.listGadgets();
  return rows.find(row => row.id === workspaceId);
}

async function signUpEach(usernames: string[]): Promise<void> {
  using publicApi = connect(harness.url);
  await Promise.all(usernames.map(async username => {
    using _api = await signUp(publicApi, username);
  }));
}

/**
 * Izzy's workspace, shared at "Workspace" with Dana, and a chat whose agent runs `script`, once it
 * has asked the model for its first step.
 */
async function sharedChat(prefix: string, script: readonly ChatCompletionStep[],
    test: (ws: RpcStub<Overseer>, chatId: number, model: RoutedScriptedModel) => Promise<void>) {
  const model = models.script(script);
  const [owner, colleague] = nextUsernames(`${prefix}owner`, `${prefix}colleague`);
  if (!owner || !colleague) throw new Error("Missing test username");
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, owner, OWNER);
  using _colleague = await signUp(publicApi, colleague, COLLEAGUE);
  await api.addModel(model.userModel.profile, model.userModel.config);
  using ws = await api.newGadget();
  if (!await ws.addCollaborator(colleague, "build")) throw new Error(`Failed to share with ${colleague}`);
  const chatId = await ws.newChat(PROMPT, SCRIPTED_MODEL_ID);
  await waitFor("the first model request", async () => model.requests.length === 1 || null);
  await test(ws, chatId, model);
}

/** Izzy's own workspace, shared with nobody yet. */
async function ownerWorkspace(prefix: string,
    test: (api: RpcStub<AuthenticatedApi>, ws: RpcStub<Overseer>, username: string) => Promise<void>) {
  const [owner] = nextUsernames(prefix);
  if (!owner) throw new Error("Missing test username");
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, owner, OWNER);
  using ws = await api.newGadget();
  await test(api, ws, owner);
}

/**
 * The grant the owner's "@" of someone new asks for before it sends, refused: what it is refused
 * with, once it is checked that nobody was let in.
 */
async function refusedGrant(ws: RpcStub<Overseer>): Promise<string> {
  const [newcomer] = nextUsernames("atrefused");
  if (!newcomer) throw new Error("Missing test username");
  using publicApi = connect(harness.url);
  using newcomerApi = await signUp(publicApi, newcomer, NEWCOMER);
  const { id } = await ws.getMetadata();
  const before = await ws.listCollaborators();
  const outcome = await ws.addCollaborator(newcomer, "build")
      .then(() => "granted", (error: Error) => error.message);
  expect({ collaborators: await ws.listCollaborators(), listing: await listingOf(newcomerApi, id) })
      .toEqual({ collaborators: before, listing: undefined });
  return outcome;
}

it.concurrent("an \"@\" sent while the agent works is refused with Cloudflare's sentence, never queued for " +
    "it, and asks the model nothing", async () => {
  const answer = Promise.withResolvers<void>();
  await sharedChat("atmidturn", [
    { text: "Building the tracker.", after: answer.promise },
    { text: "Dana can look at it now." },
  ], async (ws, chatId, model) => {
    const outcome = await ws.sendChatMessage(chatId, `@${COLLEAGUE} can you look at this?`, SCRIPTED_MODEL_ID)
        .then(() => "sent", (error: Error) => error.message);
    const queued = (await ws.listChats()).find(chat => chat.id === chatId)?.queuedSteers?.map(steer => steer.text);
    answer.resolve();
    await waitForIdleChat(ws, chatId);
    await settle();

    expect({ outcome, queued, requests: model.requests.length })
        .toEqual({ outcome: AGENT_RUNNING, queued: undefined, requests: 1 });
    expect(texts(await history(ws, chatId))).toEqual([PROMPT, "Building the tracker."]);
  });
});

it.concurrent("an \"@\" sent with the agent picked starts no turn, in a chat the agent has answered or as a " +
    "new chat's first message", async () => {
  await sharedChat("atidle", [{ text: "Building the tracker." }], async (ws, chatId, model) => {
    await waitForIdleChat(ws, chatId);
    await ws.sendChatMessage(chatId, `@${COLLEAGUE} the tracker is ready`, SCRIPTED_MODEL_ID);
    const newChatId = await ws.newChat(`@${COLLEAGUE} can you take the next one?`, SCRIPTED_MODEL_ID);
    await settle();

    const running = (await ws.listChats()).filter(chat => chat.activeAgent !== undefined).map(chat => chat.id);
    expect({ running, requests: model.requests.length }).toEqual({ running: [], requests: 1 });
    expect(texts(await history(ws, chatId)))
        .toEqual([PROMPT, "Building the tracker.", `@${COLLEAGUE} the tracker is ready`]);
    expect(texts(await history(ws, newChatId))).toEqual([`@${COLLEAGUE} can you take the next one?`]);
  });
});

it.concurrent("the owner's \"@\" of someone new in a workspace holding Salesforce is refused in one sentence " +
    "and lets nobody in", async () => {
  await ownerWorkspace("atsalesforce", async (api, ws) => {
    await api.provisionAmbientAccount(SALESFORCE_VENDOR_ID);
    const account = await waitFor("the Salesforce account", async () =>
      (await listConnectedAccounts(api)).find(entry => entry.vendorId === SALESFORCE_VENDOR_ID) ?? null);
    using connection = await ws.newGatekeeper(account.id, "https://gadgets-test.example/things/accounts");
    if (!connection) throw new Error("Failed to connect Salesforce");

    expect(await refusedGrant(ws)).toBe(shareRefused("Salesforce"));
  });
});

it.concurrent("the owner's \"@\" of someone new in a workspace holding Gmail is refused in one sentence and " +
    "lets nobody in", async () => {
  await ownerWorkspace("atgmail", async (api, ws, username) => {
    const account = await google.connect(harness, api, username);
    using gmail = await ws.newGatekeeper(account.id, "https://mail.google.com/mail/");
    if (!gmail) throw new Error("Failed to connect Gmail");

    expect(await refusedGrant(ws)).toBe(shareRefused("Gmail"));
  });
});

it.concurrent(`the owner's "@" of someone new once ${WORKSPACE_ROLE_CAP} people have "Workspace" is refused ` +
    "in one sentence and lets nobody in", async () => {
  await ownerWorkspace("atcap", async (_api, ws) => {
    const builders = nextUsernames(...Array.from({ length: WORKSPACE_ROLE_CAP }, (_, index) => `atcap${index}x`));
    await signUpEach(builders);
    for (const builder of builders) {
      if (!await ws.addCollaborator(builder, "build")) throw new Error(`Failed to share with ${builder}`);
    }

    expect(await refusedGrant(ws)).toBe(CAP_REFUSED);
  });
});

it.concurrent("the owner's \"@\" of someone new, granted and then sent as the composer sends it, marks the " +
    "workspace for them with no turn, and the mark opens that chat", async () => {
  const model = models.script([]);
  const [owner, newcomer] = nextUsernames("atmarkowner", "atmarknew");
  if (!owner || !newcomer) throw new Error("Missing test username");
  using publicApi = connect(harness.url);
  using ownerApi = await signUp(publicApi, owner, OWNER);
  using newcomerApi = await signUp(publicApi, newcomer, NEWCOMER);
  await ownerApi.addModel(model.userModel.profile, model.userModel.config);
  using ws = await ownerApi.newGadget();
  const { id } = await ws.getMetadata();
  const chatId = await ws.newChat("Plan the habit tracker.", null);
  await ws.setChatTitle(chatId, "Habit tracker");

  expect(await ws.addCollaborator(newcomer, "build")).toMatchObject({ role: "build" });
  await ws.sendChatMessage(chatId, `@${NEWCOMER} can you take the design?`, SCRIPTED_MODEL_ID);
  const mark = (await listingOf(newcomerApi, id))?.p5Mark;
  expect(mark).toEqual({ kind: "mention", by: OWNER, chatId, chatTitle: "Habit tracker" });
  if (mark?.kind !== "mention") throw new Error("No mention mark");

  using opened = await newcomerApi.openGadget(id);
  expect(texts(await history(opened, mark.chatId)).at(-1)).toBe(`@${NEWCOMER} can you take the design?`);
  expect((await listingOf(newcomerApi, id))?.p5Mark).toBeUndefined();
  await settle();
  expect(model.requests).toEqual([]);
});
