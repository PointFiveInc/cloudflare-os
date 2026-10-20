import { rpcFailureDescription } from './rpcErrors'

const MAX_REASON_LENGTH = 300

/** Why the gatekeeper refused, e.g. a provider's validation error, so the person can fix it. */
export function failureReason(error: unknown): string | undefined {
  const reason = rpcFailureDescription(error)
  if (reason === undefined || reason.length <= MAX_REASON_LENGTH) return reason
  return `${reason.slice(0, MAX_REASON_LENGTH - 1)}…`
}
