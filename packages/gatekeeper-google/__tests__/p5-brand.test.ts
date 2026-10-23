import { describe, expect, it, vi } from "vitest";
import google, { GatekeeperVendor } from "../src/google";

vi.mock("cloudflare:workers", () => {
  class Entrypoint {
    constructor(public ctx: unknown, public env: unknown) {}
  }
  return {
    WorkerEntrypoint: Entrypoint, DurableObject: Entrypoint, RpcTarget: Entrypoint, RpcStub: Entrypoint,
    restore: Symbol("restore"),
  };
});

vi.mock("capnweb-validate", () => ({
  validateRpc: () => () => undefined,
  skipRpcValidation: () => () => undefined,
}));

const CLOUDFLARE_OS = /cloudflare(?:\s|&nbsp;)*os/i;
const BASE_URL = "https://os.example/gatekeeper/google";
const CONNECT_LINK = `${BASE_URL}/${"0123456789abcdef".repeat(4)}/${"ab".repeat(32)}`;
const SPENT_LINK_CTX = {
  exports: {
    UserAccount: { idFromString: (id: string) => id, get: () => ({ beginOAuthFlow: async () => null }) },
  },
} as unknown as ExecutionContext;

async function connectPage(env: Record<string, string>): Promise<string> {
  const response = await google.fetch(new Request(CONNECT_LINK), env as never, SPENT_LINK_CTX);
  return response.text();
}

describe("PointFive branding in the Google gatekeeper", () => {
  it("sends the person back to PointFive OS from an expired or spent connect link", async () => {
    const html = await connectPage({ BASE_URL, CLIENT_ID: "client", CLIENT_SECRET: "secret" });
    expect(html).toContain(
      "This authorization link is invalid or has expired. Please return to PointFive OS and try again.");
    expect(html).not.toMatch(CLOUDFLARE_OS);
  });

  it("names this PointFive OS instance on the page shown without a Google client", async () => {
    const html = await connectPage({ BASE_URL });
    expect(html).toContain(
      "Please see the README.md for instructions on configuring an OAuth client ID and secret so that " +
      "this PointFive OS instance can access Google APIs.");
    expect(html).not.toMatch(CLOUDFLARE_OS);
  });

  it("gives PointFive OS access in the Connect window's description", async () => {
    const { description } = await new GatekeeperVendor({} as ExecutionContext, {} as never).describe();
    expect(description).toMatch(/^Connect your Google account to give PointFive OS access to Gmail, /);
    expect(description).not.toMatch(CLOUDFLARE_OS);
  });
});
