import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { ServerConfig } from "@gadgets/workshop-shared/api";
import {
  p5TogglesOf, type P5Toggle, type P5ToggleFlags, type P5Toggles,
} from "@gadgets/workshop-shared/p5-admin-toggles";
import { normalizeAdminConfig, parseAdminConfig, readAdminConfig } from "../src/admin-config.js";
import { AdminApiImpl, AdminSettings } from "../src/admin-settings.js";
import { getServerConfig } from "../src/deployment-config.js";
import { turnEndAcceptOn } from "../src/p5-admin-toggles.js";
import type { AdminConfig } from "../src/storage-schema/admin-settings-storage.js";
import type { UserDirectoryDurableObject } from "../src/user-directory.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER_DIRECTORY: DurableObjectNamespace<UserDirectoryDurableObject>;
  }
}

const KEYS = ["p5TurnEndAccept", "p5SimpleLook"] as const;
const BOTH_OFF: P5Toggles = { turnEndAccept: false, simpleLook: false };

let counter = 0;

/**
 * A deployment's admin settings over fresh storage, and its admin capability as `server.ts` mints
 * it. The pool binds no AdminSettings namespace, so it runs on the state of an unrelated Durable
 * Object, and the capability's stub runs each call there. `mirror` is the KV copy the Workshop reads.
 */
function deployment() {
  const stub = env.TEST_USER_DIRECTORY.getByName(`p5-admin-toggles-${++counter}`);
  const mirror = { current: null as string | null };
  const workerEnv = {
    BLUEPRINTS: {
      get: async () => mirror.current,
      put: async (_key: string, value: string) => { mirror.current = value; },
    },
  } as unknown as Cloudflare.Env;
  const inDo = <T>(f: (admin: AdminSettings) => T | Promise<T>) => runInDurableObject(
      stub, (_host, state) => f(new AdminSettings(state, workerEnv)));
  const settings = {
    updateAdminConfig: (patch: Partial<AdminConfig>) => inDo(admin => admin.updateAdminConfig(patch)),
    getAdminConfig: () => inDo(admin => admin.getAdminConfig()),
  } as unknown as DurableObjectStub<AdminSettings>;
  const api = new AdminApiImpl(settings, "admin@pointfive.co");
  /** Both switches where each reader finds them: the capability, the stored config, KV, ServerConfig. */
  const everywhere = async () => {
    let served: ServerConfig & P5ToggleFlags = await getServerConfig(workerEnv);
    return {
      api: await api.p5Toggles(),
      stored: p5TogglesOf(await inDo(admin => admin.getAdminConfig())),
      mirror: p5TogglesOf(parseAdminConfig(mirror.current)),
      server: { turnEndAccept: served.p5TurnEndAccept, simpleLook: served.p5SimpleLook },
      turnEndAcceptOn: turnEndAcceptOn(await readAdminConfig(workerEnv)),
    };
  };
  const expectEverywhere = async (toggles: P5Toggles) => {
    expect(await everywhere()).toEqual({
      api: toggles, stored: toggles, mirror: toggles, server: toggles, turnEndAcceptOn: toggles.turnEndAccept,
    });
  };
  return { api, inDo, mirror, workerEnv, expectEverywhere };
}

async function refusal(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe("the admin config's two switches", () => {
  it("leaves a config without them as Cloudflare normalizes it", () => {
    let normalized = normalizeAdminConfig({ siteName: "PointFive OS", userSearchEnabled: true });
    for (let key of KEYS) expect(key in normalized).toBe(false);
    expect(p5TogglesOf(normalized)).toEqual(BOTH_OFF);
    expect(turnEndAcceptOn(normalized)).toBe(false);
  });

  it("keeps each switch stored as true or as false", () => {
    for (let turnEndAccept of [true, false]) {
      for (let simpleLook of [true, false]) {
        let stored = { siteName: "PointFive OS", p5TurnEndAccept: turnEndAccept, p5SimpleLook: simpleLook };
        let normalized = parseAdminConfig(JSON.stringify(stored));
        expect(normalized).toMatchObject({ p5TurnEndAccept: turnEndAccept, p5SimpleLook: simpleLook });
        expect(p5TogglesOf(normalized)).toEqual({ turnEndAccept, simpleLook });
        expect(turnEndAcceptOn(normalized)).toBe(turnEndAccept);
      }
    }
  });

  it("reads a switch off when it is not a boolean, and drops it", () => {
    for (let value of ["true", 1, null, {}, [true]]) {
      let normalized = normalizeAdminConfig(
          { p5TurnEndAccept: value, p5SimpleLook: value } as Partial<AdminConfig>);
      for (let key of KEYS) expect(key in normalized).toBe(false);
      expect(p5TogglesOf(normalized)).toEqual(BOTH_OFF);
      expect(turnEndAcceptOn(normalized)).toBe(false);
    }
  });

  it("starts with both off in a new deployment", async () => {
    let { expectEverywhere } = deployment();
    await expectEverywhere(BOTH_OFF);
  });

  it("turns each switch on and off alone", async () => {
    let { api, expectEverywhere } = deployment();
    expect(await api.p5Toggles({ toggle: "turnEndAccept", on: true }))
        .toEqual({ turnEndAccept: true, simpleLook: false });
    await expectEverywhere({ turnEndAccept: true, simpleLook: false });

    expect(await api.p5Toggles({ toggle: "simpleLook", on: true }))
        .toEqual({ turnEndAccept: true, simpleLook: true });
    await expectEverywhere({ turnEndAccept: true, simpleLook: true });

    expect(await api.p5Toggles({ toggle: "turnEndAccept", on: false }))
        .toEqual({ turnEndAccept: false, simpleLook: true });
    await expectEverywhere({ turnEndAccept: false, simpleLook: true });

    expect(await api.p5Toggles({ toggle: "simpleLook", on: false })).toEqual(BOTH_OFF);
    await expectEverywhere(BOTH_OFF);
  });

  it("keeps both switches through every other /admin save", async () => {
    for (let toggles of [
      { turnEndAccept: true, simpleLook: false }, { turnEndAccept: false, simpleLook: true },
    ]) {
      let { api, inDo, expectEverywhere } = deployment();
      for (let toggle of Object.keys(toggles) as P5Toggle[]) {
        await api.p5Toggles({ toggle, on: toggles[toggle] });
      }
      let saves: [string, () => Promise<unknown>, Partial<AdminConfig>][] = [
        ["user search", () => api.setUserSearchEnabled(true), { userSearchEnabled: true }],
        ["site name", () => api.setSiteName("PointFive OS"), { siteName: "PointFive OS" }],
        ["sign-ups", () => api.setSignupsEnabled(false), { signupsEnabled: false }],
        ["instructions", () => api.setInstanceInstructions("Be brief."), { instanceInstructions: "Be brief." }],
        ["announcement", () => api.setAnnouncement("Maintenance at noon"), { announcement: "Maintenance at noon" }],
        ["accent", () => api.setAccentColor("#3b82f6"), { accentColor: "#3b82f6" }],
      ];
      for (let [, save, saved] of saves) {
        await save();
        expect(await inDo(admin => admin.getAdminConfig())).toMatchObject(saved);
        await expectEverywhere(toggles);
      }
    }
  });

  it("refuses, by the capability's validator, a switch it does not know or a value not a boolean", async () => {
    let { api, expectEverywhere } = deployment();
    await api.p5Toggles({ toggle: "simpleLook", on: true });
    let unknownSwitch = await refusal(() => api.p5Toggles({ toggle: "codeTab" as P5Toggle, on: true }));
    let notBoolean = await refusal(() => api.p5Toggles({ toggle: "turnEndAccept", on: "yes" as unknown as boolean }));
    expect(unknownSwitch).toBeInstanceOf(TypeError);
    expect(notBoolean).toBeInstanceOf(TypeError);
    await expectEverywhere({ turnEndAccept: false, simpleLook: true });
  });
});
