import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ObservationGate, type ObserverKv, type ObserverStrategy } from "@gadgets/gatekeeper-kit/observers";
import type { GatekeeperUserVerifier, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { WORKSPACE_ROLE_CAP } from "@gadgets/workshop-shared/p5-share-safety";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import { CONTEXT_OBSERVER_DENIED, contextObserverStrategy } from "../src/context-observers.js";
import { encodeDocId } from "../src/context-types.js";
import { domainName } from "../src/domain.js";
import { ContextVerifier } from "../src/library-gatekeeper.js";
import { LibraryReadSession } from "../src/library-read.js";
import { p5ContextMaxObservers } from "../src/p5-colleagues.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";

type TestEnv = Cloudflare.Env & {
  COLLECTIONS: DurableObjectNamespace<ContextCollectionDurableObject>;
  USER_LIBRARIES: DurableObjectNamespace<UserLibraryDurableObject>;
};
const OFF = env as unknown as TestEnv;
const ON: TestEnv = { ...OFF, P5_COLLABORATION: "true" };

const NOTE = { path: "plan.md", description: "Carol's launch plan", body: "Carol's plan." };

let domains = 0;
let nextId = 0;

function makeKv(): ObserverKv {
  let map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, value),
    delete: (key: string) => map.delete(key),
    list: <T>({ prefix }: { prefix?: string } = {}) =>
      [...map.entries()].filter(([key]) => key.startsWith(prefix ?? "")) as Iterable<[string, T]>,
  } as ObserverKv;
}

/** A colleague's attempt to join the owner's workspace: "admitted", or the refusal's own words. */
async function admission(
    strategy: ObserverStrategy, id: string, verifier: Fetcher<GatekeeperUserVerifier>): Promise<string> {
  try {
    await strategy.addObserver(id, verifier);
    return "admitted";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** One sharing domain with its own collections, and a count of every verifier and Durable Object call made in it. */
function world() {
  let domain = `os-${domains++}.example`;
  let counts = { verifierCalls: 0, doCalls: 0 };
  let collection = (id: string) => OFF.COLLECTIONS.get(OFF.COLLECTIONS.idFromName(domainName(domain, id)));
  let library = (accountId: string) =>
    OFF.USER_LIBRARIES.get(OFF.USER_LIBRARIES.idFromName(domainName(domain, accountId)));

  async function privateCollection(owner: string, note?: typeof NOTE): Promise<string> {
    let id = `collection-${nextId++}`;
    let now = new Date();
    await collection(id).initialize({
      id, title: "Notes", description: "", visibility: "private",
      created: now, lastUpdated: now, documentCount: 0, content: { source: "web" },
    }, domain, owner);
    await library(owner).createOwnedCollection(id);
    if (note) await collection(id).putContextDocument(note.path, { description: note.description, body: note.body });
    return id;
  }

  /** The real verifier a colleague's Context account mints, on a fake ctx whose only storage is counted. */
  function verifierOf(accountId: string, workerEnv: TestEnv): ContextVerifier {
    let exports = {
      ContextCollectionDurableObject: {
        idFromName: (name: string) => OFF.COLLECTIONS.idFromName(name),
        get: (id: DurableObjectId) => {
          counts.doCalls++;
          return OFF.COLLECTIONS.get(id);
        },
      },
    };
    let ctx = { props: { sharingDomain: domain, accountId }, exports };
    return new ContextVerifier(ctx as unknown as ExecutionContext, workerEnv);
  }

  /** That verifier as the owner's workspace holds it, with each call counted. */
  function colleague(accountId: string, workerEnv: TestEnv): Fetcher<GatekeeperUserVerifier> {
    let verifier = verifierOf(accountId, workerEnv);
    return {
      async hasCollectionsAccess(sharingDomain: string, collectionIds: string[]) {
        counts.verifierCalls++;
        return verifier.hasCollectionsAccess(sharingDomain, collectionIds);
      },
    } as unknown as Fetcher<GatekeeperUserVerifier>;
  }

  function resetCounts() {
    counts.verifierCalls = 0;
    counts.doCalls = 0;
  }

  return { domain, counts, collection, library, privateCollection, verifierOf, colleague, resetCounts };
}

describe("a shared workspace's colleagues and the owner's private Skills collections", () => {
  it("lets a colleague of the workspace's own sharing domain see every collection with no Durable Object call, " +
      "and nobody from another domain", async () => {
    let { domain, counts, privateCollection, verifierOf } = world();
    let ids = [await privateCollection("alex"), await privateCollection("alex")];
    let dana = verifierOf("dana", ON);

    expect(await dana.hasCollectionsAccess(domain, ids)).toEqual([true, true]);
    expect(await dana.hasCollectionsAccess("elsewhere.example", ids)).toEqual([false, false]);
    expect(counts.doCalls).toBe(0);
  });

  it("keeps Cloudflare's verdicts with the switch off, one Durable Object call per collection", async () => {
    let { domain, counts, privateCollection, verifierOf } = world();
    let ids = [await privateCollection("alex"), await privateCollection("alex")];

    expect(await verifierOf("dana", OFF).hasCollectionsAccess(domain, ids)).toEqual([false, false]);
    expect(await verifierOf("alex", OFF).hasCollectionsAccess(domain, ids)).toEqual([true, true]);
    expect(counts.doCalls).toBe(4);
  });
});

describe("the observer cap and what each read of 3 private collections costs " +
    "(a regression model, not a proof of the platform's 32-invocation limit)", () => {
  it(`admits ${WORKSPACE_ROLE_CAP} colleagues with the switch on, refuses one past them, and checks each once per ` +
      "read with no Durable Object call", async () => {
    let { domain, counts, privateCollection, colleague, resetCounts } = world();
    let ids = [await privateCollection("alex"), await privateCollection("alex"), await privateCollection("alex")];
    let strategy = contextObserverStrategy(makeKv(), domain, p5ContextMaxObservers(ON));
    (await strategy.prepare!(ids)).commit();

    let outcomes: string[] = [];
    for (let n = 0; n < WORKSPACE_ROLE_CAP; n++) {
      outcomes.push(await admission(strategy, `o${n}`, colleague(`c${n}`, ON)));
    }
    expect(outcomes).toEqual(Array.from({ length: WORKSPACE_ROLE_CAP }, () => "admitted"));
    expect(await admission(strategy, "one-past", colleague("one-past", ON)))
      .toContain(`already answers for ${WORKSPACE_ROLE_CAP} collaborators`);

    resetCounts();
    let check = await strategy.prepare!(ids);
    check.commit();
    expect(check.excludeObservers).toBeUndefined();
    expect(counts).toEqual({ verifierCalls: WORKSPACE_ROLE_CAP, doCalls: 0 });
  });

  it("keeps Cloudflare's 10 with the switch off, where each read costs one Durable Object call per colleague " +
      "per collection and excludes them all", async () => {
    let { domain, counts, privateCollection, colleague, resetCounts } = world();
    let strategy = contextObserverStrategy(makeKv(), domain, p5ContextMaxObservers(OFF));
    let joined = Array.from({ length: 10 }, (_, n) => `o${n}`);

    let outcomes: string[] = [];
    for (let [n, id] of joined.entries()) outcomes.push(await admission(strategy, id, colleague(`c${n}`, OFF)));
    expect(outcomes).toEqual(joined.map(() => "admitted"));
    expect(await admission(strategy, "o10", colleague("c10", OFF))).toContain("already answers for 10 collaborators");

    let ids = [await privateCollection("alex"), await privateCollection("alex"), await privateCollection("alex")];
    resetCounts();
    let check = await strategy.prepare!(ids);
    check.discard?.();
    expect(check.excludeObservers?.toSorted()).toEqual(joined.toSorted());
    expect(counts).toEqual({ verifierCalls: 10, doCalls: 30 });
  });
});

describe("a note someone shared with the workspace's owner alone", () => {
  it("is readable by the owner's colleague with the switch on, and keeps them out with it off", async () => {
    let { domain, collection, library, privateCollection, colleague } = world();
    let note = await privateCollection("carol", NOTE);
    await collection(note).share("carol", [{ accountId: "alex", displayName: "Alex" }], "viewer");
    expect((await library("alex").listLibrary(domain, "alex")).map(entry => entry.id)).toContain(note);

    async function ownerReads(strategy: ObserverStrategy) {
      let seen: ObservationDescription[] = [];
      let authorizer = {
        async authorizeObservation(description: ObservationDescription) { seen.push(description); },
        dup() { return authorizer; },
        [Symbol.dispose]() {},
      } as unknown as ConstructorParameters<typeof ObservationGate>[0];
      using session = new LibraryReadSession(
        OFF, OFF.COLLECTIONS, OFF.USER_LIBRARIES, domain, "alex", new ObservationGate(authorizer, strategy));
      let read = await session.read(encodeDocId(note, NOTE.path));
      return { content: read?.content, excludeObservers: seen[0]?.excludeObservers };
    }

    let outcomes: Record<string, unknown> = {};
    for (let [name, workerEnv] of [["on", ON], ["off", OFF]] as const) {
      let joinedFirst = contextObserverStrategy(makeKv(), domain, p5ContextMaxObservers(workerEnv));
      let joins = await admission(joinedFirst, "dana", colleague("dana", workerEnv));
      let ownersReadWithDanaIn = await ownerReads(joinedFirst);
      let readFirst = contextObserverStrategy(makeKv(), domain, p5ContextMaxObservers(workerEnv));
      await ownerReads(readFirst);
      let opensAfterTheRead = await admission(readFirst, "dana", colleague("dana", workerEnv));
      outcomes[name] = { joins, ownersReadWithDanaIn, opensAfterTheRead };
    }

    expect(outcomes).toEqual({
      on: {
        joins: "admitted",
        ownersReadWithDanaIn: { content: NOTE.body, excludeObservers: undefined },
        opensAfterTheRead: "admitted",
      },
      off: {
        joins: "admitted",
        ownersReadWithDanaIn: { content: NOTE.body, excludeObservers: ["dana"] },
        opensAfterTheRead: CONTEXT_OBSERVER_DENIED,
      },
    });
  });
});
