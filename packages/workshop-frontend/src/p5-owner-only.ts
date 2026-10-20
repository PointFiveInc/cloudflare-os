/**
 * Only a workspace's owner is offered Share. Keyed on `owner`, which is set exactly when the viewer
 * is a collaborator: list rows and the "Gadget only" role's metadata never carry `ownerInvitesOnly`.
 */
export function p5OffersShare(workspace: { owner?: unknown }): boolean {
  return workspace.owner === undefined
}

/** The Share window's notice whenever only the owner adds people. */
export const P5_OWNER_ONLY_NOTICE =
  'Sharing is by name: only the owner can add people, and this workspace doesn’t allow share links. ' +
  'People you invite are asked to verify their own access to the connections it uses at their ' +
  'access level — some may be unable to open it. Anything the workspace has already saved is visible ' +
  'to everyone who can.'

/** "Workspace" access, without "manage access": only the owner adds people. */
export const P5_WORKSPACE_ROLE_TEXT = 'Edit gadgets, use chat.'
