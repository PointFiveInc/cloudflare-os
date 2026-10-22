import { useEffect, useState } from 'react'
import { Tooltip, useKumoToastManager } from '@cloudflare/kumo'
import { Trash } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { GadgetBindingInfo, ObserverBindingNeed, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { GatekeeperIcon } from './components/GatekeeperIcon'
import { WorkshopButton, WorkshopIconButton } from './components/WorkshopControls'
import type { VendorBranding } from './useVendorBranding'
import { reportIssue } from './errorReporting'
import { rpcFailureDescription } from './rpcErrors'

/** The "Not used by any gadget" section's heading, the two lines under it, and its confirm's sentence. */
export const UNUSED_CONNECTION_WORDS = {
  heading: 'Not used by any gadget',
  description: 'Connections in this workspace that no gadget uses. A Workspace collaborator must still verify their access to each one.',
  stillUsed: 'A chat or a draft may still use one.',
  removed: 'The connection will be removed from this workspace.',
}

/**
 * The workspace's connections a "Workspace" collaborator is checked against and a "Gadget only"
 * one is not, less this gadget's own bindings and any ambient connection. A connection bound only
 * to a chat, or to a gadget still a draft, is among them.
 */
export async function listUnusedConnections(
  overseer: RpcStub<Overseer>,
  bindings: GadgetBindingInfo[],
): Promise<ObserverBindingNeed[]> {
  const [use, build] = await Promise.all([
    overseer.listObserverRequirements('use'),
    overseer.listObserverRequirements('build'),
  ])
  const reached = new Set([...use.map(need => need.gatekeeperId), ...bindings.map(binding => binding.target)])
  const candidates = build.filter(need => !reached.has(need.gatekeeperId))
  const types = await Promise.all(candidates.map(async need => {
    const gatekeeper = await overseer.getGatekeeperById(need.gatekeeperId)
    try {
      return (await gatekeeper.getCreationSpec()).type
    } finally {
      gatekeeper[Symbol.dispose]()
    }
  }))
  return candidates.filter((_, index) => types[index] === 'gatekeeper')
}

/**
 * Under a gadget's connections: the workspace's connections no gadget uses, each deleted from the
 * workspace by its own `remove()` after a confirm. A refused delete toasts and keeps the row. Shows
 * nothing when the list is empty or cannot be read, as for a "Gadget only" viewer.
 */
export function P5UnusedConnections({
  overseer,
  bindings,
  vendorBranding,
}: {
  overseer: RpcStub<Overseer>
  bindings: GadgetBindingInfo[]
  vendorBranding: Map<string, VendorBranding>
}) {
  const [unused, setUnused] = useState<ObserverBindingNeed[]>([])
  const [deleteTarget, setDeleteTarget] = useState<WorkpieceId | null>(null)
  const toasts = useKumoToastManager()

  useEffect(() => {
    let cancelled = false
    listUnusedConnections(overseer, bindings)
      .then(list => { if (!cancelled) setUnused(list) })
      .catch(err => {
        console.error('Failed to load connections:', err)
        reportIssue('connections.unused-load', err)
      })
    return () => { cancelled = true }
  }, [overseer, bindings])

  const handleDeleteConfirm = async (id: WorkpieceId) => {
    try {
      const gatekeeper = await overseer.getGatekeeperById(id)
      try {
        await gatekeeper.remove()
      } finally {
        gatekeeper[Symbol.dispose]()
      }
      setUnused(current => current.filter(need => need.gatekeeperId !== id))
    } catch (err) {
      console.error('Failed to remove connection:', err)
      toasts.add({ title: 'Failed to remove connection', description: rpcFailureDescription(err), variant: 'error' })
    } finally {
      setDeleteTarget(null)
    }
  }

  if (unused.length === 0) return null

  return (
    <section className="mt-8">
      <div className="mb-3">
        <h2 className="m-0 text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
          {UNUSED_CONNECTION_WORDS.heading}
        </h2>
        <p className="mt-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
          {UNUSED_CONNECTION_WORDS.description}
        </p>
        <p className="mt-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
          {UNUSED_CONNECTION_WORDS.stillUsed}
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
        {unused.map((connection, index) => {
          const isDeleting = deleteTarget === connection.gatekeeperId
          return (
            <div
              key={connection.gatekeeperId}
              className={`px-3 py-3 ${index > 0 ? 'border-t border-kumo-line' : ''} ${isDeleting ? 'bg-kumo-danger-tint/40' : ''}`}
            >
              {isDeleting ? (
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-danger">
                      Delete {connection.resourceTitle}?
                    </p>
                    <p className="truncate text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                      {UNUSED_CONNECTION_WORDS.removed}
                    </p>
                  </div>
                  <WorkshopButton
                    tone="danger"
                    className="min-w-[68px]"
                    onClick={() => handleDeleteConfirm(connection.gatekeeperId)}
                  >
                    Delete
                  </WorkshopButton>
                  <WorkshopButton onClick={() => setDeleteTarget(null)}>
                    Cancel
                  </WorkshopButton>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <GatekeeperIcon
                    vendorId={connection.vendorId}
                    fallbackText={connection.resourceTitle}
                    {...vendorBranding.get(connection.vendorId)}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                      {connection.resourceTitle}
                    </p>
                    {connection.resourceUrl && (
                      <p className="mt-0.5 truncate text-[11px] leading-4 tracking-[-0.1px] text-kumo-inactive">
                        {connection.resourceUrl}
                      </p>
                    )}
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    <Tooltip content="Delete connection" asChild>
                      <WorkshopIconButton
                        danger
                        onClick={() => setDeleteTarget(connection.gatekeeperId)}
                        aria-label="Delete connection"
                      >
                        <Trash size={14} />
                      </WorkshopIconButton>
                    </Tooltip>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
