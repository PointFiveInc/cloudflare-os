import {
  P5_TOGGLE_KEYS, p5TogglesOf,
  type P5ToggleChange, type P5ToggleFlags, type P5Toggles,
} from "@gadgets/workshop-shared/p5-admin-toggles";
import type { AdminSettings } from "./admin-settings.js";
import type { AdminConfig } from "./storage-schema/admin-settings-storage.js";

export type { P5ToggleChange, P5Toggles } from "@gadgets/workshop-shared/p5-admin-toggles";

/**
 * The switches a stored admin config holds, for `normalizeAdminConfig`, which rebuilds the config
 * from Cloudflare's keys alone: without this, any `/admin` save would drop them. A switch is kept
 * only when stored as a boolean, so a config without them normalizes exactly as before.
 */
export function p5AdminToggles(stored: object): P5ToggleFlags {
  let flags = stored as P5ToggleFlags;
  let kept: P5ToggleFlags = {};
  for (let key of Object.values(P5_TOGGLE_KEYS)) {
    if (typeof flags[key] === "boolean") kept[key] = flags[key];
  }
  return kept;
}

/** Whether a finished agent turn's changes go live by themselves. Off unless turned on in `/admin`. */
export function turnEndAcceptOn(config: AdminConfig): boolean {
  return p5TogglesOf(config).turnEndAccept;
}

/** Both switches for `ServerConfig`, always present, so the browser reads them as it reads Cloudflare's. */
export function p5ServerToggles(config: AdminConfig): Required<P5ToggleFlags> {
  let { turnEndAccept, simpleLook } = p5TogglesOf(config);
  return { [P5_TOGGLE_KEYS.turnEndAccept]: turnEndAccept, [P5_TOGGLE_KEYS.simpleLook]: simpleLook };
}

/**
 * `AdminApi`'s method for the switches: both switches, after `change` when one is given. A change
 * goes through Cloudflare's own admin config write, so it reaches the KV mirror the Workshop reads.
 * `AdminApiImpl`'s `@validateRpc()` has already refused any switch or value not in its signature.
 */
export async function p5ApplyToggles(
    admin: DurableObjectStub<AdminSettings>, change?: P5ToggleChange): Promise<P5Toggles> {
  if (change !== undefined) {
    let patch: Partial<AdminConfig> & P5ToggleFlags = {};
    patch[P5_TOGGLE_KEYS[change.toggle]] = change.on;
    await admin.updateAdminConfig(patch);
  }
  return p5TogglesOf(await admin.getAdminConfig());
}
