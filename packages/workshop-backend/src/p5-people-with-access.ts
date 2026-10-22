import { RpcTarget } from "cloudflare:workers";
import type { CollaboratorInfo, CollaboratorRole } from "@gadgets/workshop-shared/api";
import { retryOnDoReset } from "./do-retry";
import type { createWorkshopLogger } from "./observability";
import { collaborationOn } from "./p5-owner-only";
import type { GatekeeperCaller } from "./storage-schema/overseer-storage";
import type { UserDurableObject } from "./user.js";

type PersonWithAccess = { id: string; name: string; role: "owner" | CollaboratorRole };

/** The loopback target behind a gadget's `env.PEOPLE_WITH_ACCESS`. */
export type P5PeopleWithAccessTarget = { type: "p5PeopleWithAccess" };

/** The slice of the Overseer that builds the binding and reads the list. */
export interface P5PeopleWithAccessHost {
  env: Cloudflare.Env;
  logger: ReturnType<typeof createWorkshopLogger>;
  ownerUserDo(): DurableObjectStub<UserDurableObject>;
  getSharingManager(): Promise<{ listCollaborators(): CollaboratorInfo[] }>;
  makeBindingLoopback(target: P5PeopleWithAccessTarget, caller: GatekeeperCaller): unknown;
}

/**
 * Puts `PEOPLE_WITH_ACCESS` in a gadget's `env` when os.pointfive.co's collaboration switch is on; unset, the env
 * stays Cloudflare's. Called before the gadget's named bindings are added, so a binding the gadget itself names
 * `PEOPLE_WITH_ACCESS` replaces it.
 */
export function p5AddPeopleWithAccess(
    env: Record<string, unknown>, host: P5PeopleWithAccessHost, caller: GatekeeperCaller): void {
  if (collaborationOn(host.env)) {
    env.PEOPLE_WITH_ACCESS = host.makeBindingLoopback({ type: "p5PeopleWithAccess" }, caller);
  }
}

/**
 * The session behind `env.PEOPLE_WITH_ACCESS`. `list()` returns the people the Share window lists under "People with
 * access": the owner first, with their live profile, then each collaborator at their role, each `{id, name, role}`
 * like a viewer (`id` is their email). Each call reads them afresh, so a share or a removal shows at the next call.
 * It grants nothing.
 */
export class P5PeopleWithAccess extends RpcTarget {
  #host: P5PeopleWithAccessHost;

  constructor(host: P5PeopleWithAccessHost) {
    super();
    this.#host = host;
  }

  async list(): Promise<PersonWithAccess[]> {
    let owner = await retryOnDoReset(() => this.#host.ownerUserDo().whoami(), this.#host.logger);
    let collaborators = (await this.#host.getSharingManager()).listCollaborators();
    return [
      { id: owner.id, name: owner.name, role: "owner" },
      ...collaborators.map(({ profile, role }) => ({ id: profile.id, name: profile.name, role: role ?? "build" })),
    ];
  }
}

/** The building agent's section on `PEOPLE_WITH_ACCESS`, fixed text for the static head of its system prompt. */
export const P5_PEOPLE_WITH_ACCESS_GUIDANCE = `
# People with access

Every Gadget's \`env\` also holds \`PEOPLE_WITH_ACCESS\`: \`await this.env.PEOPLE_WITH_ACCESS.list()\` returns the people the workspace's Share window lists under "People with access": the owner first, then each collaborator, each \`{id, name, role}\` like a viewer (\`id\` their email; \`role\` \`"owner"\`, \`"build"\` or \`"use"\`). It is read fresh at each call: someone shared later is listed at once, before they open the Gadget, and someone removed drops out. A Gadget that lets someone pick a person (to assign, approve, mention) offers this list, read each time the picker opens, never only the people who have opened the Gadget; it checks the pick against the list on the server and keys people by \`id\`. Your own \`executeCode\` env does not hold it.
`.trim();

/**
 * What the agent's `describeBinding` tool says of a gadget's `PEOPLE_WITH_ACCESS`. A binding the gadget itself names
 * `PEOPLE_WITH_ACCESS` is described instead, as it replaces this one in the gadget's env.
 */
export function p5DescribePeopleWithAccess(envName: string): string {
  return `Binding: ${envName}\n` +
      `\n` +
      `This binding is present in every Gadget's env (not in your executeCode env), so Gadget code can use it ` +
      `without adding a binding. \`list()\` returns the people the workspace's Share window lists under "People ` +
      `with access": the owner first, then each collaborator, each \`{id, name, role}\` like a viewer (\`id\` their ` +
      `email). It is read fresh at each call. It implements this interface:\n` +
      `\n` +
      `\`\`\`\n` +
      `interface PeopleWithAccess {\n` +
      `  list(): Promise<{ id: string; name: string; role: "owner" | "build" | "use" }[]>;\n` +
      `}\n` +
      `\`\`\`\n`;
}
