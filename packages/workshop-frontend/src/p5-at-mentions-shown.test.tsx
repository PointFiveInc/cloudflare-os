// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatMessageBody, AiChatMetadata, AiChatSubscriber, CollaboratorInfo,
} from '@gadgets/workshop-shared/api'

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
})
Element.prototype.scrollTo = () => {}
Element.prototype.scrollIntoView ??= () => {}

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(),
  useKumoToastManager: () => ({ add: () => {} }),
}))

vi.mock('./AuthContext', () => {
  const context = {
    authenticatedApi: { listGatekeeperVendors: async () => [] },
    currentUser: { type: 'user', id: 'olive@pointfive.co', name: 'Olive Owner' },
  }
  return {
    useAuthenticatedApi: () => context,
    useOptionalAuthenticatedApi: () => null,
  }
})

import { makeOverseer, makeTestRoot } from './action-test-harness'
import ChatInterface from './ChatInterface'

const CHAT_ID = 1
const OLIVE = { type: 'user', id: 'olive@pointfive.co', name: 'Olive Owner' } as const
const BOB = { type: 'user', id: 'bob@pointfive.co', name: 'Bob Baker' } as const
const CARLA = { type: 'user', id: 'carla@pointfive.co', name: 'Carla Diaz' } as const
const UNA = { type: 'user', id: 'una@pointfive.co', name: 'Una Usher' } as const
const DANA = { type: 'user', id: 'dana@pointfive.co', name: 'Dana Cohen' } as const
const DEE = { type: 'user', id: 'dee@pointfive.co', name: 'Dee' } as const
const AGENT = { type: 'agent', id: 'claude-opus-5-5', name: 'Claude' } as const

const NO_AGENT_LINE = 'No agent: this goes to people only. Pick the agent to ask it.'

const at = (minute: number) => new Date(2026, 9, 18, 10, minute)

const message = (sequence: number, author: AiChatMessage['author'], body: Partial<AiChatMessageBody>): AiChatMessage =>
  ({ chatId: CHAT_ID, sequence, timestamp: at(sequence), author, type: 'message', ...body }) as AiChatMessage

const MENTIONS: AiChatMessage[] = [
  message(1, OLIVE, { message: 'Hi @Bob Baker, can you check this?' }),
  message(2, BOB, { message: '@Olive Owner sure. Ask @Bob Baker anything.' }),
  message(3, OLIVE, { message: '@Una Usher can only use the gadgets.' }),
  message(4, CARLA, { message: 'write to me@Bob Baker' }),
  message(5, OLIVE, { message: '**@Carla Diaz** see `@Bob Baker`' }),
  message(6, AGENT, { message: '@Bob Baker will know.' }),
  message(7, OLIVE, {
    message: 'See [0] now',
    capsules: [
      {
        position: 4, length: 3, gatekeeperId: 9,
        description: {
          title: '@Bob Baker notes', url: 'https://example.com/notes', snippet: '', suggestedBindingName: 'notes',
          tsType: 'Notes',
        },
      },
    ],
  }),
  message(8, OLIVE, {
    message: '@Bob BakerDoc please',
    formats: [{ position: 10, length: 3, noun: 'Doc', icon: 'fileText' }],
  }),
  message(9, OLIVE, { message: 'cc &#64;Carla Diaz' }),
  message(10, CARLA, { message: 'Over to @Dee.' }),
  message(11, CARLA, { message: 'Done for today.' }),
]

const chat: AiChatMetadata = { id: CHAT_ID, title: 'Q3', started: at(1), lastActive: at(9) }

const testRoot = makeTestRoot()
let previousPath = '/'

beforeEach(() => {
  previousPath = window.location.pathname
  window.history.replaceState(window.history.state, '', '/workspace/w1')
})

afterEach(() => {
  testRoot.cleanup()
  localStorage.clear()
  window.history.replaceState(window.history.state, '', previousPath)
})

function makeServer(
  history: AiChatMessage[], collaborators: CollaboratorInfo[],
  { meta = chat, models = [] }: { meta?: AiChatMetadata; models?: AiChatAuthorInfo[] } = {},
) {
  const server = makeOverseer()
  const people = {
    getMetadata: vi.fn<() => Promise<{ owner?: typeof OLIVE }>>(async () => ({})),
    listCollaborators: vi.fn<() => Promise<CollaboratorInfo[]>>(async () => collaborators),
  }
  const subscribers: AiChatSubscriber[] = []
  Object.assign(server.overseer as object, people, {
    getChatMessage: async () => null,
    getChatHistory: async () => ({ messages: history }),
    listChats: async () => [meta],
    listModels: async () => models,
    onRpcBroken: () => {},
    viewChat: () => ({ [Symbol.dispose]: () => {} }),
    subscribeToChat: (subscriber: AiChatSubscriber) => {
      subscribers.push(subscriber)
      return { [Symbol.dispose]: () => {} }
    },
  })
  return { overseer: server.overseer, people, subscribers }
}

async function renderChat(server: ReturnType<typeof makeServer>, lastText: string) {
  await testRoot.render(
    <ChatInterface
      workspaceId="w1"
      overseer={server.overseer}
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
  await vi.waitFor(() => expect(document.body.textContent).toContain(lastText))
}

const collaborator = (profile: CollaboratorInfo['profile'], role: CollaboratorInfo['role']): CollaboratorInfo =>
  ({ profile, addedBy: [], role })

const markElements = () => [...document.querySelectorAll('span.font-medium.text-kumo-brand')]
const marks = () => markElements().map(mark => mark.textContent)
const picker = () => document.querySelector<HTMLButtonElement>('[aria-label="Select model"]')
const pickerWarning = () => picker()?.querySelector('svg.text-kumo-warning') ?? null

describe('a sent "@" in a workspace chat', { timeout: 20_000 }, () => {
  it("marks each person's mention of someone else in the chat, by the one rule, and nothing else", async () => {
    const people = [
      collaborator(BOB, 'build'), collaborator(CARLA, 'build'), collaborator(DEE, 'build'), collaborator(UNA, 'use'),
    ]
    const server = makeServer(MENTIONS, people)
    await renderChat(server, 'Done for today.')
    await vi.waitFor(() => expect(marks()).toEqual(['@Bob Baker', '@Olive Owner', '@Carla Diaz', '@Dee']))
    for (const text of ['Hi @Bob Baker, can you check this?', '@Olive Owner sure. Ask @Bob Baker anything.']) {
      expect(document.body.textContent).toContain(text)
    }
    expect(document.body.textContent).toContain('@Bob Baker will know.')
    expect(document.querySelector('code')?.textContent).toBe('@Bob Baker')
  })

  it('asks for nobody while no person wrote an "@"', async () => {
    const history = [message(1, OLIVE, { message: 'Morning all.' }), message(2, AGENT, { message: 'Ask @Bob Baker.' })]
    const server = makeServer(history, [collaborator(BOB, 'build')])
    await renderChat(server, 'Ask @Bob Baker.')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })
    expect(server.people.getMetadata).not.toHaveBeenCalled()
    expect(server.people.listCollaborators).not.toHaveBeenCalled()
    expect(marks()).toEqual([])
  })

  it('loads the people again when another message with an "@" arrives', async () => {
    const server = makeServer([message(1, OLIVE, { message: '@Bob Baker hi' })], [collaborator(BOB, 'build')])
    await renderChat(server, 'hi')
    await vi.waitFor(() => expect(marks()).toEqual(['@Bob Baker']))
    server.people.listCollaborators.mockResolvedValue([collaborator(BOB, 'build'), collaborator(DANA, 'build')])
    await act(async () => server.subscribers[0]!.message(message(2, OLIVE, { message: 'Welcome @Dana Cohen' })))
    await vi.waitFor(() => expect(marks()).toEqual(['@Bob Baker', '@Dana Cohen']))
    expect(server.people.listCollaborators).toHaveBeenCalledTimes(2)
  })

  it('marks the "@" in a queued steer\'s bubble', async () => {
    const meta: AiChatMetadata = {
      ...chat, activeAgent: AGENT, queuedSteers: [{ text: '@Bob Baker see this', author: OLIVE }],
    }
    const server = makeServer([message(1, OLIVE, { message: 'Build it.' })], [collaborator(BOB, 'build')], { meta })
    await renderChat(server, 'see this')
    await vi.waitFor(() => expect(marks()).toEqual(['@Bob Baker']))
    expect(markElements()[0]!.closest('p')?.textContent).toBe('@Bob Baker see this')
  })
})

describe('the agent picker after an "@"', { timeout: 20_000 }, () => {
  it('reads "No agent", with the warning, when a person\'s "@" ends the chat', async () => {
    const history = [
      message(1, OLIVE, { message: 'Build the tracker.' }),
      message(2, AGENT, { message: 'Built it.' }),
      message(3, OLIVE, { message: '@Bob Baker have a look' }),
    ]
    const server = makeServer(history, [collaborator(BOB, 'build')], { models: [AGENT] })
    await renderChat(server, 'have a look')
    await vi.waitFor(() => expect(marks()).toEqual(['@Bob Baker']))
    await vi.waitFor(() => expect(picker()?.textContent).toBe('No agent'))
    expect(pickerWarning()).not.toBeNull()
    expect(document.body.textContent).toContain(NO_AGENT_LINE)
  })

  it("keeps the agent when the chat ends on the agent's answer", async () => {
    const history = [message(1, OLIVE, { message: '@Bob Baker have a look' }), message(2, AGENT, { message: 'Built it.' })]
    const server = makeServer(history, [collaborator(BOB, 'build')], { models: [AGENT] })
    await renderChat(server, 'Built it.')
    await vi.waitFor(() => expect(marks()).toEqual(['@Bob Baker']))
    await vi.waitFor(() => expect(picker()?.textContent).toBe('Claude'))
    expect(pickerWarning()).toBeNull()
    expect(document.body.textContent).not.toContain(NO_AGENT_LINE)
  })
})
