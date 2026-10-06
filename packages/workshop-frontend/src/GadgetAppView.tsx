import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useKumoToastManager } from '@cloudflare/kumo'
import { RpcTarget, type RpcStub } from 'capnweb'
import type {
  GadgetClient,
  GadgetSummary,
  Overseer,
  WorkpieceId,
  WorkpieceSummary,
  WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from './AuthContext'
import GadgetUI from './GadgetUI'
import GadgetExportMenu from './GadgetExportMenu'
import ObserverConfigModal from './ObserverConfigModal'
import WorkspaceOpenErrorPage from './components/WorkspaceOpenErrorPage'
import { WorkshopButton } from './components/WorkshopControls'
import type { AppLocation } from './appLocation'
import { useWorkspaceOpen } from './useWorkspaceOpen'

// A gadget still pending in a chat is that chat's draft, so only accepted gadgets have an app page.
const isAppGadget = (summary: WorkpieceSummary): summary is GadgetSummary =>
  summary.type === 'gadget' && summary.chatId === undefined

class AppGadgetSubscriber extends RpcTarget implements WorkpiecesSubscriber {
  #found: GadgetSummary | null = null
  #ready = false
  #cancelled = false

  constructor(
    private gadgetId: WorkpieceId,
    private onChange: (summary: GadgetSummary | null) => void,
  ) {
    super()
  }

  entry(summary: WorkpieceSummary) {
    if (this.#cancelled || summary.id !== this.gadgetId) return
    this.#found = isAppGadget(summary) ? summary : null
    if (this.#ready) this.onChange(this.#found)
  }

  removed(id: WorkpieceId) {
    if (this.#cancelled || id !== this.gadgetId) return
    this.#found = null
    if (this.#ready) this.onChange(null)
  }

  ready() {
    if (this.#cancelled) return
    this.#ready = true
    this.onChange(this.#found)
  }

  cancel() {
    this.#cancelled = true
  }
}

type AppGadget =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'ready'; title: string; client: RpcStub<GadgetClient> }

const useAppGadget = (
  overseer: RpcStub<Overseer> | null,
  gadgetId: WorkpieceId | null,
): AppGadget => {
  // Undefined until the first listing. A reconnect's re-listing keeps the last answer, so the frame
  // stays up and GadgetUI swaps in the new stub without a reload.
  const [summary, setSummary] = useState<GadgetSummary | null>()
  const [client, setClient] = useState<{ stub: RpcStub<GadgetClient> } | null>(null)
  const listed = summary != null

  useEffect(() => {
    if (!overseer || gadgetId === null) return
    const subscriber = new AppGadgetSubscriber(gadgetId, setSummary)
    let subscription: RpcStub<{}> | null = null
    let cancelled = false
    overseer
      .subscribeToWorkpieces(subscriber)
      .then(resolved => {
        if (cancelled) resolved[Symbol.dispose]()
        else subscription = resolved
      })
      .catch(err => console.error('Failed to subscribe to workpieces:', err))
    return () => {
      cancelled = true
      subscriber.cancel()
      subscription?.[Symbol.dispose]()
    }
  }, [overseer, gadgetId])

  useEffect(() => {
    if (!overseer || gadgetId === null || !listed) {
      setClient(null)
      return
    }
    const stub = overseer.getGadget(gadgetId)
    setClient({ stub })
    return () => stub[Symbol.dispose]()
  }, [overseer, gadgetId, listed])

  if (gadgetId === null || summary === null) return { status: 'missing' }
  if (summary === undefined || !client) return { status: 'loading' }
  return { status: 'ready', title: summary.title, client: client.stub }
}

type Props = {
  location: AppLocation
  onShareKeyConsumed: () => void
}

/**
 * The app page: one gadget and nothing of the Workshop around it, the same for owner, build and
 * use. It opens through the same `openGadget()` as the workspace page, so Access, the sharing graph
 * and observer checks apply unchanged.
 */
const GadgetAppView = ({ location, onShareKeyConsumed }: Props) => {
  const navigate = useNavigate()
  const toasts = useKumoToastManager()
  const { authenticatedApi } = useAuthenticatedApi()
  const workspace = useWorkspaceOpen({
    id: location.workspaceId,
    authenticatedApi,
    onMetadata: () => {},
    onShareKeyConsumed,
    onInvalidShareKey: () => {
      toasts.add({ title: 'Invalid or expired share link.', variant: 'error' })
    },
  })
  const gadget = useAppGadget(workspace.overseer?.stub ?? null, location.gadgetId)
  const goToWorkspaces = () => navigate({ to: '/workspaces' })

  if (workspace.error?.kind === 'open') {
    return (
      <WorkspaceOpenErrorPage
        kind={workspace.error.failure}
        onGoToWorkspaces={goToWorkspaces}
        onRetry={workspace.retry}
      />
    )
  }

  if (workspace.error?.kind === 'message') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-kumo-base p-6">
        <p className="max-w-lg whitespace-pre-line text-center text-sm text-kumo-danger">
          {workspace.error.message}
        </p>
        <div className="flex items-center gap-2">
          <WorkshopButton tone="secondary" onClick={goToWorkspaces}>Go to workspaces</WorkshopButton>
          <WorkshopButton tone="primary" onClick={workspace.retry}>Try again</WorkshopButton>
        </div>
      </div>
    )
  }

  if (workspace.metadata && gadget.status === 'missing') {
    return (
      <WorkspaceOpenErrorPage
        kind="not-found"
        onGoToWorkspaces={goToWorkspaces}
        onRetry={workspace.retry}
      />
    )
  }

  return (
    <div className="relative h-full overflow-hidden bg-kumo-base">
      {gadget.status === 'ready' ? (
        <>
          <GadgetUI gadget={gadget.client} height="100%" />
          <div className="absolute right-3 top-3">
            <GadgetExportMenu gadget={gadget.client} gadgetTitle={gadget.title} />
          </div>
        </>
      ) : (
        <div className="flex h-full items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
        </div>
      )}
      {workspace.observerConfig && (
        <ObserverConfigModal
          needs={workspace.observerConfig.needs}
          authenticatedApi={authenticatedApi}
          onConfirm={workspace.observerConfig.resolve}
          onCancel={workspace.cancelObserverConfig}
        />
      )}
    </div>
  )
}

export default GadgetAppView
