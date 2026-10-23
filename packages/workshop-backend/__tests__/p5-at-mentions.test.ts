import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type {
  AiChatMessage, GadgetMetadataWithTimestamps, Overseer, SlashCommandRequest,
} from "@gadgets/workshop-shared/api";
import type { P5Mark, P5Marked } from "@gadgets/workshop-shared/p5-marks";
import { AGENT_RUNNING_ERROR_MESSAGE } from "../src/overseer.js";
import { SharingManager } from "../src/sharing.js";
import { UserDurableObject } from "../src/user.js";
import { inWorkspace, signedIn, type Person, type Workspace } from "./p5-workspace.js";

const CLAUDE = "claude-opus-5-5";
const MODEL = {
  profile: { type: "agent" as const, id: CLAUDE, name: "Claude Opus 5.5" },
  config: { provider: "anthropic" as const, model: CLAUDE, apiToken: "sk-ant-test", apiUrl: "https://at-mentions.test" },
};
const COMPACT: SlashCommandRequest = { id: { builtin: true, commandId: "compact" }, args: "@Bob Builder" };

/**
 * A workspace Alex Levi owns, with Bob Builder and Dana at "Workspace" and Uma Gadgets at "Gadget only", seen through
 * Alex's session. `turns` counts the agent turns started (none runs unless `agentRuns`); `modelsAsked` lists the model
 * each send asked the sender's account for.
 */
type InChat = {
  alex: Person;
  bob: Person;
  dana: Person;
  uma: Person;
  workspace: Workspace;
  owner: Overseer;
  turns: ReturnType<typeof vi.fn>;
  modelsAsked(): (string | null)[];
};

async function inChat(test: (chat: InChat) => Promise<void>, { agentRuns = false } = {}): Promise<void> {
  let contexts = vi.spyOn(UserDurableObject.prototype, "getChatContext");
  let alex = await signedIn("Alex Levi");
  let bob = await signedIn("Bob Builder");
  let dana = await signedIn("Dana");
  let uma = await signedIn("Uma Gadgets");
  for (let sender of [alex, bob]) await sender.user.addModel(MODEL.profile, MODEL.config);
  await inWorkspace(alex, async workspace => {
    workspace.share(bob, "build");
    workspace.share(dana, "build");
    workspace.share(uma, "use");
    let turns = vi.fn();
    if (!agentRuns) workspace.impl.startAgent = turns;
    using owner = await workspace.open(alex);
    contexts.mockClear();
    await test({
      alex, bob, dana, uma, workspace, owner, turns,
      modelsAsked: () => contexts.mock.calls.map(([modelId]) => modelId),
    });
  });
}

async function markOf(person: Person, workspaceId: string): Promise<P5Mark | undefined> {
  let rows: (GadgetMetadataWithTimestamps & P5Marked)[] = await person.user.listGadgets();
  return rows.find(row => row.id === workspaceId)?.p5Mark;
}

/** Each message in the chat, as [author, text]. */
function said(workspace: Workspace, chatId: number): [string, unknown][] {
  return ([...workspace.impl.storage.chats.list()] as AiChatMessage[])
      .flatMap(record => record.chatId === chatId && record.type === "message"
        ? [[record.author.name, record.message] as [string, unknown]] : []);
}

function settled(call: Promise<unknown>): Promise<string> {
  return call.then(() => "sent", (error: Error) => `refused: ${error.message}`);
}

function warnedEvents(warn: MockInstance<typeof console.warn>): unknown[] {
  return warn.mock.calls.map(([entry]) => (entry as { event?: unknown } | undefined)?.event);
}

/**
 * The model's answers, "Done." each time, held until `answering` resolves. `prompts` holds each request's body, in the
 * order the model was asked.
 */
function modelAnswers(answering: Promise<void>): { asked(): number; prompts: Promise<string>[] } {
  let prompts: Promise<string>[] = [];
  let fetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    let url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== MODEL.config.apiUrl) return fetch(input, init);
    prompts.push(new Request(input, init).text());
    let events = [
      { type: "message_start", message: { id: "answer", type: "message", role: "assistant", model: CLAUDE,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    let body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    return answering.then(() => new Response(body, { headers: { "content-type": "text/event-stream" } }));
  });
  return { asked: () => prompts.length, prompts };
}

const ONLY_THE_SENDER_OR_NOBODY: [string, string][] = [
  ["only its sender", "@Alex Levi a note to myself: page 9"],
  ["nobody in the chat", "Ask @Carol Stone, or mail bob@dana.com"],
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("an \"@\" of someone in the chat goes to people only", { timeout: 90_000 }, () => {
  it("through newChat: commits the message, starts no turn, asks for no model, and marks them for a new chat",
      async () => {
    await inChat(async ({ bob, workspace, owner, turns, modelsAsked }) => {
      let chatId = await owner.newChat("@Bob Builder please read the brief", CLAUDE);
      expect(turns).not.toHaveBeenCalled();
      expect(workspace.impl.storage.chatMeta.get(chatId).activeAgent).toBeUndefined();
      expect(modelsAsked()).toEqual([null]);
      expect(said(workspace, chatId)).toEqual([["Alex Levi", "@Bob Builder please read the brief"]]);
      expect(await markOf(bob, workspace.id)).toEqual({ kind: "mention", by: "Alex Levi", chatId });
    });
  });

  it("through sendChatMessage: starts no turn, asks for no model, and marks them with the chat's title", async () => {
    await inChat(async ({ bob, workspace, owner, turns, modelsAsked }) => {
      let chatId = await owner.newChat("Numbers for the quarter", null);
      await owner.setChatTitle(chatId, "Q3 plan");
      await owner.sendChatMessage(chatId, "@bob builder, the second page", CLAUDE);
      expect(turns).not.toHaveBeenCalled();
      expect(workspace.impl.storage.chatMeta.get(chatId).activeAgent).toBeUndefined();
      expect(modelsAsked()).toEqual([null, null]);
      expect(said(workspace, chatId)).toHaveLength(2);
      expect(await markOf(bob, workspace.id))
          .toEqual({ kind: "mention", by: "Alex Levi", chatId, chatTitle: "Q3 plan" });
    });
  });

  it("by a collaborator, of the owner: starts no turn, and marks the owner's own listing", async () => {
    await inChat(async ({ alex, bob, workspace, turns, modelsAsked }) => {
      using collaborator = await workspace.open(bob);
      let chatId = await collaborator.newChat("@Alex Levi is this right?", CLAUDE);
      expect(turns).not.toHaveBeenCalled();
      expect(modelsAsked()).toEqual([null]);
      expect(said(workspace, chatId)).toEqual([["Bob Builder", "@Alex Levi is this right?"]]);
      expect(await markOf(alex, workspace.id)).toEqual({ kind: "mention", by: "Bob Builder", chatId });
    });
  });

  it("marks everyone it names but the sender", async () => {
    await inChat(async ({ alex, bob, dana, workspace, owner, turns }) => {
      let chatId = await owner.newChat("@Alex Levi, @Bob Builder and @Dana, all of us", CLAUDE);
      expect(turns).not.toHaveBeenCalled();
      for (let person of [bob, dana]) {
        expect(await markOf(person, workspace.id)).toEqual({ kind: "mention", by: "Alex Levi", chatId });
      }
      expect(await markOf(alex, workspace.id)).toBeUndefined();
    });
  });
});

describe("a message that names no one else in the chat runs the agent's turn as Cloudflare's", { timeout: 90_000 },
    () => {
  it.each([
    ["the sender", "@Alex Levi a note to myself"],
    ["a \"Gadget only\" person", "@Uma Gadgets should see this"],
    ["someone outside the workspace", "@Carol Stone should see this"],
    ["an email address holding a name in the chat", "Send it to bob@dana.com"],
  ])("an \"@\" of %s", async (_named, message) => {
    await inChat(async ({ alex, bob, dana, uma, workspace, owner, turns, modelsAsked }) => {
      let carol = await signedIn("Carol Stone");
      let chatId = await owner.newChat(message, CLAUDE);
      expect(turns).toHaveBeenCalledTimes(1);
      expect(workspace.impl.storage.chatMeta.get(chatId).activeAgent).toEqual(MODEL.profile);
      expect(modelsAsked()).toEqual([CLAUDE]);
      for (let person of [alex, bob, dana, uma]) expect(await markOf(person, workspace.id)).toBeUndefined();
      expect(await carol.user.listGadgets()).toEqual([]);
    });
  });

  it("a slash command, whatever its words", async () => {
    await inChat(async ({ bob, workspace, owner, turns, modelsAsked }) => {
      let chatId = await owner.newChat("Numbers for the quarter", null);
      await owner.sendChatMessage(chatId, COMPACT, CLAUDE);
      expect(turns).toHaveBeenCalledTimes(1);
      expect(modelsAsked()).toEqual([null, CLAUDE]);
      expect(await markOf(bob, workspace.id)).toBeUndefined();
    });
  });

  it.each(ONLY_THE_SENDER_OR_NOBODY)("an \"@\" of %s, sent in a chat with no turn running, starts one",
      async (_named, message) => {
    await inChat(async ({ alex, bob, dana, workspace, owner, turns, modelsAsked }) => {
      let chatId = await owner.newChat("Numbers for the quarter", null);
      expect(await settled(owner.sendChatMessage(chatId, message, CLAUDE))).toBe("sent");
      expect(turns).toHaveBeenCalledTimes(1);
      expect(workspace.impl.storage.chatMeta.get(chatId).activeAgent).toEqual(MODEL.profile);
      expect(modelsAsked()).toEqual([null, CLAUDE]);
      expect(said(workspace, chatId)).toEqual([["Alex Levi", "Numbers for the quarter"], ["Alex Levi", message]]);
      for (let person of [alex, bob, dana]) expect(await markOf(person, workspace.id)).toBeUndefined();
    });
  });
});

describe("when the people in the chat cannot be read", { timeout: 90_000 }, () => {
  it.each([
    ["the collaborators", (_owner: Person) => {
      vi.spyOn(SharingManager.prototype, "listCollaborators").mockImplementation(() => {
        throw new Error("the collaborators cannot be read");
      });
    }],
    ["the owner's profile", (owner: Person) => {
      let whoami = UserDurableObject.prototype.whoami;
      vi.spyOn(UserDurableObject.prototype, "whoami").mockImplementation(async function (this: UserDurableObject) {
        let profile = await whoami.call(this);
        if (profile.id === owner.profile.id) throw new Error("the owner's User Durable Object refused");
        return profile;
      });
    }],
  ])("%s: logs it, and the message is sent as Cloudflare sends it", async (_unread, failRead) => {
    await inChat(async ({ alex, bob, workspace, turns, modelsAsked }) => {
      using collaborator = await workspace.open(bob);
      let warn = vi.spyOn(console, "warn");
      failRead(alex);
      let chatId = await collaborator.newChat("@Alex Levi is this right?", CLAUDE);
      expect(turns).toHaveBeenCalledTimes(1);
      expect(modelsAsked()).toEqual([CLAUDE]);
      expect(said(workspace, chatId)).toEqual([["Bob Builder", "@Alex Levi is this right?"]]);
      expect(warnedEvents(warn)).toContain("p5.at-mentions.read.failed");
      expect(await markOf(alex, workspace.id)).toBeUndefined();
    });
  });
});

describe("while the agent works", { timeout: 90_000 }, () => {
  it("an \"@\" meets Cloudflare's refusal: it is never steered or queued, and marks no one", async () => {
    let answer!: () => void;
    let { asked } = modelAnswers(new Promise(resolve => { answer = resolve; }));
    await inChat(async ({ bob, workspace, owner }) => {
      let chatId = await owner.newChat("Work out the totals", CLAUDE);
      await vi.waitFor(() => expect(asked()).toBe(1));
      expect(await settled(owner.sendChatMessage(chatId, "@Bob Builder, look", CLAUDE)))
          .toBe(`refused: ${AGENT_RUNNING_ERROR_MESSAGE}`);
      expect(workspace.impl.storage.chatMeta.get(chatId).queuedSteers).toBeUndefined();
      expect(await settled(owner.sendChatMessage(chatId, "Make it dark.", CLAUDE))).toBe("sent");
      expect(workspace.impl.storage.chatMeta.get(chatId).queuedSteers.map(({ text }: { text: string }) => text))
          .toEqual(["Make it dark."]);
      answer();
      await workspace.impl.waitForAllAgentsToComplete();
      expect(said(workspace, chatId).filter(([author]) => author === "Alex Levi").map(([, text]) => text))
          .toEqual(["Work out the totals", "Make it dark."]);
      expect(await markOf(bob, workspace.id)).toBeUndefined();
    }, { agentRuns: true });
  });

  it.each(ONLY_THE_SENDER_OR_NOBODY)("an \"@\" of %s is sent and steers, and the agent reads it at its next step",
      async (_named, message) => {
    let answer!: () => void;
    let model = modelAnswers(new Promise(resolve => { answer = resolve; }));
    await inChat(async ({ alex, bob, dana, workspace, owner }) => {
      let chatId = await owner.newChat("Work out the totals", CLAUDE);
      await vi.waitFor(() => expect(model.asked()).toBe(1));
      expect(await settled(owner.sendChatMessage(chatId, message, CLAUDE))).toBe("sent");
      expect(workspace.impl.storage.chatMeta.get(chatId).queuedSteers.map(({ text }: { text: string }) => text))
          .toEqual([message]);
      answer();
      await workspace.impl.waitForAllAgentsToComplete();
      expect(model.asked()).toBe(2);
      expect(await model.prompts[1]).toContain(JSON.stringify(message));
      expect(said(workspace, chatId).filter(([author]) => author === "Alex Levi").map(([, text]) => text))
          .toEqual(["Work out the totals", message]);
      for (let person of [alex, bob, dana]) expect(await markOf(person, workspace.id)).toBeUndefined();
    }, { agentRuns: true });
  });
});

describe("a mention mark", { timeout: 90_000 }, () => {
  it("replaces a share mark not yet opened", async () => {
    await inChat(async ({ workspace, owner }) => {
      let dan = await signedIn("Dan Cohen");
      await owner.addCollaborator(dan.profile.id, "build");
      expect(await markOf(dan, workspace.id)).toEqual({ kind: "share", by: "Alex Levi" });
      let chatId = await owner.newChat("@Dan Cohen the numbers are in", CLAUDE);
      expect(await markOf(dan, workspace.id)).toEqual({ kind: "mention", by: "Alex Levi", chatId });
    });
  });

  const TOTALS = "@Bob Builder, the totals";

  it.each([
    ["newChat", (owner: Overseer, _chatId: number) => owner.newChat(TOTALS, CLAUDE)],
    ["sendChatMessage", (owner: Overseer, chatId: number) => owner.sendChatMessage(chatId, TOTALS, CLAUDE)],
  ])("that cannot be written is logged, and %s still sends, with no turn", async (_entry, send) => {
    await inChat(async ({ bob, workspace, owner, turns }) => {
      let chatId = await owner.newChat("Numbers for the quarter", null);
      vi.spyOn(UserDurableObject.prototype, "p5Mark").mockRejectedValue(new Error("User Durable Object reset"));
      let warn = vi.spyOn(console, "warn");
      expect(await settled(send(owner, chatId))).toBe("sent");
      expect(([...workspace.impl.storage.chats.list()] as AiChatMessage[])
          .filter(record => record.type === "message" && record.message === TOTALS)).toHaveLength(1);
      expect(turns).not.toHaveBeenCalled();
      expect(warnedEvents(warn)).toContain("p5.marks.mention.failed");
      expect(await markOf(bob, workspace.id)).toBeUndefined();
    });
  });

  it("whose chat title cannot be read is logged, and the message still goes, with no turn", async () => {
    await inChat(async ({ bob, workspace, owner, turns }) => {
      let chatId = await owner.newChat("Numbers for the quarter", null);
      let chatMeta = vi.spyOn(workspace.impl.storage.chatMeta, "get");
      let send = workspace.impl.sendChatMessage;
      workspace.impl.sendChatMessage = async function (...args: unknown[]) {
        await send.apply(this, args);
        chatMeta.mockImplementation(() => { throw new Error("the chat's metadata cannot be read"); });
      };
      let warn = vi.spyOn(console, "warn");
      expect(await settled(owner.sendChatMessage(chatId, TOTALS, CLAUDE))).toBe("sent");
      chatMeta.mockRestore();
      expect(said(workspace, chatId)).toHaveLength(2);
      expect(turns).not.toHaveBeenCalled();
      expect(warnedEvents(warn)).toContain("p5.marks.mention.failed");
      expect(await markOf(bob, workspace.id)).toBeUndefined();
    });
  });
});
