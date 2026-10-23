import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openAgentSession } from "../src/agent-session.js";
import { startHarness, type Harness } from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter, systemPromptOf } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, nextUsernames, signUp, withOwnerWorkspace, type RpcTarget,
} from "../src/rpc-client.js";
import { workshopSwitchOn } from "./p5-switch.js";

let harness: Harness;
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [], enableGadgetExecution: true, patchWorkshop: workshopSwitchOn(),
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

type PersonWithAccess = { id: string; name: string; role: string };

interface PeopleGadget extends RpcTarget {
  people(): Promise<PersonWithAccess[]>;
}

const PEOPLE_SERVER = `import { DurableObject, RpcTarget } from "cloudflare:workers";
export class Gadget extends DurableObject {
  people() { return this.env.PEOPLE_WITH_ACCESS.list(); }
  connectViewer() { return new Session(this); }
}
class Session extends RpcTarget {
  constructor(gadget) { super(); this.gadget = gadget; }
  people() { return this.gadget.people(); }
}`;

it("a gadget the agent built lists the owner and a \"Gadget only\" colleague to both of them", async () => {
  const model = models.script([
    {
      toolCalls: [
        { id: "create", name: "createGadget", arguments: { title: "People", bindingName: "PEOPLE" } },
        {
          id: "write",
          name: "writeFile",
          arguments: { workpiece: "PEOPLE", filename: "server.js", content: PEOPLE_SERVER },
        },
      ],
    },
    { text: "Built." },
  ]);
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID, userModel: model.userModel, usernamePrefix: "peopleowner",
  });
  const built = await session.runTurn("Build a gadget that lists the people with access.");
  expect(built.outcome).toEqual({ status: "completed" });
  await session.acceptChanges();
  const gadgetId = built.workpieces.find(workpiece => workpiece.title === "People")?.id;
  if (gadgetId === undefined) throw new Error("The agent did not create the gadget");

  const [colleagueName] = nextUsernames("peoplecolleague");
  if (!colleagueName) throw new Error("Missing test username");
  using colleaguePublic = connect(harness.url);
  using colleague = await signUp(colleaguePublic, colleagueName, "Uri User");
  const expected = [
    { id: session.username, name: session.username, role: "owner" },
    { id: colleagueName, name: "Uri User", role: "use" },
  ];

  const { workspaceId, ownerRead } = await withOwnerWorkspace(harness.url, session.username, async ws => {
    expect(await ws.addCollaborator(colleagueName, "use")).toMatchObject({ role: "use" });
    using gadget = await ws.getGadget(gadgetId);
    using facet = await gadget.connectToGadget() as RpcStub<PeopleGadget>;
    return { workspaceId: (await ws.getMetadata()).id, ownerRead: await facet.people() };
  });

  using shared = await colleague.openGadget(workspaceId);
  using gadget = await shared.getGadget(gadgetId);
  using facet = await gadget.connectToGadget() as RpcStub<PeopleGadget>;
  expect({ ownerRead, colleagueRead: await facet.people() })
      .toEqual({ ownerRead: expected, colleagueRead: expected });
  expect(systemPromptOf(model.requests[0]).split("# People with access")).toHaveLength(2);
});
