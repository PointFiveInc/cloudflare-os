import type { WorkpieceSummary } from '@gadgets/workshop-shared/api'
import { useP5Toggles } from './p5-admin-toggles'

/**
 * Whether gadgets show without their Code tab and without the button that sends captured errors to
 * chat: the `/admin` → Access "Simple look" switch. It is the same for every person, admins
 * included; nothing about who is viewing is read.
 */
export function useP5SimpleLook(): boolean {
  return useP5Toggles().simpleLook
}

/**
 * Whether the pane offers Code for this workpiece. A worktree, Scratch space among them, keeps it:
 * Code is a worktree's only tab, and the only place to download a file the agent made.
 */
export function p5OffersCode(summary: WorkpieceSummary | undefined, simpleLook: boolean): boolean {
  return !simpleLook || summary?.type === 'worktree'
}

/**
 * A gadget's pane tab as shown. While the simple look is on, a pick of Code (a click, the phone's
 * menu or the first build's jump) shows the app instead, and the Code pane stays mounted, hidden,
 * for whether the gadget has code and for the clash check before Accept.
 */
export function p5ShownTab<Tab extends string>(tab: Tab, simpleLook: boolean): Tab | 'app' {
  return simpleLook && tab === 'code' ? 'app' : tab
}

/** The pane's tabs for this workpiece, without Code where it is not offered. */
export function p5PaneTabs<Tab extends { value: string }>(
  tabs: Tab[],
  summary: WorkpieceSummary | undefined,
  simpleLook: boolean,
): Tab[] {
  return tabs.filter(tab => tab.value !== 'code' || p5OffersCode(summary, simpleLook))
}

/**
 * How many captured console lines the chat offers to send: none while the simple look is on, so the
 * button never shows. The browser's own console still gets every line.
 */
export function p5CapturedLogCount(count: number, simpleLook: boolean): number {
  return simpleLook ? 0 : count
}
