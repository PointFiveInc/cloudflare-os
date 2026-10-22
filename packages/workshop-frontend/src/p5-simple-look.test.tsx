// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useEffect, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ConsoleLogEvent, ConsoleLogSubscriber, GadgetSummary, ServerConfig, WorkpieceSummary, WorktreeSummary,
} from '@gadgets/workshop-shared/api'

// The simple look in the real editor: no Code tab and no captured-errors button for anyone while
// the switch is on, with Scratch space and every worktree kept. Everything the editor composes is
// stubbed down to the props and callbacks these views depend on.

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
})

type Props = Record<string, any>

const mocks = vi.hoisted(() => {
  const disposable = { [Symbol.dispose]() {} }
  const state = {
    isAdmin: false,
    search: {} as Record<string, unknown>,
    navigate: vi.fn<(options: { search: (prev: Record<string, unknown>) => Record<string, unknown> }) => void>(),
    workpieces: [] as unknown[],
    consoleLogs: undefined as unknown,
    chat: {} as Props,
    app: {} as Props,
    code: undefined as Props | undefined,
    picker: undefined as Props | undefined,
    chatContent: { chatId: 1, read: () => undefined, hasLocalEdits: () => false },
    authenticatedApi: { whoami: async () => ({ type: 'user', id: 'dev', name: 'Dev' }), listGadgets: async () => [] },
    workspace: {
      overseer: {
        stub: {
          subscribeToWorkpieces: async (subscriber: { entry(w: unknown): void; ready(): void }) => {
            for (const workpiece of state.workpieces) await subscriber.entry(workpiece)
            await subscriber.ready()
            return disposable
          },
          getGadget: () => disposable,
          listHooks: async () => [],
          subscribeToConsoleLogs: async (subscriber: unknown) => {
            state.consoleLogs = subscriber
            return disposable
          },
        },
      },
      metadata: { id: 'workspace', title: 'Trips', role: 'build' },
      error: null,
      connectionLost: false,
      observerConfig: null,
      retry: () => {},
      cancelObserverConfig: () => {},
      updateTitle: () => {},
    },
  }
  return state
})

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ id: 'workspace' }),
  useNavigate: () => mocks.navigate,
  useSearch: () => mocks.search,
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
  return {
    DropdownMenu,
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    useKumoToastManager: () => ({ add: () => {} }),
  }
})

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: mocks.authenticatedApi, isAdmin: mocks.isAdmin }),
}))
vi.mock('./RpcContext', () => ({ useConnectionLost: () => false, useRpcStub: () => ({}) }))
vi.mock('./useWorkspaceOpen', () => ({ useWorkspaceOpen: () => mocks.workspace }))
vi.mock('./useActions', () => ({ useActions: () => ({ pending: [] }), useActionEntries: () => {} }))
vi.mock('./errorReporting', () => ({ reportIssue: () => {} }))
vi.mock('./features/blueprint-updates/useBlueprintUpdateAvailable', () => ({
  useBlueprintUpdateAvailable: () => false,
}))
vi.mock('./ChatInterface', async () => {
  const { CapturedConsoleLogsPrompt } = await import('./features/chat/composer/CapturedConsoleLogsPrompt')
  return {
    default: (props: Props) => {
      mocks.chat = props
      const { onChatCountChange } = props
      useEffect(() => { onChatCountChange(1, false) }, [onChatCountChange])
      return (
        <CapturedConsoleLogsPrompt
          count={props.pendingConsoleLogCount}
          preview={props.consoleLogPreview}
          severity={props.consoleLogSeverity}
          onAttach={() => {}}
          onDiscard={props.onDiscardConsoleLogs}
        />
      )
    },
  }
})
vi.mock('./features/code/WorkpieceCodeInterface', () => ({
  default: (props: Props) => {
    mocks.code = props
    const { onHasCodeChange, onChatContentChange } = props
    useEffect(() => {
      onHasCodeChange(true)
      onChatContentChange(mocks.chatContent)
    }, [onHasCodeChange, onChatContentChange])
    return null
  },
}))
vi.mock('./GadgetUI', () => ({
  default: (props: Props) => {
    mocks.app = props
    return null
  },
}))
vi.mock('./WorkpiecePicker', () => ({
  default: (props: Props) => {
    mocks.picker = props
    return null
  },
  WORKPIECE_RAIL_COLLAPSED_WIDTH: 48,
  WORKPIECE_RAIL_EXPANDED_WIDTH: 220,
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
vi.mock('./features/blueprint-updates/UpdateFromBlueprintDialog', () => ({ UpdateFromBlueprintDialog: () => null }))
vi.mock('./components/format/FormatVisuals', () => ({ FormatGlyph: () => null }))
vi.mock('./components/GadgetPresence', () => ({ GadgetPresence: () => null }))
vi.mock('./Activity', () => ({ default: () => null }))
vi.mock('./ActivityNotifications', () => ({ default: () => null }))
vi.mock('./BlueprintModal', () => ({ default: () => null }))
vi.mock('./Connections', () => ({ default: () => null }))
vi.mock('./GadgetExportMenu', () => ({ default: () => null }))
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
import { ServerConfigContext } from './ServerConfigContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CHAT_ID = 1
const GADGET: GadgetSummary = { id: 1, type: 'gadget', title: 'Itinerary', commitId: 'head' }
const SCRATCH = { id: 2, type: 'worktree', title: 'Scratch space', chatId: CHAT_ID } as WorktreeSummary
const log = (level: ConsoleLogEvent['level'], text: string): ConsoleLogEvent =>
  ({ timestamp: new Date(), level, message: [text] })

let container: HTMLDivElement
let root: Root
const previousMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia')

beforeEach(() => {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) })
  window.localStorage.clear()
  mocks.navigate.mockClear()
  mocks.code = undefined
  mocks.picker = undefined
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  if (previousMatchMedia) Object.defineProperty(window, 'matchMedia', previousMatchMedia)
  else Reflect.deleteProperty(window, 'matchMedia')
})

/** The server config as the page holds it: null while it loads. */
const serverConfig = (simpleLook: boolean | null): ServerConfig | null =>
  simpleLook === null ? null : { authVendors: [], siteName: '', p5SimpleLook: simpleLook } as object as ServerConfig

const show = (simpleLook: boolean | null) => act(async () => root.render(
  <ServerConfigContext.Provider value={serverConfig(simpleLook)}>
    <GadgetEditor />
  </ServerConfigContext.Provider>,
))

async function renderEditor(options: {
  simpleLook: boolean | null
  admin?: boolean
  workpieces?: WorkpieceSummary[]
  search?: Record<string, unknown>
}) {
  mocks.isAdmin = options.admin ?? false
  mocks.workpieces = options.workpieces ?? [GADGET, SCRATCH]
  mocks.search = options.search ?? { chat: CHAT_ID }
  await show(options.simpleLook)
}

async function renderAgain(options: Parameters<typeof renderEditor>[0]) {
  act(() => root.unmount())
  root = createRoot(container)
  mocks.code = undefined
  mocks.picker = undefined
  mocks.navigate.mockClear()
  await renderEditor(options)
}

const buttons = (label: string, role?: 'menuitem') =>
  [...container.querySelectorAll('button')].filter(button =>
    button.textContent?.trim() === label && (button.getAttribute('role') ?? undefined) === role)

/** Every button and menu item the editor shows, by its words, in order. */
const everyButton = () =>
  [...container.querySelectorAll('button')].map(button => `${button.getAttribute('role') ?? 'button'}: ${button.textContent?.trim()}`)

const codeTab = () => buttons('Code')
const moreCode = () => buttons('Code', 'menuitem')
const worktreeTab = () => container.querySelector(`button[title="${SCRATCH.title}"]`)
const worktreeMenuItem = () => buttons(SCRATCH.title, 'menuitem')
const navigatedTo = () => mocks.navigate.mock.calls.map(([options]) => options.search({}).w)

async function firstBuildWrites() {
  await act(async () => {
    mocks.app.onNoUiChange(true)
    mocks.chat.onAgentActiveChange(CHAT_ID, true)
    mocks.chat.onStreamingActiveFileChange(CHAT_ID, { workpieceId: GADGET.id, filename: 'client.js' })
  })
}

async function logsArrive() {
  const subscriber = mocks.consoleLogs as ConsoleLogSubscriber
  await act(async () => {
    await subscriber.event(null, [log('error', 'boom')])
    await subscriber.event(CHAT_ID, [log('log', 'drawn')])
    mocks.app.onConsoleLog(log('warn', 'slow'))
  })
}

const quietConsole = () => ({
  error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  log: vi.spyOn(console, 'log').mockImplementation(() => {}),
  warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
})

describe('the Code tab with the simple look on', () => {
  it('is in neither the pane nor the phone More menu, while Connections stays', async () => {
    await renderEditor({ simpleLook: true })
    expect(codeTab()).toHaveLength(0)
    expect(moreCode()).toHaveLength(0)
    expect(buttons('Connections')).toHaveLength(1)
    expect(buttons('Connections', 'menuitem')).toHaveLength(1)
  })

  it('is hidden from an admin exactly as from a person who is not one', async () => {
    await renderEditor({ simpleLook: true, admin: false })
    const notAdmin = everyButton()

    await renderAgain({ simpleLook: true, admin: true })
    expect(codeTab()).toHaveLength(0)
    expect(moreCode()).toHaveLength(0)
    expect(everyButton()).toEqual(notAdmin)
  })

  it('never switches a first build to Code: the app stays in view', async () => {
    await renderEditor({ simpleLook: true, admin: true })
    await firstBuildWrites()
    expect(mocks.code!.isVisible).toBe(false)
    expect(mocks.app.isVisible).toBe(true)
  })

  it("keeps the Code pane mounted, hidden, so the clash check still reads the chat's files", async () => {
    await renderEditor({ simpleLook: true })
    expect(mocks.code!.summary).toEqual(GADGET)
    expect(mocks.code!.isVisible).toBe(false)
    expect(mocks.chat.chatContent).toBe(mocks.chatContent)
  })
})

describe("the Code tab with the simple look off: Cloudflare's views", () => {
  it('is in the pane and the phone More menu, for a person who is not an admin and for an admin', async () => {
    await renderEditor({ simpleLook: false, admin: false })
    expect(codeTab()).toHaveLength(1)
    expect(moreCode()).toHaveLength(1)

    await renderAgain({ simpleLook: false, admin: true })
    expect(codeTab()).toHaveLength(1)
    expect(moreCode()).toHaveLength(1)
  })

  it('switches a first build to Code', async () => {
    await renderEditor({ simpleLook: false })
    await firstBuildWrites()
    expect(mocks.code!.isVisible).toBe(true)
    expect(mocks.app.isVisible).toBe(false)
  })
})

describe('worktrees, Scratch space included, with the simple look on', () => {
  it('are in the pane tabs and the phone More list, as with it off', async () => {
    await renderEditor({ simpleLook: false })
    const off = { tab: worktreeTab() !== null, menu: worktreeMenuItem().length }

    await renderAgain({ simpleLook: true })
    expect(worktreeTab()).not.toBeNull()
    expect(worktreeMenuItem()).toHaveLength(1)
    expect({ tab: worktreeTab() !== null, menu: worktreeMenuItem().length }).toEqual(off)
  })

  it('open from ?w= in Code, showing their files, with the same Code tab as with it off', async () => {
    const search = { chat: CHAT_ID, w: SCRATCH.id }
    await renderEditor({ simpleLook: false, search })
    const off = everyButton()

    await renderAgain({ simpleLook: true, search })
    expect(mocks.code!.summary).toEqual(SCRATCH)
    expect(mocks.code!.isVisible).toBe(true)
    expect(codeTab().length).toBeGreaterThan(0)
    expect(everyButton()).toEqual(off)
  })

  it('are the default pick, in Code', async () => {
    await renderEditor({ simpleLook: true, workpieces: [SCRATCH] })
    expect(mocks.code!.summary).toEqual(SCRATCH)
    expect(mocks.code!.isVisible).toBe(true)
  })

  it('are listed in the picker', async () => {
    window.localStorage.setItem('gadgets:workshop:workspaceVisibility:workspace', JSON.stringify({ mode: 'chat' }))
    await renderEditor({ simpleLook: true })
    expect(mocks.picker!.worktrees).toEqual([SCRATCH])
  })

  it('are followed when the agent writes there', async () => {
    await renderEditor({ simpleLook: true })
    await act(async () => {
      mocks.chat.onStreamingActiveFileChange(CHAT_ID, { workpieceId: SCRATCH.id, filename: 'notes.md' })
    })
    expect(navigatedTo()).toContain(SCRATCH.id)
  })
})

describe('captured console lines', () => {
  it('are offered to the chat with the simple look off, as Cloudflare ships it', async () => {
    quietConsole()
    await renderEditor({ simpleLook: false })
    await logsArrive()
    expect(mocks.chat.pendingConsoleLogCount).toBe(3)
    expect(container.textContent).toContain('Send 3 captured errors to chat')
  })

  it.each([
    { who: 'a person who is not an admin', admin: false },
    { who: 'an admin', admin: true },
  ])("are never offered with it on, to $who; the browser's developer console keeps its copy", async ({ admin }) => {
    const developerConsole = quietConsole()
    await renderEditor({ simpleLook: true, admin })
    await logsArrive()
    expect(mocks.chat.pendingConsoleLogCount).toBe(0)
    expect(container.textContent).not.toContain('captured')
    expect(developerConsole.error).toHaveBeenCalledWith('server:', 'boom')
    expect(developerConsole.log).toHaveBeenCalledWith('server:', 'drawn')
    expect(developerConsole.warn).toHaveBeenCalledWith('client:', 'slow')
  })
})

describe('a switch that arrives after the first render', () => {
  it('hides the Code tab and the captured-errors button once the server config says so, and shows them once it is off', async () => {
    quietConsole()
    await renderEditor({ simpleLook: null })
    expect(codeTab()).toHaveLength(1)
    expect(moreCode()).toHaveLength(1)

    await show(true)
    expect(codeTab()).toHaveLength(0)
    expect(moreCode()).toHaveLength(0)
    expect(worktreeTab()).not.toBeNull()
    await logsArrive()
    expect(container.textContent).not.toContain('captured')

    await show(false)
    expect(codeTab()).toHaveLength(1)
    expect(moreCode()).toHaveLength(1)
    expect(container.textContent).toContain('Send 3 captured errors to chat')
  })
})
