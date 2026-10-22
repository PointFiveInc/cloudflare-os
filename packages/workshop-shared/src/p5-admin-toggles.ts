/** One of the two `/admin` → Access switches os.pointfive.co adds. */
export type P5Toggle = "turnEndAccept" | "simpleLook";

/** Each switch, on or off. */
export type P5Toggles = Record<P5Toggle, boolean>;

/**
 * The switches under their keys in the admin config and in `ServerConfig`, each present only when
 * stored as a boolean. Cloudflare's keys are unprefixed, so one it adds later never collides.
 */
export type P5ToggleFlags = { p5TurnEndAccept?: boolean; p5SimpleLook?: boolean };

/** Each switch's key in `P5ToggleFlags`. */
export const P5_TOGGLE_KEYS = {
  turnEndAccept: "p5TurnEndAccept",
  simpleLook: "p5SimpleLook",
} as const satisfies Record<P5Toggle, keyof P5ToggleFlags>;

/** One switch turned on or off from `/admin`. */
export type P5ToggleChange = { toggle: P5Toggle; on: boolean };

/** The admin capability's method for the switches, beside Cloudflare's `AdminApi`. */
export interface P5AdminTogglesApi {
  /** Both switches, after `change` when one is given. */
  p5Toggles(change?: P5ToggleChange): Promise<P5Toggles>;
}

/**
 * Each switch in an admin config or a `ServerConfig`: on only when stored as `true`, so a switch
 * that is absent, or not a boolean, is off.
 */
export function p5TogglesOf(config: object | null | undefined): P5Toggles {
  let flags = config as P5ToggleFlags | null | undefined;
  return {
    turnEndAccept: flags?.p5TurnEndAccept === true,
    simpleLook: flags?.p5SimpleLook === true,
  };
}
