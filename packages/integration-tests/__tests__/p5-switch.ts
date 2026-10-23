import type { WorkerConfig } from "../src/harness.js";

/** The var os.pointfive.co's deploy sets to turn PointFive's collaboration changes on. */
export const COLLABORATION_SWITCH = { P5_COLLABORATION: "true" } as const;

/** A `patchWorkshop` or `redeployWorkshop` callback. */
export type WorkshopPatch = (config: WorkerConfig) => void;

/**
 * A Workshop patch that runs `patch`, if given, then adds the switch to whatever vars the config
 * holds by then. `redeployWorkshop` replaces the patch a harness started with, so a redeploy that
 * should keep the switch on passes this whole patch again. `startTestGatekeeperHarness` takes no
 * patch, so a suite that needs the fixture gatekeeper with the switch on calls `startHarness` with
 * `TEST_GATEKEEPER_BINDING` and `TEST_GATEKEEPER_DIR`.
 */
export function workshopSwitchOn(patch?: WorkshopPatch): WorkshopPatch {
  return config => {
    patch?.(config);
    config.vars = { ...config.vars, ...COLLABORATION_SWITCH };
  };
}

/**
 * Context's `GatekeeperSpec` patch. It drops the build, so the harness boots the validated tree the
 * task graph built before any test file ran, as Cloudflare's own Context suites do, and adds the
 * switch to whatever vars the config holds.
 */
export function contextSwitchOn(config: WorkerConfig): void {
  delete config.build;
  config.vars = { ...config.vars, ...COLLABORATION_SWITCH };
}
