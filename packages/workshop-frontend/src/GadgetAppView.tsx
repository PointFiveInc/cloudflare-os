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
import AppWorkshopButton from './AppWorkshopButton'
import ObserverConfigModal from './ObserverConfigModal'
import WorkspaceOpenErrorPage from './components/WorkspaceOpenErrorPage'
import { WorkshopButton } from './components/WorkshopControls'
import type { AppLocation } from './appLocation'
import { useWorkspaceOpen } from './useWorkspaceOpen'
import { useSiteName } from './ServerConfigContext'

// The Workshop's strip across the top of every app page. The gadget's frame starts below it, so no
// gadget can cover the Workshop button, which keeps this height and the strip's right-hand corner.
const APP_BAR_HEIGHT = 44

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
  /** The app page's address without an inner path. */
  appUrl: string
  /** Moves the address bar to another inner path of this gadget. */
  onNavigate: (innerPath: string, replace: boolean) => void
  onShareKeyConsumed: () => void
}

/**
 * The app page: one gadget under a slim Workshop strip that holds only the Workshop button and the
 * export menu, the same for owner, build and use. It opens through the same `openGadget()` as the
 * workspace page, so Access, the sharing graph and observer checks apply unchanged.
 */
const GadgetAppView = ({ location, appUrl, onNavigate, onShareKeyConsumed }: Props) => {
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
  const [titleText, setTitleText] = useState('')
  const siteName = useSiteName()
  // The gadget's title always follows its text, so a tab never shows only what the gadget chose.
  const tabTitle = gadget.status === 'ready'
    ? `${titleText ? `${titleText} – ` : ''}${gadget.title} - ${siteName}`
    : null
  // useWorkspaceOpen titles the tab with the workspace whenever its metadata changes, so this runs
  // again after it and takes the tab back for the gadget.
  useEffect(() => {
    if (tabTitle === null) return
    const previous = document.title
    document.title = tabTitle
    return () => {
      document.title = previous
    }
  }, [tabTitle, workspace.metadata])
  const goToWorkspaces = () => navigate({ to: '/workspaces' })
  const openEditor = () => navigate({
    to: '/workspace/$id',
    params: { id: location.workspaceId },
    search: { w: location.gadgetId ?? undefined },
  })

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

  const metadata = workspace.metadata
  return (
    <div
      className="grid h-full overflow-hidden bg-kumo-base"
      style={{ gridTemplateRows: `${APP_BAR_HEIGHT}px minmax(0, 1fr)` }}
    >
      <nav
        aria-label="Workshop"
        className="flex min-w-0 items-center justify-end gap-1 border-b border-kumo-line px-2"
        style={{ gridRow: 1 }}
      >
        {gadget.status === 'ready' && metadata && (
          <>
            <GadgetExportMenu gadget={gadget.client} gadgetTitle={gadget.title} />
            <AppWorkshopButton
              gadgetTitle={gadget.title}
              ownerName={metadata.owner?.name ?? null}
              onBackToWorkshop={goToWorkspaces}
              onOpenEditor={metadata.role === 'use' ? undefined : openEditor}
            />
          </>
        )}
      </nav>
      <div className="min-h-0" style={{ gridRow: 2 }}>
        {gadget.status === 'ready' ? (
          <GadgetUI
            gadget={gadget.client}
            height="100%"
            app={{ path: location.innerPath, appUrl, onNavigate, onSetTitle: setTitleText }}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
          </div>
        )}
      </div>
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
