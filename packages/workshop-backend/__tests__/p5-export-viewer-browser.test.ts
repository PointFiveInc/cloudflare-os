import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { UserDurableObject } from "../src/user.js";

const launch = vi.hoisted(() => vi.fn());
vi.mock("@cloudflare/puppeteer", () => ({ launch }));

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const CHAT = 1;
const GADGET = 100;

async function signedIn(id: string, name: string): Promise<string> {
  let user = env.TEST_USER.getByName(id);
  await user.createAccount(id, name, new Uint8Array(32));
  return user.id.toString();
}

describe("a browser export the agent makes", () => {
  it("connects client.js to the gadget as the person whose message started the turn",
      async () => {
    let ownerId = await signedIn("olive@example.com", "Olive");
    let askerId = await signedIn("ben@example.com", "Ben");
    let browser = {};
    launch.mockRejectedValue(new Error("No browser in this test."));

    let stub = env.TEST_OVERSEER.getByName("p5-export-viewer-browser");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      impl.ownerId = ownerId;
      impl.env = { ...impl.env, BROWSER: browser };
      impl.storage.title.put("Studio");
      impl.storage.chatMeta.put(
          { id: CHAT, title: "Chat", started: new Date(0), lastActive: new Date(0) });
      let commitId = await impl.gitStore.writeFilesAsCommit(new Map([
        ["server.js", `import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {}
`],
        ["client.js", `document.body.textContent = "Board";\n`],
      ]), {
        parents: [],
        author: { name: "Olive", email: "olive@example.com" },
        message: "test commit",
        timestamp: new Date(1700000000_000),
      });
      impl.storage.gadgets.put({
        type: "gadget", id: GADGET, title: "Board", created: new Date(0), bindingName: "BOARD",
        bindings: {}, commitId,
      });
      impl.storage.activeAgents.put({
        chatId: CHAT, initiatorUserId: askerId, modelId: "model", callbackInitiated: false,
        initiator: { type: "user", id: "ben@example.com", name: "Ben" },
      });
      let facets = vi.spyOn(impl, "getGadgetFacet");

      let exports = await impl.startGatekeeperSession(
          { type: "exports", id: GADGET }, { from: "agent", chatId: CHAT });
      let failure: unknown;
      try { await exports.export("pdf"); } catch (err) { failure = err; }

      expect(String(failure)).toContain("No browser in this test.");
      expect(launch).toHaveBeenCalledWith(browser);
      expect(facets).toHaveBeenLastCalledWith(
          GADGET, CHAT, undefined, { id: "ben@example.com", name: "Ben", role: "build" });
    });
  });
});
