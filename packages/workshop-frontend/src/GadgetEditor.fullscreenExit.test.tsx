// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useEffect, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GadgetMetadata,
  GadgetSummary,
  WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'

// A touch screen has no Esc key, so the editor's gadget full screen needs a way out on screen.

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const GADGET: GadgetSummary = { id: 1, type: 'gadget', title: 'Itinerary', commitId: 'head' }

const mocks = vi.hoisted(() => {
  const disposable = { [Symbol.dispose]() {} }
  return {
    workspace: {
      overseer: {
        stub: {
          subscribeToWorkpieces: async (subscriber: WorkpiecesSubscriber) => {
            await subscriber.entry(GADGET)
            await subscriber.ready()
            return disposable
          },
          getGadget: () => disposable,
          listHooks: async () => [],
          subscribeToConsoleLogs: async () => disposable,
        },
      },
      metadata: { id: 'workspace', title: 'Trips', role: 'build' } as unknown as GadgetMetadata,
      error: null,
      connectionLost: false,
      observerConfig: null,
      retry: () => {},
      cancelObserverConfig: () => {},
      updateTitle: () => {},
    },
    authenticatedApi: { whoami: async () => ({ type: 'user', id: 'dev', name: 'Dev' }) },
  }
})

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ id: 'workspace' }),
  useNavigate: () => () => {},
  useSearch: () => ({}),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}))

vi.mock('@cloudflare/kumo', () => {
  const DropdownMenu = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Trigger: ({ render }: { render: ReactElement }) => render,
      Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Item: ({ children, onClick, disabled }: {
        children: ReactNode
        onClick?: () => void
        disabled?: boolean
      }) => <button type="button" role="menuitem" onClick={onClick} disabled={disabled}>{children}</button>,
      Separator: () => <hr />,
    },
  )
  return { DropdownMenu, useKumoToastManager: () => ({ add: () => {} }) }
})

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: mocks.authenticatedApi }),
}))
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
vi.mock('./features/blueprint-updates/UpdateFromBlueprintDialog', () => ({ UpdateFromBlueprintDialog: () => null }))
vi.mock('./components/format/FormatVisuals', () => ({ FormatGlyph: () => null }))
vi.mock('./components/GadgetPresence', () => ({ GadgetPresence: () => null }))
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

import GadgetEditor from './GadgetEditor'

let container: HTMLDivElement
let root: Root
const previousMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia')

/** A phone has a coarse pointer and the single-pane layout; a desktop has neither. */
async function openEditor(screen: 'phone' | 'desktop') {
  const matching = screen === 'phone' ? ['(pointer: coarse)', '(width < 48rem)'] : []
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: matching.includes(query) }),
  })
  await act(async () => { root.render(<GadgetEditor />) })
}

function control(selector: string, name: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>(selector)]
    .find(candidate => candidate.getAttribute('aria-label') === name || candidate.textContent === name)
}

async function tap(selector: string, name: string) {
  const found = control(selector, name)
  if (!found) throw new Error(`No "${name}" in: ${container.innerHTML}`)
  await act(async () => { found.click() })
}

const enterFullscreen = (screen: 'phone' | 'desktop') => screen === 'phone'
  ? tap('[role="menuitem"]', 'Full-screen preview')
  : tap('button', 'Enter full screen')

const isFullscreen = () => container.querySelector('[role="dialog"][aria-label="Gadget full screen"]') !== null
const exitButton = () => control('button', 'Exit full screen')
const escHint = () => container.querySelector('[role="status"]')?.textContent

async function pressEscape() {
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
}

async function goBack() {
  const hashChanged = new Promise(resolve => window.addEventListener('hashchange', resolve, { once: true }))
  await act(async () => {
    window.history.back()
    await hashChanged
  })
}

beforeEach(() => {
  window.history.replaceState(null, '', '/workspace/workspace')
  localStorage.clear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  if (previousMatchMedia) Object.defineProperty(window, 'matchMedia', previousMatchMedia)
  else Reflect.deleteProperty(window, 'matchMedia')
})

describe('GadgetEditor full screen, on a touch screen', () => {
  it('shows an exit control in place of the Esc hint, and leaves full screen when tapped', async () => {
    await openEditor('phone')
    await enterFullscreen('phone')

    expect(isFullscreen()).toBe(true)
    expect(exitButton()).toBeDefined()
    expect(escHint()).toBeUndefined()

    await tap('button', 'Exit full screen')

    expect(isFullscreen()).toBe(false)
    expect(exitButton()).toBeUndefined()
    expect(window.location.hash).toBe('')
  })

  it('still leaves full screen on Esc', async () => {
    await openEditor('phone')
    await enterFullscreen('phone')

    await pressEscape()

    expect(isFullscreen()).toBe(false)
  })

  it('still leaves full screen on Back', async () => {
    await openEditor('phone')
    await enterFullscreen('phone')

    await goBack()

    expect(isFullscreen()).toBe(false)
    expect(exitButton()).toBeUndefined()
  })
})

describe('GadgetEditor full screen, with a mouse', () => {
  it('keeps the Esc hint and adds no exit control', async () => {
    await openEditor('desktop')
    await enterFullscreen('desktop')

    expect(isFullscreen()).toBe(true)
    expect(escHint()).toBe('Press Esc to exit full screen')
    expect(exitButton()).toBeUndefined()

    await pressEscape()

    expect(isFullscreen()).toBe(false)
  })
})
