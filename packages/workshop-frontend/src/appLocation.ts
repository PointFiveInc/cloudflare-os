import type { WorkpieceId } from '@gadgets/workshop-shared/api'

/** The place an `/apps/<workspace>/<gadget>/<inner path>` link points to. */
export type AppLocation = {
  workspaceId: string
  /** Null when the gadget segment is not a workpiece id, so no gadget can match it. */
  gadgetId: WorkpieceId | null
  /** Starts with `/`. Only the gadget gives it meaning; the Workshop never interprets it. */
  innerPath: string
}

const WORKPIECE_ID = /^(0|[1-9][0-9]*)$/

const parseGadgetId = (segment: string): WorkpieceId | null => {
  if (!WORKPIECE_ID.test(segment)) return null
  const id = Number(segment)
  return Number.isSafeInteger(id) ? id : null
}

export const parseAppLocation = (
  params: { workspaceId: string; gadgetId: string; _splat?: string },
): AppLocation => ({
  workspaceId: params.workspaceId,
  gadgetId: parseGadgetId(params.gadgetId),
  innerPath: `/${params._splat ?? ''}`,
})
