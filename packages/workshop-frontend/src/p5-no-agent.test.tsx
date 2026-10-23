// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AiChatMessage, AiChatMetadata, Overseer } from '@gadgets/workshop-shared/api'

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
})
Element.prototype.scrollTo = () => {}
Element.prototype.scrollIntoView ??= () => {}

vi.mock('@cloudflare/kumo', async importOriginal => ({
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
import { ChatComposer } from './features/chat/composer/ChatComposer'

const NO_AGENT_LINE = 'No agent: this goes to people only. Pick the agent to ask it.'
const AGENT = { type: 'agent', id: 'claude-opus-5-5', name: 'Claude' } as const
const DANA = { type: 'user', id: 'dana@example.com', name: 'Dana' } as const
const CHAT: AiChatMetadata = { id: 1, title: 'Plan', started: new Date(), lastActive: new Date() }

const answer: AiChatMessage = {
  chatId: 1, sequence: 1, timestamp: new Date(), author: AGENT, type: 'message', message: 'Done.',
}
const fromDana: AiChatMessage = {
  chatId: 1, sequence: 2, timestamp: new Date(), author: DANA, type: 'message', message: 'Thanks, I will look.',
}

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

async function openChat(models: AiChatAuthorInfo[], messages: AiChatMessage[], chat: AiChatMetadata = CHAT) {
  const server = makeOverseer()
  Object.assign(server.overseer as object, {
    getChatMessage: async () => null,
    getChatHistory: async () => ({ messages }),
    listChats: async () => [chat],
    listModels: async () => models,
    onRpcBroken: () => {},
    viewChat: () => ({ [Symbol.dispose]: () => {} }),
    subscribeToChat: () => ({ [Symbol.dispose]: () => {} }),
  })
  await testRoot.render(
    <ChatInterface
      workspaceId="w1"
      overseer={server.overseer as RpcStub<Overseer>}
      selectedChatId={1}
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
  await vi.waitFor(() => expect(picker()).not.toBeNull())
}

const picker = () => document.querySelector<HTMLButtonElement>('[aria-label="Select model"]')
const pickerIcon = () => picker()!.querySelector('svg.text-kumo-warning')
const stopButton = () => document.querySelector('[aria-label="Stop agent"]')
const menuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  .find(item => item.textContent?.trim() === label)

describe('"No agent" in a workspace chat', () => {
  it("shows the line once a person's message, not an answer, ends the chat and the picker moves to \"No agent\"", async () => {
    await openChat([AGENT], [answer, fromDana])
    await vi.waitFor(() => expect(picker()!.textContent).toBe('No agent'))
    expect(document.body.textContent).toContain(NO_AGENT_LINE)
  })

  it('marks the picker with the warning icon and shows the line when no agent is set up', async () => {
    await openChat([], [])
    await vi.waitFor(() => expect(picker()!.textContent).toBe('No agent'))
    expect(pickerIcon()).not.toBeNull()
    expect(document.body.textContent).toContain(NO_AGENT_LINE)
  })

  it('shows neither the icon nor the line while the chat is on an agent', async () => {
    await openChat([AGENT], [answer])
    await vi.waitFor(() => expect(picker()!.textContent).toBe('Claude'))
    expect(pickerIcon()).toBeNull()
    expect(document.body.textContent).not.toContain(NO_AGENT_LINE)
  })

  it('keeps the line hidden when "No agent" is picked while a turn runs, since a send then steers that turn', async () => {
    await openChat([AGENT], [], { ...CHAT, activeAgent: AGENT })
    await vi.waitFor(() => expect(stopButton()).not.toBeNull())
    expect(picker()!.textContent).toBe('Claude')
    await act(async () => picker()!.click())
    await vi.waitFor(() => expect(menuItem('No agent')).toBeDefined())
    await act(async () => menuItem('No agent')!.click())
    await vi.waitFor(() => expect(picker()!.textContent).toBe('No agent'))
    expect(stopButton()).not.toBeNull()
    expect(pickerIcon()).not.toBeNull()
    expect(document.body.textContent).not.toContain(NO_AGENT_LINE)
  })
})

describe('"No agent" on the home page', () => {
  it('marks the picker but leaves the line out, since home is not a workspace', async () => {
    window.history.replaceState(window.history.state, '', '/')
    const server = makeOverseer()
    await testRoot.render(
      <ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => server.overseer as RpcStub<Overseer>}
        onSend={async () => {}}
        isAgentActive={false}
        models={[]}
        selectedModel={null}
        onModelChange={() => {}}
        newChat
      />,
    )
    await vi.waitFor(() => expect(picker()!.textContent).toBe('No agent'))
    expect(pickerIcon()).not.toBeNull()
    expect(document.body.textContent).not.toContain(NO_AGENT_LINE)
  })
})
