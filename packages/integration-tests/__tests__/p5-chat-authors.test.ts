import type { RpcStub } from "capnweb";
import { z } from "zod";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AiChatAuthorInfo, Overseer } from "@gadgets/workshop-shared/api";
import { loadAllChatHistory } from "../src/agent-session.js";
import { startTestGatekeeperHarness, type Harness } from "../src/harness.js";
import {
  SCRIPTED_MODEL_ID, scriptedModelRouter, type ChatCompletionStep, type RoutedScriptedModel,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp, waitFor, waitForIdleChat } from "../src/rpc-client.js";

let harness: Harness;
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness();
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

const OWNER = "Alice Owner";
const COLLABORATOR = "Bob Builder";

const REQUEST = z.looseObject({
  messages: z.array(z.looseObject({ role: z.string(), content: z.unknown() })),
});

const userTexts = (request: unknown) => REQUEST.parse(request).messages
    .filter(message => message.role === "user")
    .map(message => z.string().parse(message.content));

const from = (author: AiChatAuthorInfo, text: string) =>
  `<from>${author.name} (${author.id})</from>\n${text}`;

function expectStartsWith(request: unknown, previous: unknown) {
  const { messages, ...fields } = REQUEST.parse(request);
  const { messages: previousMessages, ...previousFields } = REQUEST.parse(previous);
  expect(JSON.stringify(fields)).toBe(JSON.stringify(previousFields));
  expect(messages.slice(0, previousMessages.length).map(message => JSON.stringify(message)))
      .toEqual(previousMessages.map(message => JSON.stringify(message)));
}

type People = {
  ws: RpcStub<Overseer>;
  shared: RpcStub<Overseer>;
  bob: AiChatAuthorInfo;
  model: RoutedScriptedModel;
};

/**
 * Alice's workspace, with her model, shared at "Workspace" with Bob, who has no model of his own.
 */
async function sharedWorkspace(prefix: string, script: readonly ChatCompletionStep[],
    test: (people: People) => Promise<void>) {
  const model = models.script(script);
  const [owner, collaborator] = nextUsernames(`${prefix}owner`, `${prefix}collaborator`);
  if (!owner || !collaborator) throw new Error("Missing test username");
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, owner, OWNER);
  using bobApi = await signUp(publicApi, collaborator, COLLABORATOR);
  await api.addModel(model.userModel.profile, model.userModel.config);
  using ws = await api.newGadget();
  const added = await ws.addCollaborator(collaborator, "build");
  if (!added) throw new Error(`Failed to share with ${collaborator}`);
  using shared = await bobApi.openGadget((await ws.getMetadata()).id);
  await test({ ws, shared, bob: added.profile, model });
}

async function ownerOf(ws: RpcStub<Overseer>, chatId: number): Promise<AiChatAuthorInfo> {
  const [prompt] = await loadAllChatHistory(before => ws.getChatHistory(chatId, before));
  if (prompt?.type !== "message" || prompt.author.name !== OWNER) throw new Error("No prompt by the owner");
  return prompt.author;
}

async function turn(ws: RpcStub<Overseer>, model: RoutedScriptedModel, chatId: number, text: string) {
  const requests = model.requests.length;
  await ws.sendChatMessage(chatId, text, SCRIPTED_MODEL_ID);
  await waitFor("the turn's model request", async () => model.requests.length > requests || null);
  await waitForIdleChat(ws, chatId);
}

it.concurrent("the owner's and a collaborator's messages reach the next turn with their authors, and the " +
    "turn after starts with that request", async () => {
  await sharedWorkspace("authorssend", [
    { text: "Planned." }, { text: "Go ahead." }, { text: "You're welcome." },
  ], async ({ ws, shared, bob, model }) => {
    const chatId = await ws.newChat("Plan the offsite.", SCRIPTED_MODEL_ID);
    await waitFor("the first model request", async () => model.requests.length === 1 || null);
    await waitForIdleChat(ws, chatId);
    await shared.sendChatMessage(chatId, "I'll book the venue.", null);
    await turn(ws, model, chatId, "Book it, Bob.");
    await turn(ws, model, chatId, "Thanks.");
    const alice = await ownerOf(ws, chatId);

    expect(model.requests.map(userTexts)).toEqual([
      ["Plan the offsite."],
      [from(alice, "Plan the offsite."), from(bob, "I'll book the venue."), from(alice, "Book it, Bob.")],
      [
        from(alice, "Plan the offsite."), from(bob, "I'll book the venue."), from(alice, "Book it, Bob."),
        from(alice, "Thanks."),
      ],
    ]);
    expectStartsWith(model.requests[2], model.requests[1]);
  });
});

it.concurrent("a collaborator's message sent while the agent works reaches its next step with their " +
    "name, as the next turn replays it", async () => {
  const answer = Promise.withResolvers<void>();
  await sharedWorkspace("authorssteer", [
    { text: "Building the tracker.", after: answer.promise },
    { text: "Switched to a dark theme." },
    { text: "You're welcome." },
  ], async ({ ws, shared, bob, model }) => {
    const chatId = await ws.newChat("Build a habit tracker.", SCRIPTED_MODEL_ID);
    await waitFor("the first model request", async () => model.requests.length === 1 || null);
    await shared.sendChatMessage(chatId, "Make it dark.", null);
    await waitFor("the queued steer", async () =>
      (await ws.listChats()).find(chat => chat.id === chatId)?.queuedSteers?.length === 1 || null);
    answer.resolve();
    await waitFor("the steered request", async () => model.requests.length === 2 || null);
    await waitForIdleChat(ws, chatId);
    await turn(ws, model, chatId, "Thanks.");
    const alice = await ownerOf(ws, chatId);

    expect(model.requests.map(userTexts)).toEqual([
      ["Build a habit tracker."],
      ["Build a habit tracker.", `<from>Bob Builder (${bob.id})</from>\nMake it dark.`],
      [from(alice, "Build a habit tracker."), from(bob, "Make it dark."), from(alice, "Thanks.")],
    ]);
    const steer = (await loadAllChatHistory(before => ws.getChatHistory(chatId, before)))
        .find(message => message.type === "message" && message.steered);
    expect(steer).toMatchObject({ message: "Make it dark.", author: { id: bob.id, name: COLLABORATOR } });
  });
});
