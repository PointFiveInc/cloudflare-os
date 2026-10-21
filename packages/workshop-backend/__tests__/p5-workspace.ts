import { runInDurableObject } from "cloudflare:test";
import { env, exports, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { newHttpBatchRpcSession, type RpcStub } from "capnweb";
import type {
  AiChatAuthorInfo, AuthenticatedApi, CollaboratorRole, Overseer, PermissionEdge, PublicApi,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import worker from "../src/server.js";
import type { UserDurableObject } from "../src/user.js";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
      TEST_USER: DurableObjectNamespace<UserDurableObject>;
    }
  }
}

/** `user` is a fresh stub on each read: a stub made in one Durable Object's context cannot be used in another's. */
export type Person = { readonly user: DurableObjectStub<UserDurableObject>; profile: AiChatAuthorInfo; token: string };
/**
 * A connection as the Workshop stores it. One made by `newGatekeeper` keeps its resource and its resource type's real
 * `urlPattern`; an ambient one, such as Context or a wrapper kit connector, keeps only its vendor.
 */
export type Connection =
  | { vendorId: string; typeUrlPattern: string; resourceUrl: string }
  | { vendorId: string; ambient: true };
export type Workspace = {
  id: string;
  impl: any;
  open(person: Person, shareKey?: string): Promise<Overseer & Disposable>;
  share(person: Person, role: CollaboratorRole, edge?: PermissionEdge): void;
  /**
   * Stores `connection`'s record, with no gatekeeper running behind it, and returns its id. With `inGadget`, a gadget
   * binds it too, which puts it in "Gadget only" people's scope.
   */
  connect(connection: Connection, options?: { inGadget?: boolean }): number;
  /** Sets `P5_COLLABORATION` on this workspace's Overseer, as os.pointfive.co's deploy does, from here on. */
  switchOn(): void;
  /** Each restart the workspace asked for. A real one would abort the Durable Object under the test. */
  restarts: string[];
};

let people = 0;

/** A signed-in account (its User Durable Object created, as a first sign-in does). */
export async function signedIn(name: string, domain = "pointfive.co"): Promise<Person> {
  let id = `${name.split(" ")[0]!.toLowerCase()}.${++people}@${domain}`;
  let token = await env.TEST_USER.getByName(id).createAccount(id, name, new Uint8Array(32));
  return { get user() { return env.TEST_USER.getByName(id); }, profile: { type: "user", id, name }, token: token! };
}

/** An address nobody has signed in with. */
export function neverSignedIn(domain = "pointfive.co"): string {
  return `nobody.${++people}@${domain}`;
}

/**
 * A fresh workspace owned by `owner`, listed in the owner's own list: a real Overseer Durable Object, opened through
 * its real `open()`. The switch starts unset, as in Cloudflare's own tests. Returns the workspace's id.
 */
export async function inWorkspace(owner: Person, test: (workspace: Workspace) => Promise<void>): Promise<string> {
  let overseer = env.TEST_OVERSEER.getByName(crypto.randomUUID());
  let id = overseer.id.toString();
  await owner.user.newGadget(id, "Untitled Workspace");
  await owner.user.setGadgetLastActive(id, new Date(), undefined);
  await runInDurableObject(overseer, async instance => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerId = owner.user.id.toString();
    impl.storage.ownerId.put(impl.ownerId);
    impl.ensureAmbientCapsules = async () => {};
    impl.markOutputsDirty = () => {};
    impl.syncOutputsTo = async () => true;
    let restarts: string[] = [];
    impl.scheduleAccessRestart = async (reason: string) => { restarts.push(reason); };
    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    await test({
      id,
      impl,
      restarts,
      open: (person, shareKey) => instance.open(
          person.user.id.toString(), person.profile.id, notifyClosed, shareKey) as Promise<Overseer & Disposable>,
      share(person, role, edge = { type: "user", sharer: owner.profile.id, created: new Date(), role }) {
        impl.storage.collaborators.put({ profile: person.profile, addedBy: [edge] });
      },
      connect(connection, { inGadget = false } = {}) {
        let gatekeeperId = impl.allocateWorkpieceId();
        impl.storage.gatekeepers.put("ambient" in connection
          ? {
            id: gatekeeperId, resourceTitle: connection.vendorId, class: {},
            creationSpec: { type: "ambient", vendorId: connection.vendorId, accountId: 1 },
          }
          : {
            id: gatekeeperId, resourceTitle: connection.resourceUrl, resourceUrl: connection.resourceUrl, class: {},
            creationSpec: { type: "gatekeeper", ...connection },
          });
        if (inGadget) {
          let gadgetId = impl.allocateWorkpieceId();
          impl.storage.gadgets.put({
            type: "gadget", id: gadgetId, title: `Gadget ${gadgetId}`, created: new Date(),
            bindingName: `GADGET_${gadgetId}`, bindings: { [`CONNECTION_${gatekeeperId}`]: { target: gatekeeperId } },
          });
        }
        return gatekeeperId;
      },
      switchOn() {
        let switched = { ...impl.env, P5_COLLABORATION: "true" };
        impl.env = switched;
        (instance as unknown as { env: Cloudflare.Env }).env = switched;
      },
    });
  });
  return id;
}

/** `call` on the person's own API session, through the Worker's `/api` as the browser reaches it (one HTTP batch). */
export async function asThemselves<T>(
    person: Person, call: (api: RpcStub<AuthenticatedApi>) => Promise<T>): Promise<T> {
  let installed = { getByName: () => ({ ensureBundledBlueprintsInstalled: async () => true }) };
  let ctx = {
    exports: new Proxy(exports, {
      get: (target, name) => (name === "AdminSettings" ? installed : Reflect.get(target, name)),
    }),
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  };
  let workerEnv = { ...env, BLUEPRINTS: { get: async () => null } };
  let realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) =>
    worker.fetch!(new Request(input, init) as never, workerEnv as never, ctx as never);
  try {
    let api = newHttpBatchRpcSession<PublicApi>("https://os.test/api");
    return await call(api.authenticate(`${person.profile.id}:${person.token}`));
  } finally {
    globalThis.fetch = realFetch;
  }
}
