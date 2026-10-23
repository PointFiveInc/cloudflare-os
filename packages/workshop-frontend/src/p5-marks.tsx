import { useEffect } from 'react'
import { useRouterState } from '@tanstack/react-router'
import type { P5Marked } from '@gadgets/workshop-shared/p5-marks'

/** What a mark says: "new" for a share, and who named the person in which chat for a mention. */
export const MARK_WORDS = {
  new: 'new',
  share: (by: string) => `new · shared by ${by}`,
  mention: (by: string, chatTitle?: string) =>
    chatTitle ? `${by} mentioned you in '${chatTitle}'` : `${by} mentioned you in a new chat`,
}

const visitedWorkspaces = new Set<string>()

/**
 * A workspace row's mark: the label to draw and the `search` for the row's link, which opens a
 * mention's chat. Nothing on the workspace that is open or on one already visited in this tab,
 * since an open clears the stored mark. `compact` is the sidebar's chip.
 */
export function useP5Mark(gadget: { id: string } & P5Marked, variant?: 'compact') {
  const openWorkspace = useRouterState({ select: (s) => /^\/workspace\/([^/]+)/.exec(s.location.pathname)?.[1] })
  useEffect(() => {
    if (openWorkspace) visitedWorkspaces.add(openWorkspace)
  }, [openWorkspace])

  const mark = gadget.p5Mark
  const known = mark?.kind === 'share' || mark?.kind === 'mention'
  if (!known || openWorkspace === gadget.id || visitedWorkspaces.has(gadget.id)) {
    return { search: {}, label: null }
  }
  const words = mark.kind === 'share' ? MARK_WORDS.share(mark.by) : MARK_WORDS.mention(mark.by, mark.chatTitle)
  return {
    search: mark.kind === 'mention' ? { chat: mark.chatId, showChat: true as const } : {},
    label: variant === 'compact' ? (
      <span
        role="img"
        aria-label={words}
        title={words}
        className="shrink-0 rounded-full bg-kumo-brand px-1.5 py-0.5 text-[10px] leading-none font-medium text-kumo-inverse"
      >
        {mark.kind === 'share' ? MARK_WORDS.new : '@'}
      </span>
    ) : (
      <p className="mt-0.5 truncate text-xs font-medium text-kumo-brand">
        {mark.kind === 'share' ? MARK_WORDS.new : words}
      </p>
    ),
  }
}
