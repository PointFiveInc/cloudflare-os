import { beforeEach, describe, expect, it } from "vitest";
import type { AiChatAuthorInfo, AiModelConfig } from "@gadgets/workshop-shared/api";
import { getModel } from "../src/ai-models.js";

// A provider key stored on the gateway under an alias other than "default" is reachable only when
// every request names it in `cf-aig-byok-alias`; a request without the header silently falls back
// to the "default" key. Both transports and every gateway-routed provider shape are covered, since
// the header rides the shared gateway auth headers rather than any one adapter.

const INITIATOR: AiChatAuthorInfo = { type: "user", id: "user-123", name: "User" };

const PROVIDER_CONFIGS: AiModelConfig[] = [
  { provider: "anthropic", model: "claude-sonnet-4-5", apiToken: "ignored-in-gateway-mode" },
  {
    provider: "cloudflare",
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    apiToken: "ignored-in-gateway-mode",
  },
];

const sentRequests: Request[] = [];

const captureFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  sentRequests.push(new Request(input as RequestInfo, init));
  return Response.json({ error: { type: "bad_request", message: "stubbed" } }, { status: 400 });
}) as typeof fetch;

const TRANSPORTS = [
  {
    transport: "HTTPS",
    env: { CF_AI_GATEWAY_API_TOKEN: "gateway-token" },
    streamOptions: { fetch: captureFetch },
  },
  {
    transport: "Workers AI binding",
    env: { WORKERS_AI: { fetch: captureFetch } as unknown as Ai },
    streamOptions: {},
  },
];

describe.each(TRANSPORTS)("cf-aig-byok-alias over the $transport transport", (transport) => {
  beforeEach(() => {
    sentRequests.length = 0;
  });

  async function sentHeaders(config: AiModelConfig, alias: string | undefined): Promise<Headers> {
    const env = {
      CF_AI_GATEWAY: "platform-gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "gateway-account-id",
      CF_AI_GATEWAY_PROVIDERS: "anthropic,cloudflare",
      CF_AI_GATEWAY_BYOK_ALIAS: alias,
      ...transport.env,
    } as Cloudflare.Env;
    const handle = getModel(env, config, INITIATOR);
    const message = await handle.stream(handle.model, {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
    }, { ...transport.streamOptions, maxRetries: 0 }).result();
    expect(message.stopReason).toBe("error");
    expect(sentRequests).toHaveLength(1);
    return sentRequests[0].headers;
  }

  it.each(PROVIDER_CONFIGS)("names the configured alias on $provider requests", async (config) => {
    const headers = await sentHeaders(config, "pointfive-os");
    expect(headers.get("cf-aig-byok-alias")).toBe("pointfive-os");
  }, 15000);

  it.each(PROVIDER_CONFIGS)("sends no alias on $provider requests when none is configured",
      async (config) => {
        for (const alias of [undefined, ""]) {
          sentRequests.length = 0;
          const headers = await sentHeaders(config, alias);
          expect(headers.has("cf-aig-byok-alias")).toBe(false);
        }
      }, 15000);
});
