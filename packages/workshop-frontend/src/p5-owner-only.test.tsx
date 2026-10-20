// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useEffect, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AuthenticatedApi,
  GadgetMetadata,
  GadgetMetadataWithTimestamps,
  Overseer,
} from '@gadgets/workshop-shared/api'
import { P5_OWNER_ONLY_NOTICE } from './p5-owner-only'

const mocks = vi.hoisted(() => {
  const disposable = { [Symbol.dispose]() {} }
  const gadget = { id: 1, type: 'gadget', title: 'Itinerary', commitId: 'head' }
  const owner = { type: 'user' as const, id: 'alex@example.com', name: 'Alex' }
  const mine = { id: 'mine', title: 'AR aging', created: new Date(), lastActive: new Date() }
  const sharedWithMe = { ...mine, id: 'shared', title: 'Q3 plan', owner }
  return {
    owner,
    mine,
    sharedWithMe,
    authenticatedApi: { whoami: async () => owner, listGadgets: async () => [mine, sharedWithMe] },
    workspace: {
      overseer: {
        stub: {
          subscribeToWorkpieces: async (subscriber: { entry(g: unknown): Promise<void>; ready(): Promise<void> }) => {
            await subscriber.entry(gadget)
            await subscriber.ready()
            return disposable
          },
          getGadget: () => disposable,
          listHooks: async () => [],
          subscribeToConsoleLogs: async () => disposable,
        },
      },
      metadata: {} as unknown,
      error: null,
      connectionLost: false,
      observerConfig: null,
      retry: () => {},
      cancelObserverConfig: () => {},
      updateTitle: () => {},
    },
  }
})

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ id: 'workspace' }),
  useNavigate: () => () => {},
  useSearch: () => ({}),
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: '/workspaces' } }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}))

vi.mock('@cloudflare/kumo', () => {
  const DropdownMenu = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Trigger: ({ render }: { render: ReactElement }) => render,
      Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Item: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
        <button type="button" role="menuitem" onClick={onClick}>{children}</button>
      ),
      Separator: () => <hr />,
    },
  )
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <dialog open>{children}</dialog>,
    {
      Root: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <>{children}</> : null),
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render }: { render: (props: object) => ReactElement }) => render({ 'aria-label': 'Close' }),
    },
  )
  return {
    Button: () => null,
    Checkbox: ({ label }: { label: ReactNode }) => <label>{label}</label>,
    Dialog,
    DropdownMenu,
    useKumoToastManager: () => ({ add: () => {} }),
  }
})

vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: mocks.authenticatedApi }) }))
vi.mock('./RpcContext', () => ({ useConnectionLost: () => false, useRpcStub: () => ({}) }))
vi.mock('./useWorkspaceOpen', () => ({ useWorkspaceOpen: () => mocks.workspace }))
vi.mock('./useActions', () => ({ useActions: () => ({ pending: [] }), useActionEntries: () => {} }))
vi.mock('./errorReporting', () => ({ reportIssue: () => {} }))
vi.mock('./features/blueprint-updates/useBlueprintUpdateAvailable', () => ({
  useBlueprintUpdateAvailable: () => false,
}))
vi.mock('./ChatInterface', () => ({
  default: ({ onChatCountChange }: { onChatCountChange: (count: number, hasChatZero: boolean) => void }) => {
    useEffect(() => { onChatCountChange(0, false) }, [onChatCountChange])
    return null
  },
}))
vi.mock('./features/code/WorkpieceCodeInterface', () => ({
  default: ({ onHasCodeChange }: { onHasCodeChange: (hasCode: boolean) => void }) => {
    useEffect(() => { onHasCodeChange(true) }, [onHasCodeChange])
    return null
  },
}))
vi.mock('./features/blueprint-updates/UpdateFromBlueprintDialog', () => ({ UpdateFromBlueprintDialog: () => null }))
vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, tone: _tone, ...props }: ComponentProps<'button'> & { tone?: string }) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopIconButton: ({ children, danger: _danger, ...props }: ComponentProps<'button'> & { danger?: boolean }) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopInput: (props: ComponentProps<'input'>) => <input {...props} />,
}))
vi.mock('./WorkpiecePicker', () => ({
  default: () => null,
  WORKPIECE_RAIL_COLLAPSED_WIDTH: 48,
  WORKPIECE_RAIL_EXPANDED_WIDTH: 220,
}))
vi.mock('./components/format/FormatVisuals', () => ({ FormatGlyph: () => null }))
vi.mock('./components/GadgetPresence', () => ({ GadgetPresence: () => null }))
vi.mock('./components/PersonAvatar', () => ({ PersonAvatar: () => <span /> }))
vi.mock('./Activity', () => ({ default: () => null }))
vi.mock('./ActivityNotifications', () => ({ default: () => null }))
vi.mock('./BlueprintModal', () => ({ default: () => null }))
vi.mock('./Connections', () => ({ default: () => null }))
vi.mock('./GadgetExportMenu', () => ({ default: () => null }))
vi.mock('./GadgetUI', () => ({ default: () => null }))
vi.mock('./GadgetUseView', () => ({ default: () => null }))
vi.mock('./ObserverConfigModal', () => ({ default: () => null }))
vi.mock('./ShareModal', () => ({ default: () => null }))
vi.mock('./TopBarNotice', () => ({ default: () => null }))
vi.mock('./components/DeleteConfirmationDialog', () => ({ default: () => null }))
vi.mock('./components/ReconnectingChip', () => ({ default: () => null }))
vi.mock('./components/SiteLogo', () => ({ default: () => null }))
vi.mock('./components/UserMenu', () => ({ default: () => null }))
vi.mock('./components/WorkspaceOpenErrorPage', () => ({ default: () => null }))
vi.mock('./features/notifications/WorkspaceNotificationsMenu', () => ({ WorkspaceNotificationsMenu: () => null }))

import GadgetEditor from './GadgetEditor'
import GadgetList from './components/GadgetList'
import SidebarGadgetRow from './components/AppShell/SidebarGadgetRow'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OWNER = mocks.owner
const MINE = mocks.mine as GadgetMetadataWithTimestamps
const SHARED_WITH_ME = mocks.sharedWithMe as GadgetMetadataWithTimestamps

let container: HTMLDivElement
let root: Root
const previousMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia')

beforeEach(() => {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  if (previousMatchMedia) Object.defineProperty(window, 'matchMedia', previousMatchMedia)
  else Reflect.deleteProperty(window, 'matchMedia')
})

const menuItems = (scope: Element) =>
  [...scope.querySelectorAll('[role="menuitem"]')].map(item => item.textContent?.trim())

function row(title: string): HTMLAnchorElement {
  const found = [...container.querySelectorAll('a')].find(link => link.textContent?.includes(title))
  if (!found) throw new Error(`No row for "${title}" in: ${container.textContent}`)
  return found
}

async function renderEditor(metadata: Partial<GadgetMetadata>) {
  mocks.workspace.metadata = { id: 'workspace', title: 'Trips', role: 'build', ...metadata }
  await act(async () => root.render(<GadgetEditor />))
}

describe('Share, for the owner only', () => {
  it("is offered on the owner's sidebar row, not on a collaborator's", async () => {
    const handlers = {
      onTogglePin: () => {}, onRename: () => {}, onShare: () => {}, onNotificationMuteChange: () => {}, onDelete: () => {},
    }
    await act(async () => root.render(
      <>
        <SidebarGadgetRow gadget={MINE} {...handlers} />
        <SidebarGadgetRow gadget={SHARED_WITH_ME} {...handlers} />
      </>,
    ))
    expect(menuItems(row('AR aging'))).toContain('Share')
    expect(menuItems(row('Q3 plan'))).not.toContain('Share')
  })

  it("is offered on the owner's Workspaces row, not on a collaborator's", async () => {
    await act(async () => root.render(<GadgetList showHeader={false} />))
    expect(menuItems(row('AR aging'))).toContain('Share')
    expect(menuItems(row('Q3 plan'))).not.toContain('Share')
  })

  it("is in the owner's editor header, not in a collaborator's", async () => {
    await renderEditor({})
    expect(container.querySelector('button[aria-label="Share workspace"]')).not.toBeNull()

    act(() => root.unmount())
    root = createRoot(container)
    await renderEditor({ owner: OWNER })
    expect(container.querySelector('button[aria-label="Share workspace"]')).toBeNull()
  })

  it("is in the owner's editor menu, not in a collaborator's", async () => {
    await renderEditor({})
    expect(menuItems(container)).toContain('Share workspace')

    act(() => root.unmount())
    root = createRoot(container)
    await renderEditor({ owner: OWNER })
    expect(menuItems(container)).not.toContain('Share workspace')
  })
})

describe("The owner's Share window", () => {
  it('says only the owner adds people, and offers "Workspace" without managing access', async () => {
    const { default: ShareModal } = await vi.importActual<typeof import('./ShareModal')>('./ShareModal')
    const overseer = {
      listCollaborators: async () => [],
      listShareLinks: async () => [],
      listObserverRequirements: async () => [],
    } as unknown as RpcStub<Overseer>
    const metadata = { id: 'workspace', title: 'Trips', ownerInvitesOnly: true } as GadgetMetadata

    await act(async () => root.render(
      <ShareModal
        open
        onClose={() => {}}
        overseer={overseer}
        metadata={metadata}
        currentUser={OWNER}
        authenticatedApi={{} as RpcStub<AuthenticatedApi>}
      />,
    ))
    await act(async () => { await Promise.resolve() })

    expect(container.textContent).toContain(P5_OWNER_ONLY_NOTICE)
    const workspaceRole = [...container.querySelectorAll('[role="menuitem"]')]
      .find(item => item.textContent?.startsWith('Workspace'))
    expect(workspaceRole?.textContent).toBe('WorkspaceEdit gadgets, use chat.')
    expect(container.textContent).not.toContain('manage access')
  })
})
