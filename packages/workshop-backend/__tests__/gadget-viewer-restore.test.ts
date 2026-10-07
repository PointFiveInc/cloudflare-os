// Work a viewer starts from their UI connection can outlive it: a method on the session a gadget's
// `connectViewer()` returned mints a persistent callback with the Gadget's own `ctx.restore()` --
// the callback a schedule registration takes -- and the callback still runs, as the viewer's job,
// once their connection has closed. Holders of the Gadget's other stubs (the agent's executeCode,
// another gadget's binding) never get a session: they reach the Gadget itself, with no viewer.
//
// Runs a real gadget, loaded from a real commit, inside a real OverseerDurableObject.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";
import { openFakeOverseer } from "./fixtures.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const GADGET_ID = 1;

// startJob() lives on the viewer's session alone; the callback it mints carries the viewer's id as
// restore params, the only form in which it survives the connection.
const SERVER_JS = `
import { DurableObject, RpcTarget, restore } from "cloudflare:workers";

export class Gadget extends DurableObject {
  connectViewer(viewer) {
    return new ViewerSession(this, viewer);
  }

  hello() {
    return "hi";
  }

  lastLeft() {
    return this.ctx.storage.kv.get("lastLeft") ?? null;
  }

  runs() {
    return this.ctx.storage.kv.get("runs") ?? [];
  }

  [restore](params) {
    if (params.type !== "job") throw new TypeError("unknown restore type");
    return new Job(this.ctx.storage, params);
  }
}

class ViewerSession extends RpcTarget {
  constructor(gadget, viewer) {
    super();
    this.gadget = gadget;
    this.viewer = viewer;
  }

  startJob(tag) {
    return this.gadget.ctx.restore({ type: "job", tag, requestedBy: this.viewer.id });
  }

  [Symbol.dispose]() {
    this.gadget.ctx.storage.kv.put("lastLeft", this.viewer.id);
  }
}

class Job extends RpcTarget {
  constructor(storage, params) {
    super();
    this.storage = storage;
    this.params = params;
  }

  onSchedule(firing) {
    let runs = this.storage.kv.get("runs") ?? [];
    runs.push({ tag: this.params.tag, requestedBy: this.params.requestedBy, runId: firing.runId });
    this.storage.kv.put("runs", runs);
  }
}
`;

const FIRING = {
  scheduleId: "schedule-1", runId: "run-1", scheduledTime: 0, actualTime: 0, timeZone: "UTC",
};

// Await a stub call's rejection with a single handler (see gadget-viewer.test.ts).
async function expectRejection(call: Promise<unknown>, message: string): Promise<void> {
  let caught: unknown;
  let rejected = false;
  try { await call; } catch (err) { rejected = true; caught = err; }
  expect(rejected).toBe(true);
  expect(String(caught)).toContain(message);
}

let doCounter = 0;

async function withGadget(fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`gadget-viewer-restore-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let commitId = await impl.gitStore.writeFilesAsCommit(new Map([["server.js", SERVER_JS]]), {
      parents: [],
      author: { name: "Alice", email: "alice@example.com" },
      message: "test commit",
      timestamp: new Date(1700000000_000),
    });
    impl.storage.gadgets.put({
      type: "gadget", id: GADGET_ID, title: "G", created: new Date(0), bindingName: "G",
      bindings: {}, commitId,
    });
    await fn(impl);
  });
}

// The owner's Workshop session over `impl`; openFakeOverseer's "build" client is the owner.
function openAsOwner(impl: any) {
  return openFakeOverseer({}, { impl: {
    getGadgetRecord: (id: number) => impl.getGadgetRecord(id),
    getGadgetFacet: (...args: unknown[]) => impl.getGadgetFacet(...args),
    recordGadgetAnalytics: () => {},
    users: {
      idFromString: (id: string) => id,
      get: () => ({
        id: { toString: () => "ada-user-do" },
        whoami: async () => ({ type: "user", id: "ada@example.com", name: "Ada" }),
        recordSharedGadgetOpen: async () => {},
      }),
    },
  } });
}

describe("a gadget viewer's session", () => {
  it("mints a persistent callback that runs after the viewer's connection closes",
      () => withGadget(async impl => {
    let client = await openAsOwner(impl);
    using gadget = await client.getGadget(GADGET_ID);
    let connection: any = await gadget.connectToGadget();
    {
      using job = await connection.startJob("brief");
      // Kept the way the Scheduler keeps a registered callback: written to storage.
      await impl.ctx.storage.put("job", job);
    }
    connection[Symbol.dispose]();

    {
      using owner = await impl.getGadgetFacet(GADGET_ID);
      await expect.poll(() => owner.lastLeft()).toBe("ada@example.com");
    }
    // A schedule fires long after the gadget that minted it has stopped.
    impl.ctx.facets.abort(impl.gadgetFacetName(GADGET_ID), new Error("Gadget stopped."));

    using restored = await impl.ctx.storage.get("job");
    await restored.onSchedule(FIRING);
    using owner = await impl.getGadgetFacet(GADGET_ID);
    expect(await owner.runs())
        .toEqual([{ tag: "brief", requestedBy: "ada@example.com", runId: "run-1" }]);
  }));

  it.each([
    ["the agent's executeCode", { from: "agent", chatId: 1 }],
    ["another gadget's binding", { from: "gadget", gadgetId: 2 }],
  ] as const)("is never opened for %s, which reaches the Gadget with no viewer",
      (_who, caller) => withGadget(async impl => {
    using bound = await impl.startGatekeeperSession({ type: "gadget", id: GADGET_ID }, caller);
    await expectRejection(bound.connectViewer({ id: "ada@example.com", name: "Ada",
        role: "owner" }), "reserved for the Workshop");
    expect(await bound.hello()).toBe("hi");
    await expectRejection(bound.startJob("brief"), 'does not implement the method "startJob"');
  }));
});
