import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, getCurrentSystemPrompt, getCurrentTools,
  getInitialSystemMessage, normalizeContext, type Context,
} from "@earendil-works/pi-ai";
import type { AiChatAuthorInfo, AiChatMessage, AiToolCall } from "@gadgets/workshop-shared/api";
import { runAgent } from "../src/agent";
import { GatekeeperLoopback } from "../src/overseer.js";
import { P5_PEOPLE_WITH_ACCESS_GUIDANCE, p5DescribePeopleWithAccess } from "../src/p5-people-with-access";
import { inWorkspace, signedIn, type Person, type Workspace } from "./p5-workspace.js";

// The test pool serves a WorkerEntrypoint's RPC only for methods its class's prototype declares, while workerd serves
// the loopback's Proxy. Forward list() to the Proxy the same way.
beforeAll(() => {
  Object.defineProperty(GatekeeperLoopback.prototype, "list", {
    configurable: true,
    value(this: object, ...args: unknown[]) {
      return (Reflect.get(this, "list") as (...args: unknown[]) => unknown)(...args);
    },
  });
});
afterAll(() => {
  delete (GatekeeperLoopback.prototype as any).list;
});

const BOARD = `
import { DurableObject, RpcTarget } from "cloudflare:workers";

export class Gadget extends DurableObject {
  people() {
    return this.env.PEOPLE_WITH_ACCESS.list();
  }

  connectViewer(viewer) {
    return new Session(this, viewer);
  }
}

class Session extends RpcTarget {
  constructor(gadget, viewer) {
    super();
    this.gadget = gadget;
    this.viewer = viewer;
  }

  whoami() {
    return this.viewer;
  }

  people() {
    return this.gadget.people();
  }
}
`;

async function board(workspace: Workspace): Promise<number> {
  let commitId = await workspace.impl.gitStore.writeFilesAsCommit(new Map([["server.js", BOARD]]), {
    parents: [],
    author: { name: "Olga", email: "olga@example.com" },
    message: "Board",
    timestamp: new Date(1700000000_000),
  });
  let id = workspace.impl.allocateWorkpieceId();
  workspace.impl.storage.gadgets.put({
    type: "gadget", id, title: "Board", created: new Date(0), bindingName: "BOARD", bindings: {}, commitId,
  });
  return id;
}

function withAccess({ profile }: Person, role: "owner" | "build" | "use") {
  return { id: profile.id, name: profile.name, role };
}

type DescribeCall = Extract<AiToolCall, { toolName: "describeBinding" }>;

const ASKER: AiChatAuthorInfo = { type: "user", id: "olga@example.com", name: "Olga Owner" };

type Turn = { records: AiChatMessage[]; head: string; prompt: string; tools: string[] };

/**
 * One scripted agent turn in chat 1 of a bare overseer, after `seed`: the chat's records, and its first request's
 * system prompt (the fixed head, and whole) and tools.
 */
async function agentTurn(seed: (impl: any) => void, steps: ReturnType<typeof fauxAssistantMessage>[]): Promise<Turn> {
  return await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.storage.chatMeta.put({ id: 1, title: "Chat", started: new Date(0), lastActive: new Date(0) });
    impl.storage.chats.put({
      chatId: 1, sequence: impl.nextChatSequence(1), timestamp: new Date(0), author: ASKER, type: "message",
      message: "Hi",
    });
    seed(impl);
    let requests: ReturnType<typeof normalizeContext>["messages"][] = [];
    let faux = createFauxCore({ models: [{ id: "faux-model" }] });
    faux.setResponses(steps.map(step => (context: unknown) => {
      requests.push(structuredClone(normalizeContext(context as Context).messages));
      return step;
    }));
    await runAgent(impl, { model: faux.getModel(), stream: faux.stream }, 1,
        { type: "agent", id: "faux-model", name: "Faux" }, new AbortController().signal, ASKER,
        { provider: "cloudflare", model: "faux-model", apiToken: "" } as any);
    let head = getInitialSystemMessage(requests[0])?.content;
    return {
      records: [...impl.storage.chats.list()] as AiChatMessage[],
      head: typeof head === "string" ? head : "",
      prompt: getCurrentSystemPrompt(requests[0]),
      tools: getCurrentTools(requests[0]).map(tool => tool.name),
    };
  });
}

/** One agent turn whose model calls `describeBinding` with `input`: what the call returned, or its error. */
async function described(input: { gadget: string; name: string }): Promise<string | undefined> {
  let { records } = await agentTurn(impl => {
    impl.describeGatekeeper = async (name: string, gatekeeper: { id: number }) =>
        `${name} is gatekeeper ${gatekeeper.id}`;
    impl.storage.gatekeepers.put({ id: 1, resourceTitle: "Conn", class: {} });
    impl.storage.gadgets.put({
      type: "gadget", id: 100, title: "Plain", created: new Date(0), bindingName: "PLAIN", bindings: {},
    });
    impl.storage.gadgets.put({
      type: "gadget", id: 101, title: "Own", created: new Date(0), bindingName: "OWN",
      bindings: { PEOPLE_WITH_ACCESS: { target: 1 } },
    });
  }, [
    fauxAssistantMessage([fauxToolCall("describeBinding", input)], { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("Done.")),
  ]);
  let [call] = records
      .flatMap(message => message.type === "message" ? message.toolCalls ?? [] : [])
      .filter((toolCall): toolCall is DescribeCall => toolCall.toolName === "describeBinding");
  return call?.output ?? call?.error;
}

function times(text: string, part: string): number {
  return text.split(part).length - 1;
}

describe("a gadget's people with access", () => {
  it("lists the owner first, then each Workspace and Gadget only person at their role", async () => {
    let olga = await signedIn("Olga Owner");
    let bea = await signedIn("Bea Builder");
    let uri = await signedIn("Uri User");
    await inWorkspace(olga, async workspace => {
      workspace.switchOn();
      workspace.share(bea, "build");
      workspace.share(uri, "use");
      let id = await board(workspace);

      using gadget = await workspace.impl.getGadgetFacet(id);
      expect(await gadget.people()).toEqual([withAccess(olga, "owner"), withAccess(bea, "build"), withAccess(uri, "use")]);
    });
  });

  it("reads at each call: a person shared later is listed at the next call, and a removed one drops out", async () => {
    let olga = await signedIn("Olga Owner");
    let bea = await signedIn("Bea Builder");
    let uri = await signedIn("Uri User");
    await inWorkspace(olga, async workspace => {
      workspace.switchOn();
      workspace.share(bea, "build");
      let id = await board(workspace);
      using gadget = await workspace.impl.getGadgetFacet(id);

      let before = await gadget.people();
      workspace.share(uri, "use");
      let shared = await gadget.people();
      (await workspace.impl.getSharingManager())
          .removeCollaborator({ profileId: olga.profile.id, isOwner: true }, bea.profile.id, []);
      let removed = await gadget.people();

      expect({ before, shared, removed }).toEqual({
        before: [withAccess(olga, "owner"), withAccess(bea, "build")],
        shared: [withAccess(olga, "owner"), withAccess(bea, "build"), withAccess(uri, "use")],
        removed: [withAccess(olga, "owner"), withAccess(uri, "use")],
      });
    });
  });

  it("reaches a Gadget only person on their own connection, whose viewer is theirs at use", async () => {
    let olga = await signedIn("Olga Owner");
    let bea = await signedIn("Bea Builder");
    let uri = await signedIn("Uri User");
    await inWorkspace(olga, async workspace => {
      workspace.switchOn();
      workspace.share(bea, "build");
      workspace.share(uri, "use");
      let id = await board(workspace);

      using client = await workspace.open(uri);
      using gadget: any = await client.getGadget(id);
      using connection: any = await gadget.connectToGadget();
      expect({ viewer: await connection.whoami(), people: await connection.people() }).toEqual({
        viewer: withAccess(uri, "use"),
        people: [withAccess(olga, "owner"), withAccess(bea, "build"), withAccess(uri, "use")],
      });
    });
  });

  it("is absent with the switch off, sits beneath a gadget's own binding of that name, and never in the agent's env",
      async () => {
    let olga = await signedIn("Olga Owner");
    await inWorkspace(olga, async workspace => {
      let { impl } = workspace;
      impl.makeBindingLoopback = (target: unknown) => target;
      impl.storage.gatekeepers.put({ id: 1, resourceTitle: "Conn", class: {} });
      impl.storage.gadgets.put({
        type: "gadget", id: 100, title: "Plain", created: new Date(0), bindingName: "PLAIN", bindings: {},
      });
      impl.storage.gadgets.put({
        type: "gadget", id: 101, title: "Own", created: new Date(0), bindingName: "OWN",
        bindings: { PEOPLE_WITH_ACCESS: { target: 1 } },
      });
      let off = impl.getEnvForLoader(100, { from: "gadget", gadgetId: 100 });

      workspace.switchOn();
      expect({
        off: "PEOPLE_WITH_ACCESS" in off,
        plain: impl.getEnvForLoader(100, { from: "gadget", gadgetId: 100 }).PEOPLE_WITH_ACCESS,
        own: impl.getEnvForLoader(101, { from: "gadget", gadgetId: 101 }).PEOPLE_WITH_ACCESS,
        agent: "PEOPLE_WITH_ACCESS" in impl.getEnvForAgent(1, {}, "exec-1"),
      }).toEqual({
        off: false,
        plain: { type: "p5PeopleWithAccess" },
        own: { type: "gatekeeper", id: 1 },
        agent: false,
      });
    });
  });

  it("is what the agent's describeBinding says of a gadget's PEOPLE_WITH_ACCESS", async () => {
    let text = await described({ gadget: "PLAIN", name: "PEOPLE_WITH_ACCESS" });

    expect(text).toBe(p5DescribePeopleWithAccess("env.PEOPLE_WITH_ACCESS (in gadget PLAIN's env)"));
    expect(text).toContain("list(): Promise<{ id: string; name: string; role: \"owner\" | \"build\" | \"use\" }[]>;");
  });

  it("gives way in describeBinding to a gadget's own binding of that name", async () => {
    expect(await described({ gadget: "OWN", name: "PEOPLE_WITH_ACCESS" }))
        .toBe("env.PEOPLE_WITH_ACCESS (in gadget OWN's env) is gatekeeper 1");
  });

  it("is told once to the building agent, in its prompt's fixed head, and never to a spawned agent", async () => {
    let done = [fauxAssistantMessage(fauxText("Done."))];
    let building = await agentTurn(() => {}, done);
    let spawned = await agentTurn(impl => impl.storage.chatContext.put({
      chatId: 1, spawnerConfig: { displayName: "Spawner", modelId: "m", env: {} }, bindings: {},
    }), done);

    expect({
      building: {
        head: times(building.head, `\n\n${P5_PEOPLE_WITH_ACCESS_GUIDANCE}`),
        prompt: times(building.prompt, "# People with access"),
        createsGadgets: building.tools.includes("createGadget"),
      },
      spawned: {
        prompt: times(spawned.prompt, "# People with access"),
        createsGadgets: spawned.tools.includes("createGadget"),
      },
    }).toEqual({
      building: { head: 1, prompt: 1, createsGadgets: true },
      spawned: { prompt: 0, createsGadgets: false },
    });
  });
});
