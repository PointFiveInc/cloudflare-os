import { WORKSPACE_ROLE_CAP } from "@gadgets/workshop-shared/p5-share-safety";

/**
 * True when os.pointfive.co's collaboration switch is on, Context's one reader of it. A shared
 * workspace's collaborators in its sharing domain may then observe every Skills collection it reads,
 * private ones included, so a private note never locks one of them out.
 */
export function p5ColleaguesSeeSkills(env: Cloudflare.Env): boolean {
  return env.P5_COLLABORATION === "true";
}

/**
 * The most observers one Context binding admits: the "Workspace" cap while the switch is on, when
 * checking an observer takes no Durable Object call, and otherwise undefined, the kit's own default.
 */
export function p5ContextMaxObservers(env: Cloudflare.Env): number | undefined {
  return p5ColleaguesSeeSkills(env) ? WORKSPACE_ROLE_CAP : undefined;
}
