// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AiChatMessage, AiChatMessageBody, AiChatMetadata, AiChatSubscriber, Overseer, ServerConfig,
} from '@gadgets/workshop-shared/api'
import type { CodeChange } from '@gadgets/workshop-shared/code-change'

// Cloudflare's Pending changes bar in the real chat: hidden while the agent works only while
// Turn-end accept is on, and shown, as Cloudflare's, after Stop, an error, or for changes no turn
// made.

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
})
Element.prototype.scrollTo = () => {}

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(),
  useKumoToastManager: () => ({ add: () => {} }),
}))

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
import { ServerConfigContext } from './ServerConfigContext'

const CHAT_ID = 1
const GADGET_ID = 4
const DANA = { type: 'user', id: 'dana@example.com', name: 'Dana' } as const
const AGENT = { type: 'agent', id: 'claude-opus-5-5', name: 'Claude' } as const

const message = (sequence: number, author: AiChatMessage['author'], body: AiChatMessageBody): AiChatMessage =>
  ({ chatId: CHAT_ID, sequence, timestamp: new Date(2026, 9, 22, 10, sequence), author, ...body }) as AiChatMessage

const edit: { change: CodeChange } = { change: { [GADGET_ID]: [['client.js', { set: 'total row' }]] } }
const AGENT_TURN: AiChatMessage[] = [
  message(0, DANA, { type: 'message', message: 'Add a total row.' }),
  message(1, AGENT, { type: 'changes', ...edit }),
]

const chat = (over: Partial<AiChatMetadata> = {}): AiChatMetadata => ({
  id: CHAT_ID,
  title: 'Totals',
  started: new Date(2026, 9, 22),
  lastActive: new Date(),
  proposedChangeWorkpieces: [GADGET_ID],
  ...over,
})

/** The server config as the page holds it: null while it loads. */
const serverConfig = (turnEndAccept: boolean | null): ServerConfig | null =>
  turnEndAccept === null
    ? null
    : { authVendors: [], siteName: '', p5TurnEndAccept: turnEndAccept } as object as ServerConfig

const testRoot = makeTestRoot()

afterEach(() => testRoot.cleanup())

async function renderChat(turnEndAccept: boolean | null, metadata: AiChatMetadata, history: AiChatMessage[]) {
  const server = makeOverseer()
  let subscriber: AiChatSubscriber | undefined
  const stopAgent = vi.fn<(chatId: number) => Promise<void>>(async () => {})
  Object.assign(server.overseer as object, {
    getChatMessage: async () => null,
    getChatHistory: async () => ({ messages: history }),
    listChats: async () => [metadata],
    listModels: async () => [],
    onRpcBroken: () => {},
    subscribeToChat: (next: AiChatSubscriber) => {
      subscriber = next
      return { [Symbol.dispose]: () => {} }
    },
    stopAgent,
  })
  const show = (switchOn: boolean | null) => testRoot.render(
    <ServerConfigContext.Provider value={serverConfig(switchOn)}>
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
      />
    </ServerConfigContext.Provider>,
  )
  await show(turnEndAccept)
  await vi.waitFor(() => expect(document.body.textContent).toContain('Add a total row.'))
  return {
    stopAgent,
    show,
    emitMessage: (msg: AiChatMessage) => act(() => subscriber!.message(msg)),
    emitMetadata: (meta: AiChatMetadata) => act(() => subscriber!.metadata(meta)),
  }
}

const stopButton = () => document.querySelector<HTMLButtonElement>('[aria-label="Stop agent"]')
const acceptButton = () =>
  [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Accept changes')
const showsBar = () => document.body.textContent?.includes('Pending changes') === true

describe('the Pending changes bar with Turn-end accept on', () => {
  it('is hidden while the agent works on pending changes', async () => {
    await renderChat(true, chat({ activeAgent: AGENT }), AGENT_TURN)
    expect(stopButton()).not.toBeNull()
    expect(showsBar()).toBe(false)
    expect(acceptButton()).toBeUndefined()
  })

  it('shows once the person stops the agent', async () => {
    const turn = await renderChat(true, chat({ activeAgent: AGENT }), AGENT_TURN)
    await act(async () => stopButton()!.click())
    expect(turn.stopAgent).toHaveBeenCalledWith(CHAT_ID)
    turn.emitMetadata(chat())
    expect(showsBar()).toBe(true)
    expect(acceptButton()!.disabled).toBe(false)
  })

  it('shows once the turn ends in an error', async () => {
    const turn = await renderChat(true, chat({ activeAgent: AGENT }), AGENT_TURN)
    turn.emitMessage(message(2, AGENT, { type: 'error', message: 'The model is unavailable.' }))
    turn.emitMetadata(chat())
    expect(document.body.textContent).toContain('The model is unavailable.')
    expect(acceptButton()!.disabled).toBe(false)
  })

  it('shows for changes no turn makes', async () => {
    await renderChat(true, chat(), [
      message(0, DANA, { type: 'message', message: 'Add a total row.' }),
      message(1, DANA, { type: 'changes', ...edit }),
    ])
    expect(document.body.textContent).toContain('Dana saved edits')
    expect(acceptButton()!.disabled).toBe(false)
  })
})

describe("the Pending changes bar with Turn-end accept off: Cloudflare's", () => {
  it('shows while the agent works, its buttons greyed until the turn ends', async () => {
    const turn = await renderChat(false, chat({ activeAgent: AGENT }), AGENT_TURN)
    expect(stopButton()).not.toBeNull()
    expect(showsBar()).toBe(true)
    expect(acceptButton()!.disabled).toBe(true)

    turn.emitMetadata(chat())
    expect(acceptButton()!.disabled).toBe(false)
  })
})

describe('a switch that arrives after the first render', () => {
  it('hides the bar mid-turn once the server config turns it on, and shows it once off', async () => {
    const turn = await renderChat(null, chat({ activeAgent: AGENT }), AGENT_TURN)
    expect(showsBar()).toBe(true)

    await turn.show(true)
    expect(stopButton()).not.toBeNull()
    expect(showsBar()).toBe(false)

    await turn.show(false)
    expect(showsBar()).toBe(true)
    expect(acceptButton()!.disabled).toBe(true)
  })
})
