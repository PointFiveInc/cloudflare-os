import { useP5Toggles } from './p5-admin-toggles'

/**
 * Whether the chat shows its Pending changes bar. While the `/admin` → Access "Turn-end accept"
 * switch is on, a finished turn's changes go live by themselves, so the bar is hidden while the
 * agent works. After Stop, an error or a clash, and for changes no turn made, it shows as
 * Cloudflare's does. With the switch off it always shows.
 */
export function useP5ShowsPendingChangesBar(isAgentActive: boolean): boolean {
  const { turnEndAccept } = useP5Toggles()
  return !(turnEndAccept && isAgentActive)
}
