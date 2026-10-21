import { useEffect, useState } from 'react'
import { Warning } from '@phosphor-icons/react'
import { RpcTarget, type RpcStub } from 'capnweb'
import type {
  CollaboratorRole, Overseer, WorkpieceId, WorkpieceSummary, WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'
import { useServerConfig } from './ServerConfigContext'

const NO_AGENT_LINE = 'No agent: this goes to people only. Pick the agent to ask it.'

const NO_GADGETS_WARNING =
  'This workspace has no gadgets yet, so "Gadget only" would show them nothing. Did you mean "Workspace"?'

/** The warning mark the model picker shows beside "No agent". */
export const NoAgentIcon = () => <Warning size={14} weight="fill" className="shrink-0 text-kumo-warning" />

/**
 * Under the composer in a workspace: with no agent picked, a send reaches people only. Hidden while
 * a turn runs, since a send then steers that turn whatever the picker shows.
 */
export function NoAgentLine({ noAgent, agentActive }: { noAgent: boolean; agentActive: boolean }) {
  if (!noAgent || agentActive || !window.location.pathname.startsWith('/workspace/')) return null
  return (
    <p className="mx-4 mt-2 flex items-center gap-1.5 rounded-xl bg-kumo-warning-tint px-3 py-1.5 text-xs font-medium text-kumo-default">
      <NoAgentIcon />
      {NO_AGENT_LINE}
    </p>
  )
}

/**
 * How to find a colleague the directory search misses: their first open creates their account.
 * Shown only while search is on and sign-ups are on, since without sign-ups an open creates nothing.
 */
export function NotListedHint() {
  const config = useServerConfig()
  if (!config?.userSearchEnabled || !config.signupsEnabled) return null
  return (
    <p className="mt-1.5 px-1 text-[12px] leading-4 text-kumo-subtle">
      {`Not listed? Ask them to open ${window.location.host} once.`}
    </p>
  )
}

class AcceptedGadgets extends RpcTarget implements WorkpiecesSubscriber {
  private accepted = new Set<WorkpieceId>()
  private listed = false

  constructor(private onChange: (noGadgets: boolean) => void) {
    super()
  }

  entry(summary: WorkpieceSummary) {
    if (summary.type === 'gadget' && summary.commitId !== undefined) this.accepted.add(summary.id)
    else this.accepted.delete(summary.id)
    if (this.listed) this.onChange(this.accepted.size === 0)
  }

  removed(id: WorkpieceId) {
    this.accepted.delete(id)
    if (this.listed) this.onChange(this.accepted.size === 0)
  }

  ready() {
    this.listed = true
    this.onChange(this.accepted.size === 0)
  }
}

function useNoAcceptedGadgets(overseer: RpcStub<Overseer>, open: boolean): boolean {
  const [noGadgets, setNoGadgets] = useState(false)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    let subscription: RpcStub<{}> | undefined
    void (async () => {
      const resolved = await overseer.subscribeToWorkpieces(
        new AcceptedGadgets(value => { if (!cancelled) setNoGadgets(value) }),
      )
      if (cancelled) resolved[Symbol.dispose]()
      else subscription = resolved
    })().catch(() => {})
    return () => {
      cancelled = true
      subscription?.[Symbol.dispose]()
      setNoGadgets(false)
    }
  }, [overseer, open])
  return noGadgets
}

/**
 * Warns at "Gadget only" when the workspace has no accepted gadget, which is all such a person can
 * see: pending gadgets are withheld from them. Reads the workspace's list only while `open`, and
 * shows nothing when the list cannot be read.
 */
export function NoGadgetsWarning({ overseer, open, role }: {
  overseer: RpcStub<Overseer>
  open: boolean
  role: CollaboratorRole
}) {
  const noGadgets = useNoAcceptedGadgets(overseer, open)
  if (!noGadgets || role !== 'use') return null
  return <p className="mt-1.5 px-1 text-[12px] leading-4 text-kumo-warning">{NO_GADGETS_WARNING}</p>
}
