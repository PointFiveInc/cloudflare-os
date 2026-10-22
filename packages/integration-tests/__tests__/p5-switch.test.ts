import { describe, expect, it } from "vitest";
import { ADMIN_USERNAME, type WorkerConfig } from "../src/harness.js";
import { contextSwitchOn, workshopSwitchOn } from "./p5-switch.js";

function harnessWorkshopConfig(): WorkerConfig {
  return {
    name: "workshop",
    main: "/packages/workshop-backend/.wrangler/validate/src/server.ts",
    services: [{ binding: "GATEKEEPER_TEST", service: "gatekeeper-test", entrypoint: "GatekeeperVendor" }],
    vars: {
      DISABLE_PASSWORD_AUTH: "true",
      ADMINS: [ADMIN_USERNAME],
      PUBLIC_BASE_URL: "http://workshop.test",
    },
  };
}

describe("the Workshop switch-on patch", () => {
  it("adds the switch and keeps every var and setting the harness gave the Workshop", () => {
    const config = harnessWorkshopConfig();

    workshopSwitchOn()(config);

    expect(config).toEqual({
      ...harnessWorkshopConfig(),
      vars: {
        DISABLE_PASSWORD_AUTH: "true",
        ADMINS: [ADMIN_USERNAME],
        PUBLIC_BASE_URL: "http://workshop.test",
        P5_COLLABORATION: "true",
      },
    });
  });

  it("applies the caller's own patch as well", () => {
    const config = harnessWorkshopConfig();

    workshopSwitchOn(patched => {
      patched.vars = { ...patched.vars, ENABLE_CLOUDFLARE_LIMITS: "true" };
      patched.define = { __TEST__: "1" };
    })(config);

    expect(config.define).toEqual({ __TEST__: "1" });
    expect(config.vars).toEqual({
      DISABLE_PASSWORD_AUTH: "true",
      ADMINS: [ADMIN_USERNAME],
      PUBLIC_BASE_URL: "http://workshop.test",
      ENABLE_CLOUDFLARE_LIMITS: "true",
      P5_COLLABORATION: "true",
    });
  });

  it("keeps the switch on when the caller's patch replaces the vars", () => {
    const config = harnessWorkshopConfig();

    workshopSwitchOn(patched => { patched.vars = { ADMINS: [] }; })(config);

    expect(config.vars).toEqual({ ADMINS: [], P5_COLLABORATION: "true" });
  });
});

describe("the Context switch-on patch", () => {
  it("drops the build, keeps the vars the config already holds and turns the switch on over theirs", () => {
    const config: WorkerConfig = {
      name: "gatekeeper-context",
      main: "/packages/gatekeeper-context/.wrangler/validate/src/index.ts",
      build: {
        command: "pnpm exec capnweb-validate build --out .wrangler/validate",
        cwd: "/packages/gatekeeper-context",
      },
      vars: { LATER_VAR: "kept", P5_COLLABORATION: "false" },
    };

    contextSwitchOn(config);

    expect(config).toStrictEqual({
      name: "gatekeeper-context",
      main: "/packages/gatekeeper-context/.wrangler/validate/src/index.ts",
      vars: { LATER_VAR: "kept", P5_COLLABORATION: "true" },
    });
  });
});
