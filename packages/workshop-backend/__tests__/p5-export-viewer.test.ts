import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const CHAT = 1;
const GADGET = 100;

type Person = { profile: AiChatAuthorInfo; userId: string };
type Rendered = { gadgetId: number; formatId: string; chatId?: number; viewer: unknown };

let counter = 0;

async function signedIn(name: string): Promise<Person> {
  let id = `${name.toLowerCase()}-${++counter}@example.com`;
  let user = env.TEST_USER.getByName(id);
  await user.createAccount(id, name, new Uint8Array(32));
  return { profile: { type: "user", id, name }, userId: user.id.toString() };
}

// Opens the agent's `exports` binding for GADGET in CHAT before any turn runs, and records the
// viewer each export reaches the overseer's export pipeline with.
async function inWorkspace(owner: Person,
    fn: (impl: any, exportNow: () => Promise<Rendered>) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`p5-export-viewer-${++counter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerId = owner.userId;
    impl.storage.title.put("Studio");
    impl.storage.chatMeta.put(
        { id: CHAT, title: "Chat", started: new Date(0), lastActive: new Date(0) });
    impl.storage.gadgets.put(
        { type: "gadget", id: GADGET, title: "Board", created: new Date(0), bindingName: "BOARD" });
    let rendered: Rendered[] = [];
    impl.exportGadget = async (gadgetId: number, formatId: string, chatId: number | undefined,
        viewer: unknown) => {
      rendered.push({ gadgetId, formatId, chatId, viewer });
      return new ReadableStream();
    };
    let exports = await impl.startGatekeeperSession(
        { type: "exports", id: GADGET }, { from: "agent", chatId: CHAT });
    await fn(impl, async () => {
      await exports.export("pdf");
      return rendered.at(-1)!;
    });
  });
}

function turnStartedBy(impl: any, initiator: AiChatAuthorInfo, account: Person): void {
  impl.storage.activeAgents.put({
    chatId: CHAT, initiatorUserId: account.userId, modelId: "model", initiator,
    callbackInitiated: false,
  });
}

function renderedFor({ profile }: Person, role: "owner" | "build"): Rendered {
  return {
    gadgetId: GADGET, formatId: "pdf", chatId: CHAT,
    viewer: { id: profile.id, name: profile.name, role },
  };
}

describe("an export the agent makes through a gadget's exports", () => {
  it.each(["owner", "build"] as const)(
      "renders for the person whose message started the turn, as %s", async role => {
    let owner = await signedIn("Olive");
    let guest = await signedIn("Ben");
    let asker = role === "owner" ? owner : guest;
    await inWorkspace(owner, async (impl, exportNow) => {
      turnStartedBy(impl, asker.profile, asker);
      expect(await exportNow()).toEqual(renderedFor(asker, role));
    });
  });

  it("renders for the owner while no turn runs, then for the asker, read at each export",
      async () => {
    let owner = await signedIn("Olive");
    let guest = await signedIn("Ben");
    await inWorkspace(owner, async (impl, exportNow) => {
      expect(await exportNow()).toEqual(renderedFor(owner, "owner"));
      turnStartedBy(impl, guest.profile, guest);
      expect(await exportNow()).toEqual(renderedFor(guest, "build"));
    });
  });

  it("renders for the owner when a gadget started the turn", async () => {
    let owner = await signedIn("Olive");
    let guest = await signedIn("Ben");
    await inWorkspace(owner, async (impl, exportNow) => {
      turnStartedBy(impl, impl.gadgetAuthorFor(guest.profile), guest);
      expect(await exportNow()).toEqual(renderedFor(owner, "owner"));
    });
  });
});
