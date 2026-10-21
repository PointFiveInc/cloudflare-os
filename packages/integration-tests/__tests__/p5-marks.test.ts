import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AuthenticatedApi, GadgetMetadataWithTimestamps } from "@gadgets/workshop-shared/api";
import type { P5Marked } from "@gadgets/workshop-shared/p5-marks";
import { type Harness, settleRestart, startHarness } from "../src/harness.js";
import { mockChatCompletion } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp } from "../src/rpc-client.js";

let harness: Harness | undefined;
const network = new NetworkInterceptor({ handlers: [mockChatCompletion("Test chat")] });

beforeAll(async () => {
  network.install();
  harness = await startHarness({ gatekeepers: [] });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

function requireHarness(): Harness {
  if (harness === undefined) throw new Error("Workshop harness did not start");
  return harness;
}

async function listingOf(api: RpcStub<AuthenticatedApi>, workspaceId: string)
    : Promise<(GadgetMetadataWithTimestamps & P5Marked) | undefined> {
  const rows: GadgetMetadataWithTimestamps[] = await api.listGadgets();
  return rows.find(row => row.id === workspaceId);
}

it.concurrent("a share lists the workspace for the person, marked, and their open clears the mark", async () => {
  const [ownerName, recipientName] = nextUsernames("markowner", "markrecipient");
  if (!ownerName || !recipientName) throw new Error("Missing test username");
  using ownerPublic = connect(requireHarness().url);
  using recipientPublic = connect(requireHarness().url);
  using owner = await signUp(ownerPublic, ownerName, "Izzy Owner");
  using recipient = await signUp(recipientPublic, recipientName, "Akiva Recipient");
  using workspace = await owner.newGadget();
  const { id } = await workspace.getMetadata();
  await workspace.newChat("Make this workspace visible without an agent", null);
  expect(await listingOf(recipient, id)).toBeUndefined();

  expect(await workspace.addCollaborator(recipientName, "build")).toMatchObject({ role: "build" });
  expect(await listingOf(recipient, id)).toMatchObject({
    role: "build", owner: { id: ownerName }, p5Mark: { kind: "share", by: "Izzy Owner" },
  });
  expect((await listingOf(owner, id))?.p5Mark).toBeUndefined();

  using _opened = await recipient.openGadget(id);
  const opened = await listingOf(recipient, id);
  expect(opened).toMatchObject({ role: "build", owner: { id: ownerName } });
  expect(opened?.p5Mark).toBeUndefined();
});

it.concurrent("the owner's delete takes the workspace off the list of someone who never opened it", async () => {
  const [ownerName, recipientName] = nextUsernames("deleteowner", "deleterecipient");
  if (!ownerName || !recipientName) throw new Error("Missing test username");
  using ownerPublic = connect(requireHarness().url);
  using recipientPublic = connect(requireHarness().url);
  using owner = await signUp(ownerPublic, ownerName, "Izzy Owner");
  using recipient = await signUp(recipientPublic, recipientName, "Akiva Recipient");
  using workspace = await owner.newGadget();
  const { id } = await workspace.getMetadata();
  await workspace.newChat("Make this workspace visible without an agent", null);
  await workspace.addCollaborator(recipientName, "use");
  expect(await listingOf(recipient, id)).toMatchObject({ role: "use", p5Mark: { kind: "share" } });

  await workspace.deleteSelf();
  expect(await listingOf(recipient, id)).toBeUndefined();
  await settleRestart();
});
