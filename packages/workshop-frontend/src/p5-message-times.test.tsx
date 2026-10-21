// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AiChatMessage, AiChatMessageBody, AiChatMetadata, Overseer,
} from '@gadgets/workshop-shared/api'

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
})
// jsdom lays nothing out; the message list scrolls itself to the bottom on every render.
Element.prototype.scrollTo = () => {}

const { Pass, Null } = vi.hoisted(() => ({
  Pass: ({ children }: { children?: React.ReactNode }) => children ?? null,
  Null: () => null,
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  const parts = new Proxy(Pass, {
    get: (_target, property) => property === 'Root' ? Null : Pass,
  })
  const toasts = { add: vi.fn<(options: unknown) => void>() }
  return {
    ...actual,
    Dialog: parts,
    DropdownMenu: parts,
    Popover: parts,
    Tooltip: Pass,
    useKumoToastManager: () => toasts,
  }
})

vi.mock('./AuthContext', () => {
  const context = {
    authenticatedApi: { listGatekeeperVendors: async () => [] },
    currentUser: null,
  }
  return {
    useAuthenticatedApi: () => context,
    useOptionalAuthenticatedApi: () => null,
  }
})

import { makeOverseer, makeTestRoot } from './action-test-harness'
import ChatInterface from './ChatInterface'

const testRoot = makeTestRoot()

afterEach(() => {
  testRoot.cleanup()
  vi.restoreAllMocks()
})

const CHAT_ID = 1
const DANA = { type: 'user', id: 'dana@example.com', name: 'Dana' } as const
const BOB = { type: 'user', id: 'bob@example.com', name: 'Bob' } as const
const AGENT = { type: 'agent', id: 'model', name: 'Model' } as const

const at = (minute: number) => new Date(2026, 9, 20, 10, minute)
const shown = (minute: number) =>
  at(minute).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const message = (
  sequence: number, author: AiChatMessage['author'], body: AiChatMessageBody,
): AiChatMessage => ({ chatId: CHAT_ID, sequence, timestamp: at(sequence), author, ...body })

const HISTORY: AiChatMessage[] = [
  message(1, DANA, {
    type: 'slashCommand', request: { id: { gatekeeperId: 2, commandId: 'report' }, args: 'March' },
  }),
  message(2, AGENT, {
    type: 'message',
    message: '',
    toolCalls: [{
      toolCallId: 'write', toolName: 'writeFile', input: { filename: 'app.tsx', content: 'x' },
    }],
  }),
  message(3, AGENT, { type: 'changes', change: { 4: [['app.tsx', { set: 'x' }]] } }),
  message(4, DANA, { type: 'message', message: 'How many denials in March?' }),
  message(5, AGENT, { type: 'message', message: 'There were 41.' }),
  message(6, BOB, { type: 'message', message: 'And in February?' }),
  message(7, BOB, { type: 'message', message: 'And January?' }),
  message(8, AGENT, { type: 'message', message: 'There were 37.' }),
  message(9, DANA, { type: 'changes', change: { 4: [['app.tsx', { set: 'y' }]] } }),
]

const chat: AiChatMetadata = { id: CHAT_ID, title: 'Denials', started: at(1), lastActive: at(9) }

async function renderChat() {
  const server = makeOverseer()
  Object.assign(server.overseer as object, {
    getChatMessage: async () => null,
    getChatHistory: async () => ({ messages: HISTORY }),
    listChats: async () => [chat],
    listModels: async () => [],
    onRpcBroken: () => {},
    subscribeToChat: () => ({ [Symbol.dispose]: () => {} }),
  })
  await testRoot.render(
    <ChatInterface
      workspaceId="workspace"
      overseer={server.overseer as RpcStub<Overseer>}
      selectedChatId={CHAT_ID}
      onNavigateToChat={() => {}}
      pendingConsoleLogCount={0}
      consoleLogPreview=""
      consoleLogSeverity="info"
      onConsumeConsoleLogs={() => ''}
      onDiscardConsoleLogs={() => {}}
      onOpenGadget={() => {}}
      outputOfWorkpiece={() => undefined}
    />,
  )
  await vi.waitFor(() => expect(document.body.textContent).toContain('There were 37.'))
}

const timesShown = (minute: number) => [...document.querySelectorAll<HTMLElement>('span.font-mono')]
  .filter(span => span.textContent === shown(minute))

function timeOf(minute: number): HTMLElement {
  const [time, ...more] = timesShown(minute)
  if (!time || more.length > 0) {
    throw new Error(`Expected one time ${shown(minute)} in: ${document.body.textContent}`)
  }
  return time
}

function rowOf(time: HTMLElement): HTMLElement {
  if (!time.parentElement) throw new Error(`No row around the time ${time.textContent}`)
  return time.parentElement
}

function within(row: HTMLElement, selector: string): HTMLElement {
  const found = row.querySelector<HTMLElement>(selector)
  if (!found) throw new Error(`No ${selector} in the row: ${row.textContent}`)
  return found
}

// jsdom applies no Tailwind, so what would hide an element at some width or until a hover is read
// from the classes on it and on each of its ancestors.
const HIDING = /(^|\s)([^\s:]+:)*!?(opacity-0|invisible|hidden)(?=\s|$)/
const hiddenByClass = (element: Element | null): boolean => element !== null
  && (HIDING.test(element.getAttribute('class') ?? '') || hiddenByClass(element.parentElement))

describe('message times in a two-person chat', () => {
  it("shows a person's name and time with no hover-hiding class", async () => {
    await renderChat()
    for (const [minute, name] of [[4, 'Dana'], [7, 'Bob']] as const) {
      const time = timeOf(minute)
      const author = within(rowOf(time), 'span.font-medium')
      expect(author.textContent).toBe(name)
      expect(hiddenByClass(author)).toBe(false)
      expect(hiddenByClass(time)).toBe(false)
    }
  })

  it("shows a slash command's name and time with no hover-hiding class", async () => {
    await renderChat()
    const time = timeOf(1)
    const author = within(rowOf(time), 'span.font-medium')
    expect(author.textContent).toBe('Dana')
    expect(hiddenByClass(author)).toBe(false)
    expect(hiddenByClass(time)).toBe(false)
  })

  it("shows every agent answer's Copy and time, not only the latest answer's", async () => {
    await renderChat()
    for (const minute of [5, 8]) {
      const time = timeOf(minute)
      const copy = within(rowOf(time), 'button[aria-label="Copy message"]')
      expect(hiddenByClass(copy)).toBe(false)
      expect(hiddenByClass(time)).toBe(false)
    }
  })

  it("shows a tool-only turn's Discard and time", async () => {
    await renderChat()
    const time = timeOf(2)
    const discard = within(
      rowOf(time), 'button[aria-label="Discard changes from this response and later responses"]')
    expect(hiddenByClass(discard)).toBe(false)
    expect(hiddenByClass(time)).toBe(false)
  })

  it("shows a saved-edits row's time", async () => {
    await renderChat()
    const label = [...document.querySelectorAll<HTMLElement>('span')]
      .find(span => span.textContent === 'Dana saved edits')
    if (!label?.parentElement) throw new Error(`No saved-edits row in: ${document.body.textContent}`)
    const time = within(label.parentElement, 'span.font-mono')
    expect(time.textContent).toBe(shown(9))
    expect(hiddenByClass(time)).toBe(false)
  })

  it("keeps Cloudflare's grouping: two messages in a row from one person show one time", async () => {
    await renderChat()
    expect(timesShown(6)).toHaveLength(0)
    expect(within(rowOf(timeOf(7)), 'span.font-medium').textContent).toBe('Bob')
    const bobNames = [...document.querySelectorAll('span.font-medium')]
      .filter(span => span.textContent === 'Bob')
    expect(bobNames).toHaveLength(1)
  })
})
