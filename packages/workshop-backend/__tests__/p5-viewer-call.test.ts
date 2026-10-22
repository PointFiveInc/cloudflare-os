import { describe, expect, it, vi } from "vitest";
import { RpcSession } from "capnweb";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import { receiveFromBrowser, sendToBrowser, waitForClientModule } from "../src/generated/browser-export-page.js";
import { inWorkspace, signedIn, type Person, type Workspace } from "./p5-workspace.js";

const launch = vi.hoisted(() => vi.fn());
vi.mock("@cloudflare/puppeteer", () => ({ launch }));

const SESSION = `
import { RpcTarget } from "cloudflare:workers";

export class Session extends RpcTarget {
  constructor(viewer) {
    super();
    this.viewer = viewer;
  }

  whoami() {
    return this.viewer;
  }

  hello() {
    return "hi, " + this.viewer.name;
  }
}
`;

const ASKED_UNDER_ANOTHER_NAME = `
import { DurableObject } from "cloudflare:workers";
import { Session } from "./session.js";

const ASK = ["connect", "Viewer"].join("");

export class Gadget extends DurableObject {
  [ASK](viewer) {
    this.ctx.storage.kv.put("asked", this.asked() + 1);
    return new Session(viewer);
  }

  asked() {
    return this.ctx.storage.kv.get("asked") ?? 0;
  }

  hello() {
    return "hi";
  }
}
`;

const NAMED_IN_SERVER = `
import { DurableObject } from "cloudflare:workers";
import { Session } from "./session.js";

export class Gadget extends DurableObject {
  connectViewer(viewer) {
    return new Session(viewer);
  }

  hello() {
    return "hi";
  }
}
`;

const NAMED_IN_IMPORT = {
  "server.js": `
import { Viewed } from "./viewed.js";

export class Gadget extends Viewed {
  hello() {
    return "hi";
  }
}
`,
  "viewed.js": `
import { DurableObject } from "cloudflare:workers";
import { Session } from "./session.js";

export class Viewed extends DurableObject {
  connectViewer(viewer) {
    return new Session(viewer);
  }
}
`,
};

const RENDERS_ITS_VIEWER = `document.body.textContent = JSON.stringify(await gadget.whoami());
`;

async function gadgetFrom(workspace: Workspace, files: Record<string, string>): Promise<number> {
  let commitId = await workspace.impl.gitStore.writeFilesAsCommit(
      new Map(Object.entries({ "session.js": SESSION, ...files })), {
        parents: [],
        author: { name: "Olive", email: "olive@example.com" },
        message: "Board",
        timestamp: new Date(1700000000_000),
      });
  let id = workspace.impl.allocateWorkpieceId();
  workspace.impl.storage.gadgets.put({
    type: "gadget", id, title: "Board", created: new Date(0), bindingName: "BOARD", bindings: {}, commitId,
  });
  return id;
}

function newChat(workspace: Workspace): number {
  let id = workspace.impl.nextChatId();
  workspace.impl.storage.chatMeta.put({ id, title: "Chat", started: new Date(0), lastActive: new Date(0) });
  return id;
}

/**
 * `person` edits the gadget's `server.js` in the chat through their own `submitCodeChange`, then loads the chat's
 * preview of it as the browser does, which records the edit.
 */
async function inDraft(workspace: Workspace, person: Person, chatId: number, gadgetId: number,
    server: { from: string; to: string }): Promise<void> {
  let serverJs = (content: string): CodeContent => new Map([[gadgetId, new Map([["server.js", content]])]]);
  using client = await workspace.open(person);
  await client.submitCodeChange(chatId, {
    generation: 0, revision: 0, clientId: crypto.randomUUID(), seq: 1,
    pins: [{ gadgetId, baseCommit: workspace.impl.storage.gadgets.get(gadgetId).commitId }],
    change: diffFiles(serverJs(server.from), serverJs(server.to)),
  });
  using gadget: any = await client.getGadget(gadgetId);
  await gadget.getUiBundle(chatId);
}

/**
 * `use` on the gadget's UI connection as `person` opens it, in the chat's preview when `chatId` is given: their real
 * `open()`, `getGadget` and `connectToGadget()`.
 */
async function onTheirConnection<T>(workspace: Workspace, person: Person, gadgetId: number,
    use: (connection: any) => Promise<T>, chatId?: number): Promise<T> {
  using client = await workspace.open(person);
  using gadget: any = await client.getGadget(gadgetId);
  using connection: any = await gadget.connectToGadget(chatId);
  return await use(connection);
}

/** What `person`'s own PDF export of the gadget's UI renders: their real `open()`, `getGadget` and `export`. */
async function inTheirExport(workspace: Workspace, person: Person, gadgetId: number): Promise<unknown> {
  using client = await workspace.open(person);
  using gadget: any = await client.getGadget(gadgetId);
  return await new Response(await gadget.export("pdf")).json();
}

class Mailbox {
  #messages: string[] = [];
  #takers: ((message: string) => void)[] = [];

  put(message: string): void {
    let taker = this.#takers.shift();
    if (taker) taker(message);
    else this.#messages.push(message);
  }

  take(): Promise<string> {
    let message = this.#messages.shift();
    return message === undefined ? new Promise(resolve => this.#takers.push(resolve)) : Promise.resolve(message);
  }
}

/**
 * The export's browser. Its page opens a Cap'n Web session with the gadget over the page's messages, as the
 * Workshop's export runtime does, and runs `client` on it in client.js's place: the export is what `client` renders.
 */
function browserRendering(client: (gadget: any) => Promise<string>) {
  let toBrowser = new Mailbox();
  let toWorker = new Mailbox();
  let gadget: any;
  let rendered: Promise<string> | undefined;
  let closed: (() => void) | undefined;
  let page = {
    emulateMediaType: async () => {},
    setRequestInterception: async () => {},
    on(event: string, handler: () => void) {
      if (event === "close") closed = handler;
    },
    async goto() {
      gadget = new RpcSession<any>({
        send: async message => toWorker.put(message),
        receive: () => toBrowser.take(),
      }).getRemoteMain();
    },
    async evaluate(fn: unknown, message?: string) {
      if (fn === sendToBrowser) toBrowser.put(message!);
      else if (fn === receiveFromBrowser) return await toWorker.take();
      else if (fn === waitForClientModule) await (rendered = client(gadget));
    },
    mainFrame: () => ({ isolatedRealm: () => ({ evaluate: async () => {} }) }),
    createPDFStream: async () => new Response(await rendered).body,
  };
  return { newPage: async () => page, close: async () => closed?.() };
}

function viewerOf({ profile }: Person, role: "owner" | "build" | "use") {
  return { id: profile.id, name: profile.name, role };
}

describe("who is viewing a gadget", () => {
  it("is not asked of a gadget none of whose files names connectViewer, and its UI calls reach it", async () => {
    let olive = await signedIn("Olive Owner");
    let uma = await signedIn("Uma Gadget");
    await inWorkspace(olive, async workspace => {
      workspace.share(uma, "use");
      let board = await gadgetFrom(workspace, { "server.js": ASKED_UNDER_ANOTHER_NAME });

      let replies: string[] = [];
      for (let person of [olive, uma]) {
        replies.push(await onTheirConnection(workspace, person, board, connection => connection.hello()));
      }
      using gadget = await workspace.impl.getGadgetFacet(board);
      expect({ replies, asked: await gadget.asked() }).toEqual({ replies: ["hi", "hi"], asked: 0 });
    });
  });

  it("is asked of a gadget whose server.js names connectViewer, whose session serves the calls", async () => {
    let olive = await signedIn("Olive Owner");
    await inWorkspace(olive, async workspace => {
      let board = await gadgetFrom(workspace, { "server.js": NAMED_IN_SERVER });

      expect(await onTheirConnection(workspace, olive, board, async connection =>
        [await connection.whoami(), await connection.hello()],
      )).toEqual([viewerOf(olive, "owner"), "hi, Olive Owner"]);
    });
  });

  it("is asked of a gadget that names connectViewer only in a module it imports", async () => {
    let olive = await signedIn("Olive Owner");
    let uma = await signedIn("Uma Gadget");
    await inWorkspace(olive, async workspace => {
      workspace.share(uma, "use");
      let board = await gadgetFrom(workspace, NAMED_IN_IMPORT);

      expect(await onTheirConnection(workspace, uma, board, connection => connection.whoami()))
          .toEqual(viewerOf(uma, "use"));
    });
  });

  it("is asked of a chat draft naming connectViewer in that chat's preview, not of the accepted version", async () => {
    let olive = await signedIn("Olive Owner");
    await inWorkspace(olive, async workspace => {
      let board = await gadgetFrom(workspace, { "server.js": ASKED_UNDER_ANOTHER_NAME });
      let chatId = newChat(workspace);
      await inDraft(workspace, olive, chatId, board, { from: ASKED_UNDER_ANOTHER_NAME, to: NAMED_IN_SERVER });

      expect({
        preview: await onTheirConnection(workspace, olive, board, connection => connection.whoami(), chatId),
        accepted: await onTheirConnection(workspace, olive, board, connection => connection.hello()),
      }).toEqual({ preview: viewerOf(olive, "owner"), accepted: "hi" });
    });
  });

  it("is asked of the version its gadget runs, on a connection opened in a chat before the chat drafts it", async () => {
    let olive = await signedIn("Olive Owner");
    await inWorkspace(olive, async workspace => {
      let board = await gadgetFrom(workspace, { "server.js": NAMED_IN_SERVER });
      let chatId = newChat(workspace);

      expect(await onTheirConnection(workspace, olive, board, async connection => {
        await inDraft(workspace, olive, chatId, board, { from: NAMED_IN_SERVER, to: ASKED_UNDER_ANOTHER_NAME });
        return await connection.whoami();
      }, chatId)).toEqual(viewerOf(olive, "owner"));
    });
  });

  it("is a \"Workspace\" colleague at build, on their own connection and in their own export of the gadget's UI",
      async () => {
    let olive = await signedIn("Olive Owner");
    let bea = await signedIn("Bea Workspace");
    await inWorkspace(olive, async workspace => {
      workspace.share(bea, "build");
      let board = await gadgetFrom(workspace, { "server.js": NAMED_IN_SERVER, "client.js": RENDERS_ITS_VIEWER });
      workspace.impl.env = { ...workspace.impl.env, BROWSER: {} };
      launch.mockResolvedValue(browserRendering(async gadget => JSON.stringify(await gadget.whoami())));

      expect({
        connection: await onTheirConnection(workspace, bea, board, connection => connection.whoami()),
        export: await inTheirExport(workspace, bea, board),
      }).toEqual({ connection: viewerOf(bea, "build"), export: viewerOf(bea, "build") });
    });
  });
});
