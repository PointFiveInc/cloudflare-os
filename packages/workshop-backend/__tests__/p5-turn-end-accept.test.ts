import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, getInitialSystemMessage, normalizeContext,
  type Context, type FauxResponseStep, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { keyString } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo, AiChatMessage, BlueprintMetadata, Overseer } from "@gadgets/workshop-shared/api";
import { ADMIN_CONFIG_KEY, parseBlueprintKvRecord } from "../src/storage-schema/blueprints-kv";
import { OVERSEER_STORAGE_VERSION } from "../src/storage-schema/overseer-migrations";
import { UserDurableObject } from "../src/user.js";
import { inWorkspace, signedIn, type Person, type Workspace } from "./p5-workspace.js";

const harness = vi.hoisted(() => {
  let kv = new Map<string, string>();
  let state = { unbound: false, turn: undefined as unknown, quick: undefined as unknown };
  let BLUEPRINTS = {
    get: async (key: string) => kv.get(key) ?? null,
    put: async (key: string, value: string) => { kv.set(key, value); },
    delete: async (key: string) => { kv.delete(key); },
  };
  return { kv, state, BLUEPRINTS };
});

vi.mock("../src/ai-models.js", async importOriginal => ({
  ...await importOriginal<object>(),
  getModel: (_env: unknown, config: { model: string }) =>
    config.model === "quick-model" ? harness.state.quick : harness.state.turn,
}));

vi.mock("../src/admin-config.js", async importOriginal => {
  let original = await importOriginal<typeof import("../src/admin-config.js")>();
  return {
    ...original,
    readAdminConfig: (workerEnv: Cloudflare.Env) => original.readAdminConfig(
        workerEnv.BLUEPRINTS || harness.state.unbound
          ? workerEnv : { ...workerEnv, BLUEPRINTS: harness.BLUEPRINTS } as Cloudflare.Env),
  };
});

const BLUEPRINTS = harness.BLUEPRINTS as unknown as KVNamespace;
const AGENT: AiChatAuthorInfo = { type: "agent", id: "faux-model", name: "Faux" };
const MODEL = { provider: "anthropic" as const, model: "faux-model", apiToken: "" };
const QUICK = { provider: "anthropic" as const, model: "quick-model", apiToken: "" };
const CALENDAR = {
  id: "calendar", description: { displayName: "Calendar" },
  supportedResources: [{ urlPattern: "https://calendar.example/*", title: "Calendar" }],
};
const START = { "client.js": "one\n" };
const SECTION = "## When your changes go live\n\n" +
    "Your changes to a Gadget go live for everyone who uses it as soon as your turn finishes: nobody clicks Accept " +
    "changes, so never ask anyone to. Only if your turn is stopped or fails do your changes wait for the person to " +
    "keep or discard them.";

type Impl = any;
type Session = Overseer & Disposable;
/** Alice owns the workspace; Bob is in it at "Workspace". Each has the faux model; `waits` sees each `waitUntil`. */
type Team = {
  alice: Person;
  bob: Person;
  workspace: Workspace;
  impl: Impl;
  asAlice: Session;
  asBob: Session;
  waits: MockInstance;
};

/** Sets the Turn-end accept switch in the admin config the Workshop reads; `undefined` leaves it unset. */
function turnEndAccept(on: unknown, instanceInstructions?: string): void {
  harness.kv.set(ADMIN_CONFIG_KEY, JSON.stringify({ instanceInstructions, p5TurnEndAccept: on }));
}

beforeEach(() => {
  harness.kv.clear();
  harness.state.unbound = false;
  harness.state.quick = undefined;
  turnEndAccept(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function withModels(person: Person, quick = false): Promise<Person> {
  await person.user.addModel({ ...AGENT }, MODEL);
  if (quick) {
    await person.user.addModel({ type: "agent", id: "quick-model", name: "Quick" }, QUICK);
    await person.user.setQuickModel("quick-model");
  }
  return person;
}

async function inTeam(test: (team: Team) => Promise<void>, { quick = false } = {}): Promise<void> {
  let alice = await withModels(await signedIn("Alice Levi"), quick);
  let bob = await withModels(await signedIn("Bob Builder"), quick);
  await inWorkspace(alice, async workspace => {
    workspace.share(bob, "build");
    let waits = vi.spyOn(workspace.impl.ctx, "waitUntil");
    using asAlice = await workspace.open(alice);
    using asBob = await workspace.open(bob);
    await test({ alice, bob, workspace, impl: workspace.impl, asAlice, asBob, waits });
  });
}

/**
 * Waits for every turn to end and for all the work their ends handed to `waitUntil`, turn-end accepts included.
 * Returns why any of that work failed.
 */
async function settled({ impl, waits }: Pick<Team, "impl" | "waits">): Promise<unknown[]> {
  let results: PromiseSettledResult<unknown>[] = [];
  for (let seen = -1; seen !== waits.mock.calls.length;) {
    seen = waits.mock.calls.length;
    await impl.waitForAllAgentsToComplete();
    results = await Promise.allSettled(waits.mock.calls.map(([promise]) => promise));
  }
  return results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
}

async function commit(impl: Impl, files: Record<string, string>, parents: string[] = []): Promise<string> {
  return await impl.gitStore.writeFilesAsCommit(new Map(Object.entries(files)), {
    parents, author: { name: "Alice Levi", email: "alice@pointfive.example" }, message: "Edit",
    timestamp: new Date(0),
  });
}

function theGadget(impl: Impl): any {
  let gadgets = [...impl.storage.gadgets.list()].filter(record => record.type === "gadget");
  expect(gadgets).toHaveLength(1);
  return gadgets[0];
}

/** Adds the workspace's gadget, APP, live at `files`. */
async function addGadget(impl: Impl, files: Record<string, string>): Promise<string> {
  let commitId = await commit(impl, files);
  impl.storage.gadgets.put({
    type: "gadget", id: impl.allocateWorkpieceId(), title: "App", created: new Date(0), bindingName: "APP",
    bindings: {}, commitId,
  });
  return commitId;
}

/** Moves the gadget's live version on to `files`, as an accept in another chat would. */
async function moveLive(impl: Impl, files: Record<string, string>): Promise<void> {
  let gadget = theGadget(impl);
  impl.storage.gadgets.put({ ...gadget, commitId: await commit(impl, files, [gadget.commitId]) });
}

async function live(impl: Impl): Promise<Record<string, string>> {
  return Object.fromEntries(await impl.gitStore.readCommitFiles(theGadget(impl).commitId));
}

async function chatFiles(impl: Impl, chatId: number): Promise<Record<string, string>> {
  let content = await impl.getCurrentChatContent(chatId, impl.storage.chatMeta.get(chatId));
  return Object.fromEntries(content.get(theGadget(impl).id));
}

function messages(impl: Impl, chatId: number): AiChatMessage[] {
  return [...impl.storage.chats.list({ prefix: `${keyString(chatId)}.` })];
}

/** Who accepted the chat's changes, in order. */
function accepts(impl: Impl, chatId: number): string[] {
  return messages(impl, chatId).flatMap(message => message.type === "merge" ? [message.author.name] : []);
}

function pending(impl: Impl, chatId: number): number[] {
  return impl.proposedChangeWorkpieceIds(chatId, impl.storage.chatMeta.get(chatId));
}

function script(...steps: FauxResponseStep[]): void {
  let faux = createFauxCore({ models: [{ id: "faux-model" }] });
  faux.setResponses(steps);
  harness.state.turn = { model: faux.getModel(), stream: faux.stream };
}

function nameWorkspace(title: string): void {
  let faux = createFauxCore({ models: [{ id: "quick-model" }] });
  faux.setResponses([fauxAssistantMessage(fauxText(title))]);
  harness.state.quick = { model: faux.getModel(), stream: faux.stream };
}

const write = (content: string, workpiece = "APP") => fauxAssistantMessage(
    [fauxToolCall("writeFile", { workpiece, filename: "client.js", content })], { stopReason: "toolUse" });
const done = () => fauxAssistantMessage(fauxText("Done."));

/** A step held until released; `requested` resolves when the model is asked for it. */
function held(step: () => ReturnType<typeof done>) {
  let requested = Promise.withResolvers<void>();
  let release = Promise.withResolvers<void>();
  return {
    requested: requested.promise,
    release: () => release.resolve(),
    step: async () => {
      requested.resolve();
      await release.promise;
      return step();
    },
  };
}

/** A final reply after which `act` runs as the turn winds down, in its last await before it ends. */
function windDown(impl: Impl, act: (chatId: number) => void): FauxResponseStep {
  let ending = false;
  let reconcile = impl.reconcilePendingGadgets.bind(impl);
  impl.reconcilePendingGadgets = async (chatId: number) => {
    if (ending) {
      ending = false;
      act(chatId);
    }
    return await reconcile(chatId);
  };
  return () => {
    ending = true;
    return done();
  };
}

function logged(spy: MockInstance, event: string): Record<string, unknown>[] {
  return spy.mock.calls.flatMap(([line]) => (line as { event?: unknown })?.event === event
    ? [line as Record<string, unknown>] : []);
}

function lines() {
  let info = vi.spyOn(console, "info");
  let warn = vi.spyOn(console, "warn");
  return {
    accepted: () => logged(info, "p5.turn_end_accept.accepted"),
    failed: () => logged(warn, "p5.turn_end_accept.failed"),
  };
}

describe("turn-end accept", { timeout: 90_000 }, () => {
  it("puts a finished turn live in the name of the person who started it, logs it, and names the workspace",
      () => inTeam(async team => {
    let { impl, bob, asBob } = team;
    let log = lines();
    await addGadget(impl, {});
    nameWorkspace("Referral Board");
    script(write("two\n"), done());
    let chatId = await asBob.newChat("Make it two, please.", "faux-model");
    await settled(team);

    expect(await live(impl)).toEqual({ "client.js": "two\n" });
    expect(accepts(impl, chatId)).toEqual(["Bob Builder"]);
    expect(pending(impl, chatId)).toEqual([]);
    expect(log.accepted()).toEqual([expect.objectContaining({
      event: "p5.turn_end_accept.accepted", message: "turn-end accept", chatId,
      durableObjectId: bob.user.id.toString(),
    })]);
    expect(JSON.stringify(log.accepted())).not.toContain("Make it two");
    expect(log.failed()).toEqual([]);
    await vi.waitFor(() => expect(impl.storage.title.get()).toBe("Referral Board"));
  }, { quick: true }));

  it("puts a turn live that ends waiting on an approval card", () => inTeam(async team => {
    let { impl, asAlice } = team;
    vi.spyOn(UserDurableObject.prototype, "listGatekeeperVendors").mockResolvedValue([CALENDAR] as never);
    await addGadget(impl, START);
    script(write("two\n"), fauxAssistantMessage([fauxToolCall("requestConnection",
        { vendorId: "calendar", reason: "Read the schedule.", bindingName: "CALENDAR" })], { stopReason: "toolUse" }));
    let chatId = await asAlice.newChat("Show my schedule.", "faux-model");
    await settled(team);

    expect(messages(impl, chatId).filter(message => message.type === "connectionRequest")
        .map(message => message.state)).toEqual(["pending"]);
    expect(await live(impl)).toEqual({ "client.js": "two\n" });
    expect(accepts(impl, chatId)).toEqual(["Alice Levi"]);
  }));

  it("leaves the changes pending after Stop", () => inTeam(async team => {
    let { impl, asAlice } = team;
    let log = lines();
    await addGadget(impl, START);
    let last = held(done);
    script(write("two\n"), last.step);
    let chatId = await asAlice.newChat("Make it two.", "faux-model");
    await last.requested;
    await asAlice.stopAgent(chatId);
    last.release();
    await settled(team);

    expect(accepts(impl, chatId)).toEqual([]);
    expect(await live(impl)).toEqual(START);
    expect(pending(impl, chatId)).toEqual([theGadget(impl).id]);
    expect(log.accepted()).toEqual([]);
  }));

  it("leaves the changes pending after Stop as the turn winds down, its reply already in", () =>
      inTeam(async team => {
    let { impl, asAlice } = team;
    await addGadget(impl, START);
    script(write("two\n"), windDown(impl, chatId => impl.cancelAgent(chatId)));
    let chatId = await asAlice.newChat("Make it two.", "faux-model");
    await settled(team);

    expect(messages(impl, chatId).filter(message => message.type === "error")).toEqual([]);
    expect(accepts(impl, chatId)).toEqual([]);
    expect(await live(impl)).toEqual(START);
    expect(pending(impl, chatId)).toEqual([theGadget(impl).id]);
  }));

  it("leaves the changes pending after an error", () => inTeam(async team => {
    let { impl, asAlice } = team;
    await addGadget(impl, START);
    script(write("two\n"),
        fauxAssistantMessage(fauxText(""), { stopReason: "error", errorMessage: "400 Invalid request" }));
    let chatId = await asAlice.newChat("Make it two.", "faux-model");
    await settled(team);

    expect(messages(impl, chatId).filter(message => message.type === "error")).toHaveLength(1);
    expect(accepts(impl, chatId)).toEqual([]);
    expect(await live(impl)).toEqual(START);
    expect(pending(impl, chatId)).toEqual([theGadget(impl).id]);
  }));

  it("brings in another chat's change once, then puts the turn live", () => inTeam(async team => {
    let { impl, asBob } = team;
    await addGadget(impl, START);
    script(write("two\n"), async () => {
      await moveLive(impl, { ...START, "lib.js": "theirs\n" });
      return done();
    });
    let chatId = await asBob.newChat("Make it two.", "faux-model");
    await settled(team);

    expect(await live(impl)).toEqual({ "client.js": "two\n", "lib.js": "theirs\n" });
    expect(messages(impl, chatId).flatMap(message =>
      message.type === "changes" && message.mainlineMerge ? [message.author.name] : [])).toEqual(["Bob Builder"]);
    expect(accepts(impl, chatId)).toEqual(["Bob Builder"]);
  }));

  it("leaves a real clash pending, and puts it live once the agent resolves it", () => inTeam(async team => {
    let { impl, asAlice } = team;
    let log = lines();
    await addGadget(impl, START);
    script(write("two\n"), async () => {
      await moveLive(impl, { "client.js": "three\n" });
      return done();
    });
    let chatId = await asAlice.newChat("Make it two.", "faux-model");
    await settled(team);

    expect(accepts(impl, chatId)).toEqual([]);
    expect(await live(impl)).toEqual({ "client.js": "three\n" });
    expect((await chatFiles(impl, chatId))["client.js"]).toMatch(/^<<<<<<< /m);
    expect(log.accepted()).toEqual([]);
    expect(log.failed()).toEqual([]);

    script(write("two and three\n"), done());
    await asAlice.sendChatMessage(chatId, "Settle the clash.", "faux-model");
    await settled(team);

    expect(accepts(impl, chatId)).toEqual(["Alice Levi"]);
    expect(await live(impl)).toEqual({ "client.js": "two and three\n" });
  }));

  it("leaves pending a clash mark that a merge from before merges were commits left", () =>
      inTeam(async team => {
    let { impl, alice, asAlice } = team;
    let head = await addGadget(impl, START);
    let gadgetId = theGadget(impl).id;
    let chatId = await asAlice.newChat("Hi.", null);
    await impl.submitCodeChange(chatId, {
      generation: 0, revision: 0, clientId: "alice", seq: 1, pins: [{ gadgetId, baseCommit: head }],
      change: { [gadgetId]: [["client.js", { set: "<<<<<<< mainline\nthree\n=======\ntwo\n>>>>>>> this chat\n" }]] },
    }, alice.profile, alice.user.id.toString());
    impl.materializeChatChanges(chatId);
    let [merged] = messages(impl, chatId).filter(message => message.type === "changes");
    impl.storage.chats.put({ ...merged, mainlineMerge: { conflictPaths: ["APP/client.js"] } });

    script(done());
    await asAlice.sendChatMessage(chatId, "Anything left?", "faux-model");
    await settled(team);

    expect(accepts(impl, chatId)).toEqual([]);
    expect(pending(impl, chatId)).toEqual([gadgetId]);
  }));

  it("accepts a turn a gadget started in the name of the person whose call started it", () =>
      inTeam(async team => {
    let { impl, bob, asAlice } = team;
    await addGadget(impl, START);
    let chatId = await asAlice.newChat("Refresh when the board asks.", null);
    script(write("two\n"), done());
    await impl.deliverAgentCallback(chatId, "refresh", [], bob.user.id.toString(), "faux-model");
    await impl.drainPendingAgentCalls(chatId);
    await settled(team);

    expect(messages(impl, chatId).find(message => message.type === "agentCallback")?.author)
        .toMatchObject({ type: "gadget", id: bob.profile.id });
    expect(accepts(impl, chatId)).toEqual(["Bob Builder"]);
    expect(await live(impl)).toEqual({ "client.js": "two\n" });
  }));

  it("does nothing after a turn with no changes, and logs no accept", () => inTeam(async team => {
    let { impl, asAlice } = team;
    let log = lines();
    await addGadget(impl, START);
    script(done());
    let chatId = await asAlice.newChat("What does it do?", "faux-model");
    await settled(team);

    expect(accepts(impl, chatId)).toEqual([]);
    expect(await live(impl)).toEqual(START);
    expect(log.accepted()).toEqual([]);
    expect(log.failed()).toEqual([]);
  }));

  it("leaves a follow-up turn to accept, quietly", () => inTeam(async team => {
    let { impl, alice, asAlice } = team;
    let log = lines();
    await addGadget(impl, START);
    let followUp = held(done);
    script(write("two\n"), windDown(impl, chatId =>
      expect(impl.steerRunningTurn(chatId, alice.user.id.toString(), alice.profile, "Keep it short.")).toBe(true)),
    followUp.step);
    let chatId = await asAlice.newChat("Make it two.", "faux-model");
    await followUp.requested;
    await Promise.allSettled(team.waits.mock.calls.map(([promise]) => promise));

    expect(accepts(impl, chatId)).toEqual([]);
    followUp.release();
    await settled(team);

    expect(accepts(impl, chatId)).toEqual(["Alice Levi"]);
    expect(await live(impl)).toEqual({ "client.js": "two\n" });
    expect(log.accepted()).toHaveLength(1);
    expect(log.failed()).toEqual([]);
  }));

  it("leaves the changes pending, quietly, while someone types in the chat's code", () => inTeam(async team => {
    let { impl, alice, asAlice } = team;
    let log = lines();
    await addGadget(impl, START);
    let gadgetId = theGadget(impl).id;
    let chatId!: number;
    let writeCommit = impl.gitStore.writeFilesAsCommit.bind(impl.gitStore);
    impl.gitStore.writeFilesAsCommit = async (files: unknown, options: { message: string }) => {
      if (options.message.startsWith("Accept changes from chat")) {
        let { generation, revision } = impl.storage.chatMeta.get(chatId).codeBase;
        await impl.submitCodeChange(chatId, {
          generation, revision, clientId: "alice", seq: 1, change: { [gadgetId]: [["client.js", { set: "typing\n" }]] },
        }, alice.profile, alice.user.id.toString());
      }
      return await writeCommit(files, options);
    };
    script(write("two\n"), done());
    chatId = await asAlice.newChat("Make it two.", "faux-model");
    await settled(team);

    expect(accepts(impl, chatId)).toEqual([]);
    expect(await live(impl)).toEqual(START);
    expect(await chatFiles(impl, chatId)).toEqual({ "client.js": "typing\n" });
    expect(log.failed()).toEqual([]);
  }));

  it("names any other failure in the log and leaves the changes pending", () => inTeam(async team => {
    let { impl, alice, asAlice } = team;
    let log = lines();
    await addGadget(impl, START);
    let getChatContext = UserDurableObject.prototype.getChatContext;
    vi.spyOn(UserDurableObject.prototype, "getChatContext").mockImplementation(async function (
        this: UserDurableObject, modelId: string | null) {
      if (modelId === null) throw new Error("user unreachable");
      return await getChatContext.call(this, modelId);
    });
    script(write("two\n"), done());
    let chatId = await asAlice.newChat("Make it two.", "faux-model");
    await settled(team);

    expect(accepts(impl, chatId)).toEqual([]);
    expect(pending(impl, chatId)).toEqual([theGadget(impl).id]);
    expect(log.failed()).toEqual([expect.objectContaining({
      event: "p5.turn_end_accept.failed", chatId, durableObjectId: alice.user.id.toString(),
      error: "Error: user unreachable",
    })]);
    expect(log.accepted()).toEqual([]);
  }));

  it("puts a turn live that a reset caught between its final reply and its end", async () => {
    let alice = await signedIn("Alice Levi");
    let stub = env.TEST_OVERSEER.getByName(crypto.randomUUID());
    let userId = alice.user.id.toString();
    await alice.user.newGadget(stub.id.toString(), "Untitled Workspace");
    let chatId!: number;
    await expect(runInDurableObject(stub, async instance => {
      let impl = (instance as unknown as { impl: Impl }).impl;
      impl.ownerId = userId;
      impl.storage.ownerId.put(userId);
      impl.storage.codeVersion.put(1);
      impl.storage.version.put(OVERSEER_STORAGE_VERSION);
      let head = await addGadget(impl, START);
      let gadgetId = theGadget(impl).id;
      chatId = await impl.newChat(alice.user, { profile: alice.profile }, "Make it two.");
      await impl.submitCodeChange(chatId, {
        generation: 0, revision: 0, clientId: "alice", seq: 1, pins: [{ gadgetId, baseCommit: head }],
        change: { [gadgetId]: [["client.js", { set: "two\n" }]] },
      }, alice.profile, userId);
      impl.materializeChatChanges(chatId);
      impl.addChatMessages(chatId, AGENT, [{ type: "message", message: "Done." }]);
      impl.storage.chatMeta.put({ ...impl.storage.chatMeta.get(chatId), activeAgent: AGENT });
      impl.storage.activeAgents.put(
          { chatId, modelId: AGENT.id, initiatorUserId: userId, initiator: alice.profile, callbackInitiated: false });
      await impl.ctx.storage.sync();
      impl.ctx.abort("A reset before the turn's end");
    })).rejects.toThrow(/A reset before the turn's end/);
    await runInDurableObject(env.TEST_OVERSEER.get(stub.id), async instance => {
      let impl = (instance as unknown as { impl: Impl }).impl;
      await impl.waitForAllAgentsToComplete();
      await vi.waitFor(() => expect(accepts(impl, chatId)).toEqual(["Alice Levi"]));

      expect(messages(impl, chatId).filter(message => message.type === "changes" && message.mainlineMerge))
          .toEqual([]);
      expect(await live(impl)).toEqual({ "client.js": "two\n" });
    });
  });
});

describe("turn-end accept switched off", { timeout: 90_000 }, () => {
  for (let [name, setUp] of [
    ["unset", () => turnEndAccept(undefined)],
    ["stored off", () => turnEndAccept(false)],
    ["not a boolean", () => turnEndAccept("true")],
    ["unreadable, as in Cloudflare's own tests", () => { harness.state.unbound = true; }],
  ] as const) {
    it(`keeps Cloudflare's behaviour with the switch ${name}: the changes wait for a click`, () =>
        inTeam(async team => {
      let { impl, asAlice } = team;
      let log = lines();
      setUp();
      await addGadget(impl, START);
      script(write("two\n"), done());
      let chatId = await asAlice.newChat("Make it two.", "faux-model");
      expect(await settled(team)).toEqual([]);

      expect(accepts(impl, chatId)).toEqual([]);
      expect(await live(impl)).toEqual(START);
      expect(pending(impl, chatId)).toEqual([theGadget(impl).id]);
      expect(log.accepted()).toEqual([]);
      expect(log.failed()).toEqual([]);

      expect(await asAlice.mergeChanges(chatId)).toEqual({ outcome: "merged" });
      expect(accepts(impl, chatId)).toEqual(["Alice Levi"]);
    }));
  }
});

// A blueprint's two releases, and a gadget owner's own change to the first that merges with the second cleanly.
const R1 = { "client.js": "one\n", "server.js": "a\nb\nc\nd\ne\n" };
const R2 = { "client.js": "two\n", "server.js": "a\nb\nc\nd\ntheirs\n" };
const OWN = { ...R1, "server.js": "mine\nb\nc\nd\ne\n" };
const MERGED = { ...R2, "server.js": "mine\nb\nc\nd\ntheirs\n" };

type Published = { blueprintId: string; releases: BlueprintMetadata[] };

/** Alice publishes R1, then R2, as one blueprint. */
async function publish(): Promise<Published> {
  let blueprintId!: string;
  let releases: BlueprintMetadata[] = [];
  await inTeam(async ({ impl, asAlice }) => {
    impl.env = { ...impl.env, BLUEPRINTS };
    await addGadget(impl, R1);
    using gadget = await asAlice.getGadget(theGadget(impl).id);
    blueprintId = (await gadget.createBlueprint("Alice's", "A starter")).id;
    releases.push(parseBlueprintKvRecord(harness.kv.get(blueprintId)!).metadata);
    await moveLive(impl, R2);
    await asAlice.updateBlueprint(blueprintId, { updateCode: true });
    releases.push(parseBlueprintKvRecord(harness.kv.get(blueprintId)!).metadata);
  });
  return { blueprintId, releases };
}

/**
 * In a fresh workspace of Alice's, makes the gadget from the first release, changes it to `own`, then updates it from
 * the blueprint with the reviewing agent `modelId`, as Alice. Returns the proposal's chat and its kind.
 */
async function update(test: (team: Team, proposal: { chatId: number; kind: string }) => Promise<void>,
    { blueprintId, releases }: Published, own: Record<string, string> | undefined, modelId: string | null) {
  await inTeam(async team => {
    let { impl, workspace, asAlice } = team;
    impl.env = { ...impl.env, BLUEPRINTS };
    harness.kv.set(blueprintId, JSON.stringify({ metadata: releases[0] }));
    let overseer = env.TEST_OVERSEER.get(env.TEST_OVERSEER.idFromString(workspace.id));
    await overseer.initializeFromBlueprint(blueprintId, releases[0]);
    if (own) await moveLive(impl, own);
    harness.kv.set(blueprintId, JSON.stringify({ metadata: releases[1] }));
    using gadget = await asAlice.getGadget(theGadget(impl).id);
    let result = await gadget.applyBlueprint(blueprintId, { modelId });
    if (result.outcome !== "proposed") throw new Error(`not proposed: ${result.outcome}`);
    let [proposal] = messages(impl, result.chatId).flatMap(message =>
      message.type === "changes" ? message.blueprintMerges ?? [] : []);
    await test(team, { chatId: result.chatId, kind: proposal.kind });
  });
}

describe("turn-end accept of an update from a blueprint", { timeout: 90_000 }, () => {
  it("puts a merge live when its review turn finishes", async () => {
    let blueprint = await publish();
    script(fauxAssistantMessage(fauxText("Reviewed.")));
    await update(async (team, { chatId, kind }) => {
      await settled(team);

      expect(kind).toBe("merge");
      expect(accepts(team.impl, chatId)).toEqual(["Alice Levi"]);
      expect(await live(team.impl)).toEqual(MERGED);
    }, blueprint, OWN, "faux-model");
  });

  it("leaves a merge pending whose review turn left a clash mark", async () => {
    let blueprint = await publish();
    script(fauxAssistantMessage(fauxText("Reviewed.")));
    let own = { ...OWN, "client.js": "mine too\n" };
    await update(async (team, { chatId, kind }) => {
      await settled(team);

      expect(kind).toBe("merge");
      expect(messages(team.impl, chatId).some(message => message.type === "message")).toBe(true);
      expect(accepts(team.impl, chatId)).toEqual([]);
      expect(await live(team.impl)).toEqual(own);
    }, blueprint, own, "faux-model");
  });

  for (let [name, own, modelId, expected] of [
    ["fast-forward", undefined, "faux-model", "fastForward"],
    ["follow", R2, "faux-model", "follow"],
    ["merge with \"No agent\"", OWN, null, "merge"],
  ] as const) {
    it(`leaves a ${name} pending: no turn runs`, async () => {
      let blueprint = await publish();
      script();
      await update(async (team, { chatId, kind }) => {
        await settled(team);

        expect(kind).toBe(expected);
        expect(messages(team.impl, chatId).map(message => message.type)).toEqual(["changes"]);
        expect(accepts(team.impl, chatId)).toEqual([]);
        expect(await live(team.impl)).toEqual(own ?? R1);
      }, blueprint, own, modelId);
    });
  }
});

/** The system prompt's static head and its per-workspace part, as the model got them in a turn of Alice's. */
async function promptOfATurn(): Promise<{ head: string; workspace: string }> {
  let seen: TranscriptContext["messages"][] = [];
  script(context => {
    seen.push(structuredClone(normalizeContext(context as Context).messages));
    return done();
  });
  await inTeam(async team => {
    await team.asAlice.newChat("Hello.", "faux-model");
    await settled(team);
  });
  expect(seen).toHaveLength(1);
  let system = getInitialSystemMessage(seen[0])!;
  return { head: String(system.content), workspace: Object.values(system.sections ?? {}).join("\n") };
}

describe("what the agent is told of turn-end accept", { timeout: 90_000 }, () => {
  it("adds its section, word for word, after the admin's instructions while the switch is on", async () => {
    turnEndAccept(true, "Answer in French.");
    let { head, workspace } = await promptOfATurn();

    expect(head).toContain(`<deployment_instructions>\nAnswer in French.\n\n${SECTION}\n</deployment_instructions>`);
    expect(head.split("When your changes go live")).toHaveLength(2);
    expect(workspace).not.toContain("When your changes go live");
  });

  it("gives the section alone when the admin wrote no instructions", async () => {
    turnEndAccept(true);
    let { head } = await promptOfATurn();

    expect(head).toContain(`<deployment_instructions>\n${SECTION}\n</deployment_instructions>`);
  });

  it("tells every workspace the same, so the shared prompt cache holds", async () => {
    turnEndAccept(true, "Answer in French.");
    let first = await promptOfATurn();
    let second = await promptOfATurn();

    expect(first.head).toContain(SECTION);
    expect(second.head).toBe(first.head);
    expect(second.workspace).not.toBe(first.workspace);
  });

  for (let [name, on] of [["unset", undefined], ["off", false]] as const) {
    it(`never says that nobody clicks Accept with the switch ${name}`, async () => {
      turnEndAccept(on, "Answer in French.");
      let { head } = await promptOfATurn();

      expect(head).toContain("<deployment_instructions>\nAnswer in French.\n</deployment_instructions>");
      expect(head).not.toContain("When your changes go live");
      expect(head).not.toContain("nobody clicks Accept");
    });
  }
});
