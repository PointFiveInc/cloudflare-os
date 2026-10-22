// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RpcStub } from 'capnweb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AiChatMetadata, CollaboratorInfo, GatekeeperCreationSpec, Overseer, ServerConfig, SlashCommandChoice,
} from '@gadgets/workshop-shared/api'
import type { ResourceDescription } from '@gadgets/workshop-shared/gatekeeper'

type Person = { type: 'user'; id: string; name: string }
type Toast = { title: string; description?: string; variant: string }

const testState = vi.hoisted(() => ({
  currentUser: null as Person | null,
  searchUsers: vi.fn<(query: string, excludeIds: string[]) => Promise<{ id: string; name: string }[]>>(),
  addToast: vi.fn<(toast: Toast) => string>(() => 'toast'),
  gatekeeperModalProps: undefined as undefined | { onCreated: (gatekeeper: unknown) => Promise<void> },
}))

vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: testState.addToast, close: () => {} }),
}))
vi.mock('./AuthContext', () => {
  const context = {
    authenticatedApi: {
      searchUsers: (query: string, excludeIds: string[]) =>
        Object.assign(testState.searchUsers(query, excludeIds), { [Symbol.dispose]: () => {} }),
      listGatekeeperVendors: async () => [],
    },
    get currentUser() {
      return testState.currentUser
    },
  }
  return { useAuthenticatedApi: () => context, useOptionalAuthenticatedApi: () => null }
})
vi.mock('./useVendorBranding', () => ({ useVendorBranding: () => new Map() }))
vi.mock('./GatekeeperModal', () => ({
  default: (props: typeof testState.gatekeeperModalProps) => {
    testState.gatekeeperModalProps = props
    return null
  },
}))

import ChatInterface from './ChatInterface'
import { ChatComposer } from './features/chat/composer/ChatComposer'
import { ServerConfigContext } from './ServerConfigContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.scrollTo ??= () => {}
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
})

const OLIVE: Person = { type: 'user', id: 'olive@pointfive.co', name: 'Olive Owner' }
const BOB: Person = { type: 'user', id: 'bob@pointfive.co', name: 'Bob Baker' }
const CARLA: Person = { type: 'user', id: 'carla@pointfive.co', name: 'Carla Diaz' }
const DAN_COHEN: Person = { type: 'user', id: 'dan.cohen@pointfive.co', name: 'Dan Cohen' }
const UNA: Person = { type: 'user', id: 'una@pointfive.co', name: 'Una Usher' }
const DAN = { id: 'dan@pointfive.co', name: 'Dan' }
const DANA = { id: 'dana.levy@pointfive.co', name: 'Dana Levy' }
const BEA = { id: 'bea@pointfive.co', name: 'Bea Banks' }
const EVE = { id: 'eve@pointfive.co', name: 'Eve Stone' }
const DIRECTORY = [DAN, DANA, BEA, EVE, { id: UNA.id, name: 'Una From Directory' }]
const AGENT = { type: 'agent', id: 'claude-opus-5-5', name: 'Claude' } as const

const goesTo = (names: string) =>
  `Goes to ${names} only. The agent won't answer this message; it will read it the next time someone asks it.`
const AGENT_WORKING = 'The agent is working. Send this once it finishes.'
const WILL_BE_ADDED = 'will be added as "Workspace": edit gadgets and use chat'
const WILL_MOVE = 'will move to "Workspace": edit gadgets and use chat'
const NO_AGENT = 'No agent: this goes to people only. Pick the agent to ask it.'
const notListed = () => `Not listed? Ask them to open ${window.location.host} once.`
const AGENT_RUNNING = 'Agent is running, wait for it to finish.'
const CAP = 'This workspace already has 20 people with "Workspace" access, the most it allows; remove one of ' +
  'them in the Share window to make room.'
const SHARE_REFUSALS = [
  ['Gmail', "This workspace uses Gmail, which works only for the person who connected it, so they couldn't " +
    'open it; share a workspace without it instead.'],
  ['a whole Google Chat account', 'This workspace uses a whole Google Chat account, which works only for the ' +
    "person who connected it, so they couldn't open it; share a workspace without it instead."],
  ['Salesforce', "This workspace uses Salesforce, which works only for the person who connected it, so they couldn't " +
    'open it; share a workspace without it instead.'],
]
const REVIEW: SlashCommandChoice = {
  selection: { gatekeeperId: 42, commandId: 'review' },
  name: 'review',
  description: 'Review the current project.',
  providerLabel: 'Projects',
}

function makeOverseer(owner?: Person) {
  return {
    getMetadata: vi.fn<() => Promise<{ owner?: Person }>>(async () => ({ owner })),
    listCollaborators: vi.fn<() => Promise<CollaboratorInfo[]>>(async () => [
      { profile: BOB, addedBy: [], role: 'build' },
      { profile: CARLA, addedBy: [], role: 'build' },
      { profile: DAN_COHEN, addedBy: [], role: 'build' },
      { profile: UNA, addedBy: [], role: 'use' },
    ]),
    addCollaborator: vi.fn<(id: string, role: 'build') => Promise<CollaboratorInfo | null>>(async (id, role) =>
      ({ profile: { type: 'user', id, name: id }, addedBy: [], role })),
    listSlashCommands: vi.fn<() => Promise<SlashCommandChoice[]>>(async () => [REVIEW]),
  }
}
type FakeOverseer = ReturnType<typeof makeOverseer>
type ComposerProps = ComponentProps<typeof ChatComposer>

const serverConfig = ({ userSearchEnabled = true, signupsEnabled = true } = {}): ServerConfig => ({
  authVendors: [],
  passwordAuthEnabled: false,
  cloudflareLimitsEnabled: false,
  signupsEnabled,
  userSearchEnabled,
  siteName: 'PointFive OS',
  announcement: '',
  banner: '',
  bannerColor: 'neutral',
  accentColor: '',
})

let container: HTMLDivElement | undefined
let root: Root | undefined

beforeEach(() => {
  window.history.pushState({}, '', '/workspace/w1')
  testState.currentUser = OLIVE
  testState.addToast.mockClear()
  testState.searchUsers.mockReset()
  testState.searchUsers.mockImplementation(async (query, excludeIds) => DIRECTORY.filter(person =>
    !excludeIds.includes(person.id) && person.name.toLowerCase().includes(query.trim().toLowerCase())))
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  sessionStorage.clear()
  window.history.pushState({}, '', '/')
  testState.gatekeeperModalProps = undefined
})

async function renderComposer(overseer: FakeOverseer, options: {
  model?: string | null
  isAgentActive?: boolean
  draftStorageKey?: string
  userSearchEnabled?: boolean
  signupsEnabled?: boolean
  getOverseer?: ComposerProps['getOverseer']
} = {}) {
  const onSend = vi.fn<ComposerProps['onSend']>(async () => {})
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const draw = (isAgentActive: boolean) => act(async () => root!.render(
    <ServerConfigContext.Provider value={serverConfig(options)}>
      <ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={options.getOverseer ?? (() => overseer as unknown as RpcStub<Overseer>)}
        onSend={onSend}
        isAgentActive={isAgentActive}
        models={[]}
        selectedModel={options.model === null ? null : { id: options.model ?? 'model-a' }}
        onModelChange={() => {}}
        draftStorageKey={options.draftStorageKey}
      />
    </ServerConfigContext.Provider>,
  ))
  await draw(options.isAgentActive ?? false)
  const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!
  return { onSend, textarea, setAgentActive: draw }
}

const settle = (ms = 50) => act(async () => {
  await new Promise(resolve => setTimeout(resolve, ms))
})
const nextFrame = () => act(async () => {
  await new Promise(requestAnimationFrame)
})
const setText = async (textarea: HTMLTextAreaElement, text: string, caret = text.length) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, text)
    textarea.setSelectionRange(caret, caret)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await nextFrame()
}
const press = async (textarea: HTMLTextAreaElement, key: string) => {
  let notCancelled = true
  await act(async () => {
    notCancelled = textarea.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
  await nextFrame()
  return notCancelled
}
const mentionList = () => document.querySelector<HTMLElement>('[role="listbox"][aria-label="People to mention"]')
const rows = () => Array.from(mentionList()?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
const rowNames = () => rows().map(row => row.textContent!.split(' · ')[0])
const activeRow = () => rows().findIndex(row => row.getAttribute('aria-selected') === 'true')
const waitFor = async (check: () => void) => {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      check()
      return
    } catch {
      await settle()
    }
  }
  check()
}
const waitForRows = (names: string[]) => waitFor(() => expect(rowNames()).toEqual(names))
const hintLine = () => container!.querySelector<HTMLElement>('p.text-xs')
const hint = () => hintLine()?.textContent ?? null
const refusal = () => container!.querySelector('[role="alert"]')?.textContent ?? null
const addConnection = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
  .find(option => option.textContent?.includes('Add a new connection'))

async function addCapsule(title: string) {
  const add = container!.querySelector<HTMLButtonElement>('[aria-label="Add to conversation"]')!
  await act(async () => add.click())
  await waitFor(() => expect(addConnection()).toBeDefined())
  await act(async () => addConnection()!.click())
  const gatekeeper = {
    getId: async () => 9,
    describe: async (): Promise<ResourceDescription> => ({
      title, url: 'https://example.com/item', snippet: '', suggestedBindingName: 'item', tsType: 'Item',
    }),
    getCreationSpec: async (): Promise<GatekeeperCreationSpec> =>
      ({ type: 'gatekeeper', vendorId: 'example', typeUrlPattern: 'https://example.com/*' }),
    [Symbol.dispose]: () => {},
  }
  await act(async () => {
    await testState.gatekeeperModalProps!.onCreated(gatekeeper)
    await new Promise(requestAnimationFrame)
  })
}

describe('the "@" list in a workspace chat', { timeout: 20_000 }, () => {
  it('the owner sees the people in the chat, then search rows that will be added or will move; the keys pick one', async () => {
    const { textarea } = await renderComposer(makeOverseer())
    await setText(textarea, 'Hi @')
    await waitForRows(['Bob Baker', 'Carla Diaz', 'Dan Cohen'])
    expect(testState.searchUsers).not.toHaveBeenCalled()
    await setText(textarea, 'Hi @a')
    await waitForRows(['Bob Baker', 'Carla Diaz', 'Dan Cohen', 'Dan', 'Dana Levy', 'Bea Banks', 'Una Usher'])
    expect(testState.searchUsers).toHaveBeenCalledExactlyOnceWith('a', [OLIVE.id, BOB.id, CARLA.id, DAN_COHEN.id])
    expect(rows().map(row => row.textContent!.split(' · ')[1])).toEqual([
      BOB.id, CARLA.id, DAN_COHEN.id,
      `${DAN.id}${WILL_BE_ADDED}`, `${DANA.id}${WILL_BE_ADDED}`, `${BEA.id}${WILL_BE_ADDED}`, `${UNA.id}${WILL_MOVE}`,
    ])
    expect(mentionList()!.textContent).not.toContain('Una From Directory')
    for (let step = 0; step < 6; step++) expect(await press(textarea, 'ArrowDown')).toBe(false)
    expect(activeRow()).toBe(6)
    expect(await press(textarea, 'Enter')).toBe(false)
    expect(textarea.value).toBe('Hi @Una Usher ')
  })

  it('a pick beside a pasted item and a format keeps both, puts the caret after the name, and shows the line', async () => {
    sessionStorage.setItem('draft-k', JSON.stringify({
      version: 1, text: 'Make a Doc for ', formats: [{ position: 7, length: 3, noun: 'Doc', icon: 'fileText' }],
    }))
    const overseer = makeOverseer()
    const { textarea, onSend } = await renderComposer(overseer, { draftStorageKey: 'draft-k' })
    await waitFor(() => expect(textarea.value).toBe('Make a  ⁠ Doc for '))
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    await addCapsule('Project')
    const withItems = textarea.value
    const at = withItems.indexOf('for ') + 'for '.length
    await setText(textarea, `${withItems.slice(0, at)}@bo${withItems.slice(at)}`, at + 3)
    await waitForRows(['Bob Baker'])
    expect(await press(textarea, 'Enter')).toBe(false)
    expect(textarea.value).toBe('Make a  ⁠ Doc for @Bob Baker Project ')
    expect(document.activeElement).toBe(textarea)
    expect(textarea.selectionStart).toBe(at + '@Bob Baker '.length)
    expect(hint()).toBe(goesTo('Bob Baker'))
    await press(textarea, 'Enter')
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    const [message, , capsules, , formats] = onSend.mock.calls[0]!
    expect(message).toBe('Make a Doc for @Bob Baker [0]')
    expect(capsules).toEqual([expect.objectContaining({ position: (message as string).indexOf('[0]'), gatekeeperId: 9 })])
    expect(formats).toEqual([expect.objectContaining({ position: (message as string).indexOf('Doc'), noun: 'Doc' })])
    expect(overseer.addCollaborator).not.toHaveBeenCalled()
  })

  it('an "@Bob Baker" only inside a pasted item\'s title shows no line and opens no list', async () => {
    const overseer = makeOverseer()
    const { textarea } = await renderComposer(overseer)
    await setText(textarea, 'See ')
    await addCapsule('@Bob Baker notes')
    expect(textarea.value).toContain('@Bob Baker notes')
    await waitFor(() => expect(overseer.getMetadata).toHaveBeenCalled())
    await settle(300)
    expect(mentionList()).toBeNull()
    expect(testState.searchUsers).not.toHaveBeenCalled()
    expect(hint()).toBeNull()
  })

  it('an "@" right before a pasted item opens nothing', async () => {
    const { textarea } = await renderComposer(makeOverseer())
    await setText(textarea, 'Ping @')
    await addCapsule('Bob')
    expect(textarea.value).toBe('Ping @ Bob ')
    await settle(300)
    expect(mentionList()).toBeNull()
    expect(testState.searchUsers).not.toHaveBeenCalled()
  })

  it('after a pick, typing on opens no list and no "Not listed?" hint; the line stays and Enter sends', async () => {
    const overseer = makeOverseer()
    const { textarea, onSend } = await renderComposer(overseer)
    await setText(textarea, 'Hi @dana')
    await waitForRows(['Dana Levy'])
    await press(textarea, 'Enter')
    expect(textarea.value).toBe('Hi @Dana Levy ')
    await settle(300)
    expect(mentionList()).toBeNull()
    await setText(textarea, 'Hi @Dana Levy zz')
    await settle(300)
    expect(mentionList()).toBeNull()
    expect(document.body.textContent).not.toContain(notListed())
    expect(hint()).toBe(goesTo('Dana Levy'))
    expect(await press(textarea, 'Enter')).toBe(false)
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Hi @Dana Levy zz', 'model-a', undefined, undefined, undefined))
    expect(overseer.addCollaborator).toHaveBeenCalledExactlyOnceWith(DANA.id, 'build')
  })

  it('a pick leaves one space when a space already follows the "@"', async () => {
    const { textarea } = await renderComposer(makeOverseer())
    await setText(textarea, 'Hi @bo please', 'Hi @bo'.length)
    await waitForRows(['Bob Baker'])
    await press(textarea, 'Tab')
    expect(textarea.value).toBe('Hi @Bob Baker please')
    expect(textarea.selectionStart).toBe('Hi @Bob Baker '.length)
  })

  it('ArrowDown and ArrowUp go round the rows, the highlighted name is read out, and Escape closes only the list', async () => {
    const { textarea, onSend } = await renderComposer(makeOverseer())
    await setText(textarea, '@b')
    await waitForRows(['Bob Baker', 'Bea Banks'])
    expect(activeRow()).toBe(0)
    await press(textarea, 'ArrowDown')
    expect(activeRow()).toBe(1)
    await press(textarea, 'ArrowDown')
    expect(activeRow()).toBe(0)
    await press(textarea, 'ArrowUp')
    expect(activeRow()).toBe(1)
    expect(Array.from(container!.querySelectorAll('[aria-live="polite"]')).map(region => region.textContent))
      .toContain('Bea Banks')
    expect(await press(textarea, 'Escape')).toBe(false)
    expect(mentionList()).toBeNull()
    expect(textarea.value).toBe('@b')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('ArrowLeft away from the "@" closes the list and the key passes through', async () => {
    const { textarea } = await renderComposer(makeOverseer())
    await setText(textarea, 'Hi @dana')
    await waitForRows(['Dana Levy'])
    expect(await press(textarea, 'ArrowLeft')).toBe(true)
    expect(mentionList()).toBeNull()
  })

  it('the list floats outside the composer; a click in the text closes it, and a click on a row picks', async () => {
    const { textarea } = await renderComposer(makeOverseer())
    await setText(textarea, 'Hi @bo')
    await waitForRows(['Bob Baker'])
    expect(container!.contains(mentionList())).toBe(false)
    expect(mentionList()!.parentElement!.parentElement).toBe(document.body)
    await act(async () => {
      rows()[0]!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(mentionList()).not.toBeNull()
    await act(async () => {
      textarea.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(mentionList()).toBeNull()
    await setText(textarea, 'Hi @bo @ca')
    await waitForRows(['Carla Diaz'])
    await act(async () => {
      rows()[0]!.click()
      await new Promise(requestAnimationFrame)
    })
    expect(textarea.value).toBe('Hi @bo @Carla Diaz ')
    expect(document.activeElement).toBe(textarea)
    expect(textarea.selectionStart).toBe('Hi @bo @Carla Diaz '.length)
  })

  it('after a send, an "@" at the same place in the next draft opens the list again', async () => {
    const { textarea, onSend } = await renderComposer(makeOverseer())
    await setText(textarea, '@bo')
    await waitForRows(['Bob Baker'])
    await press(textarea, 'Enter')
    await press(textarea, 'Enter')
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce())
    expect(textarea.value).toBe('')
    await setText(textarea, '@ca')
    await waitForRows(['Carla Diaz'])
  })

  it('reads the people in the chat again at each new "@"', async () => {
    const overseer = makeOverseer()
    const { textarea } = await renderComposer(overseer)
    await setText(textarea, '@')
    await waitForRows(['Bob Baker', 'Carla Diaz', 'Dan Cohen'])
    const loads = overseer.getMetadata.mock.calls.length
    overseer.listCollaborators.mockResolvedValue([
      { profile: BOB, addedBy: [], role: 'build' },
      { profile: { type: 'user', ...DANA }, addedBy: [], role: 'build' },
    ])
    await setText(textarea, '@ hi @')
    await waitForRows(['Bob Baker', 'Dana Levy'])
    expect(overseer.getMetadata).toHaveBeenCalledTimes(loads + 1)
  })

  it('offers nothing until the signed-in person is known', async () => {
    testState.currentUser = null
    const overseer = makeOverseer()
    const { textarea } = await renderComposer(overseer)
    await setText(textarea, 'Hi @bo')
    await settle(300)
    expect(mentionList()).toBeNull()
    expect(overseer.getMetadata).not.toHaveBeenCalled()
  })

  it('a restored draft that names someone in the chat shows the line', async () => {
    const draft = 'Hi @Bob Baker, the figures for the third quarter are in the shared folder'
    sessionStorage.setItem('draft-r', JSON.stringify({ version: 1, text: draft, formats: [] }))
    const { textarea } = await renderComposer(makeOverseer(), { draftStorageKey: 'draft-r' })
    await waitFor(() => expect(textarea.value).toBe(draft))
    await waitFor(() => expect(hint()).toBe(goesTo('Bob Baker')))
    expect(mentionList()).toBeNull()
  })

  it('with no agent picked the "No agent" line shows, and an "@" puts the plain "Goes to" line in its place', async () => {
    const { textarea } = await renderComposer(makeOverseer(), { model: null })
    expect(hint()).toBe(NO_AGENT)
    expect(hintLine()!.classList.contains('bg-kumo-warning-tint')).toBe(true)
    await setText(textarea, '@Bob Baker and @Carla Diaz, have a look')
    await waitFor(() => expect(hint()).toBe(goesTo('Bob Baker and Carla Diaz')))
    expect(hintLine()!.classList.contains('bg-kumo-warning-tint')).toBe(false)
    expect(hintLine()!.querySelector('svg')).toBeNull()
  })

  it('on Home: no list, no line, no workspace read, and the send goes as typed', async () => {
    window.history.pushState({}, '', '/')
    const overseer = makeOverseer()
    const getOverseer = vi.fn<() => RpcStub<Overseer>>(() => overseer as unknown as RpcStub<Overseer>)
    const { textarea, onSend } = await renderComposer(overseer, { model: null, getOverseer })
    await setText(textarea, 'Hi @bo and @Bob Baker')
    await settle(300)
    expect(mentionList()).toBeNull()
    expect(hint()).toBeNull()
    await press(textarea, 'Enter')
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Hi @bo and @Bob Baker', null, undefined, undefined, undefined))
    expect(getOverseer).not.toHaveBeenCalled()
    expect(testState.searchUsers).not.toHaveBeenCalled()
  })
})

describe('slash commands', { timeout: 20_000 }, () => {
  it('with a slash command chosen: no list, no line and no grant, not even of an earlier pick', async () => {
    const overseer = makeOverseer()
    const { textarea, onSend } = await renderComposer(overseer)
    await setText(textarea, '@dana')
    await waitForRows(['Dana Levy'])
    await press(textarea, 'Enter')
    expect(hint()).toBe(goesTo('Dana Levy'))
    await setText(textarea, '/rev @Dana Levy ', '/rev'.length)
    await waitFor(() => expect(textarea.getAttribute('aria-expanded')).toBe('true'))
    await press(textarea, 'Enter')
    expect(textarea.value).toBe('/review @Dana Levy ')
    expect(hint()).toBeNull()
    await setText(textarea, '/review @Dana Levy @bo')
    await settle(300)
    expect(mentionList()).toBeNull()
    expect(hint()).toBeNull()
    await press(textarea, 'Enter')
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(onSend.mock.calls[0]![0]).toEqual({ id: REVIEW.selection, args: '@Dana Levy @bo' })
    expect(overseer.addCollaborator).not.toHaveBeenCalled()
  })

  it('while the slash command list is open the "@" list stays shut and Enter stays the command list\'s', async () => {
    const { textarea, onSend } = await renderComposer(makeOverseer())
    await setText(textarea, '/@bo')
    await waitFor(() => expect(textarea.getAttribute('aria-expanded')).toBe('true'))
    await settle(300)
    expect(mentionList()).toBeNull()
    await press(textarea, 'Enter')
    expect(textarea.value).toBe('/@bo')
    expect(onSend).not.toHaveBeenCalled()
  })
})

describe('user search', { timeout: 20_000 }, () => {
  it('off: only the people in the chat, no search and no "Not listed?" hint', async () => {
    const { textarea } = await renderComposer(makeOverseer(), { userSearchEnabled: false })
    await setText(textarea, '@da')
    await waitForRows(['Dan Cohen'])
    await settle(300)
    expect(testState.searchUsers).not.toHaveBeenCalled()
    await setText(textarea, '@zed')
    await settle(300)
    expect(mentionList()).toBeNull()
    expect(document.body.textContent).not.toContain('Not listed?')
  })

  it('on with no match: the "Not listed?" hint', async () => {
    const { textarea } = await renderComposer(makeOverseer())
    await setText(textarea, '@zed')
    await waitFor(() => expect(mentionList()?.textContent).toBe(notListed()))
    expect(testState.searchUsers).toHaveBeenCalledExactlyOnceWith('zed', [OLIVE.id, BOB.id, CARLA.id, DAN_COHEN.id])
  })

  it('searches once after 200 ms of quiet, and shows "Not listed?" only while the query holds no space', async () => {
    const { textarea } = await renderComposer(makeOverseer())
    await setText(textarea, '@z')
    await setText(textarea, '@zz')
    await waitFor(() => expect(mentionList()?.textContent).toBe(notListed()))
    expect(testState.searchUsers.mock.calls.map(([query]) => query)).toEqual(['zz'])
    await setText(textarea, '@zz q')
    await waitFor(() => expect(testState.searchUsers).toHaveBeenCalledTimes(2))
    await settle()
    expect(mentionList()).toBeNull()
  })

  it('with sign-ups off, a search with no match opens no list', async () => {
    const { textarea } = await renderComposer(makeOverseer(), { signupsEnabled: false })
    await setText(textarea, '@zed')
    await waitFor(() => expect(testState.searchUsers).toHaveBeenCalled())
    await settle(300)
    expect(mentionList()).toBeNull()
  })

  it('a collaborator\'s list holds the owner and the other "Workspace" people, never searches, and grants nobody', async () => {
    testState.currentUser = BOB
    const overseer = makeOverseer(OLIVE)
    const { textarea, onSend } = await renderComposer(overseer)
    await setText(textarea, 'Thanks @')
    await waitForRows(['Olive Owner', 'Carla Diaz', 'Dan Cohen'])
    await setText(textarea, 'Thanks @ev')
    await settle(300)
    expect(mentionList()).toBeNull()
    expect(testState.searchUsers).not.toHaveBeenCalled()
    await setText(textarea, 'Thanks @Olive Owner, and @Una Usher too')
    await waitFor(() => expect(hint()).toBe(goesTo('Olive Owner')))
    await press(textarea, 'Escape')
    await press(textarea, 'Enter')
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce())
    expect(overseer.addCollaborator).not.toHaveBeenCalled()
  })
})

describe('the owner\'s grant', { timeout: 20_000 }, () => {
  it('a pick still named is given "Workspace" before onSend; a person already in the chat is not', async () => {
    const overseer = makeOverseer()
    const { textarea, onSend } = await renderComposer(overseer)
    await setText(textarea, 'Hi @bo')
    await waitForRows(['Bob Baker'])
    await press(textarea, 'Enter')
    await setText(textarea, 'Hi @Bob Baker and @dana')
    await waitForRows(['Dana Levy'])
    expect(rows()[0]!.textContent).toContain(WILL_BE_ADDED)
    await press(textarea, 'Enter')
    expect(hint()).toBe(goesTo('Bob Baker and Dana Levy'))
    await press(textarea, 'Enter')
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(overseer.addCollaborator).toHaveBeenCalledExactlyOnceWith(DANA.id, 'build')
    expect(overseer.addCollaborator.mock.invocationCallOrder[0]).toBeLessThan(onSend.mock.invocationCallOrder[0]!)
    expect(onSend).toHaveBeenCalledWith('Hi @Bob Baker and @Dana Levy', 'model-a', undefined, undefined, undefined)
  })

  it('a typed name never grants, whether of someone in the chat or of someone the search would find', async () => {
    const overseer = makeOverseer()
    const { textarea, onSend } = await renderComposer(overseer)
    await setText(textarea, '@Bob Baker and @Dana Levy, see this')
    await waitFor(() => expect(hint()).toBe(goesTo('Bob Baker')))
    await press(textarea, 'Escape')
    await press(textarea, 'Enter')
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce())
    expect(overseer.addCollaborator).not.toHaveBeenCalled()
  })

  it('a pick whose name only starts a longer name in the chat is not granted', async () => {
    const overseer = makeOverseer()
    const { textarea, onSend } = await renderComposer(overseer)
    await setText(textarea, '@Dan')
    await waitForRows(['Dan Cohen', 'Dan', 'Dana Levy'])
    await act(async () => rows()[1]!.click())
    await nextFrame()
    expect(textarea.value).toBe('@Dan ')
    await setText(textarea, '@Dan Cohen can you check the totals?')
    await waitFor(() => expect(hint()).toBe(goesTo('Dan Cohen')))
    await press(textarea, 'Enter')
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce())
    expect(overseer.addCollaborator).not.toHaveBeenCalled()
  })

  it('a pick left over after a send that granted nobody is not granted later, and a granted pick is not granted again', async () => {
    const overseer = makeOverseer()
    const { textarea, onSend } = await renderComposer(overseer)
    await setText(textarea, '@dana')
    await waitForRows(['Dana Levy'])
    await press(textarea, 'Enter')
    await setText(textarea, 'never mind')
    await press(textarea, 'Enter')
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce())
    await setText(textarea, 'tell @Dana Levy later')
    await settle(300)
    expect(hint()).toBeNull()
    await press(textarea, 'Escape')
    await press(textarea, 'Enter')
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2))
    expect(overseer.addCollaborator).not.toHaveBeenCalled()
    await setText(textarea, '@dana')
    await waitForRows(['Dana Levy'])
    await press(textarea, 'Enter')
    await press(textarea, 'Enter')
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(3))
    expect(overseer.addCollaborator).toHaveBeenCalledExactlyOnceWith(DANA.id, 'build')
    await setText(textarea, '@Dana Levy again')
    await press(textarea, 'Escape')
    await press(textarea, 'Enter')
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(4))
    expect(overseer.addCollaborator).toHaveBeenCalledOnce()
  })

  it('a "Gadget only" person picked from a "will move" row is given "Workspace"', async () => {
    const overseer = makeOverseer()
    const { textarea, onSend } = await renderComposer(overseer)
    await setText(textarea, '@una')
    await waitForRows(['Una Usher'])
    expect(rows()[0]!.textContent).toBe(`Una Usher · ${UNA.id}${WILL_MOVE}`)
    await press(textarea, 'Enter')
    expect(hint()).toBe(goesTo('Una Usher'))
    await press(textarea, 'Enter')
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('@Una Usher', 'model-a', undefined, undefined, undefined))
    expect(overseer.addCollaborator).toHaveBeenCalledExactlyOnceWith(UNA.id, 'build')
  })

  it.each(SHARE_REFUSALS)('a grant refused for %s reads "<name>: <sentence>", keeps the draft and sends nothing', async (_, sentence) => {
    const overseer = makeOverseer()
    overseer.addCollaborator.mockRejectedValueOnce(new Error(sentence))
    const { textarea, onSend } = await renderComposer(overseer)
    await setText(textarea, 'Hi @dana')
    await waitForRows(['Dana Levy'])
    await press(textarea, 'Enter')
    await press(textarea, 'Enter')
    await waitFor(() => expect(refusal()).toBe(`Dana Levy: ${sentence}`))
    expect(hint()).toBe(`Dana Levy: ${sentence}`)
    expect(onSend).not.toHaveBeenCalled()
    expect(textarea.value).toBe('Hi @Dana Levy ')
    await setText(textarea, 'Hi @Dana Levy!')
    expect(refusal()).toBeNull()
    await press(textarea, 'Enter')
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Hi @Dana Levy!', 'model-a', undefined, undefined, undefined))
    expect(overseer.addCollaborator).toHaveBeenCalledTimes(2)
    expect(textarea.value).toBe('')
  })

  it('a grant that comes back empty reads "<name>: Couldn\'t add them." and sends nothing', async () => {
    const overseer = makeOverseer()
    overseer.addCollaborator.mockResolvedValueOnce(null)
    const { textarea, onSend } = await renderComposer(overseer)
    await setText(textarea, 'Hi @dana')
    await waitForRows(['Dana Levy'])
    await press(textarea, 'Enter')
    await press(textarea, 'Enter')
    await waitFor(() => expect(refusal()).toBe("Dana Levy: Couldn't add them. Try again."))
    expect(onSend).not.toHaveBeenCalled()
    expect(textarea.value).toBe('Hi @Dana Levy ')
  })

  it('near the cap, "@A @B" grants A, refuses B and sends nothing; a resend grants A again and refuses B again', async () => {
    const overseer = makeOverseer()
    overseer.addCollaborator.mockImplementation(async (id, role) => {
      if (id === EVE.id) throw new Error(CAP)
      return { profile: { type: 'user', id, name: id }, addedBy: [], role }
    })
    const { textarea, onSend } = await renderComposer(overseer)
    await setText(textarea, '@dana')
    await waitForRows(['Dana Levy'])
    await press(textarea, 'Enter')
    await setText(textarea, `${textarea.value}and @eve`)
    await waitForRows(['Eve Stone'])
    await press(textarea, 'Enter')
    const draft = textarea.value
    expect(draft).toBe('@Dana Levy and @Eve Stone ')
    await press(textarea, 'Enter')
    await waitFor(() => expect(refusal()).toBe(`Eve Stone: ${CAP}`))
    expect(overseer.addCollaborator.mock.calls).toEqual([[DANA.id, 'build'], [EVE.id, 'build']])
    await press(textarea, 'Enter')
    await waitFor(() => expect(overseer.addCollaborator).toHaveBeenCalledTimes(4))
    expect(overseer.addCollaborator.mock.calls.map(([id]) => id)).toEqual([DANA.id, EVE.id, DANA.id, EVE.id])
    expect(refusal()).toBe(`Eve Stone: ${CAP}`)
    expect(onSend).not.toHaveBeenCalled()
    expect(textarea.value).toBe(draft)
  })
})

describe('while the agent works', { timeout: 20_000 }, () => {
  it('an "@" of someone new is neither sent nor granted and the wait line shows; once the turn ends it goes', async () => {
    const overseer = makeOverseer()
    const { textarea, onSend, setAgentActive } = await renderComposer(overseer, { isAgentActive: true })
    await setText(textarea, 'Hi @dana')
    await waitForRows(['Dana Levy'])
    await press(textarea, 'Enter')
    expect(textarea.value).toBe('Hi @Dana Levy ')
    expect(hint()).toBe(AGENT_WORKING)
    await press(textarea, 'Enter')
    await settle(300)
    expect(onSend).not.toHaveBeenCalled()
    expect(overseer.addCollaborator).not.toHaveBeenCalled()
    expect(textarea.value).toBe('Hi @Dana Levy ')
    expect(hint()).toBe(AGENT_WORKING)
    await setAgentActive(false)
    expect(hint()).toBe(goesTo('Dana Levy'))
    await press(textarea, 'Enter')
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Hi @Dana Levy', 'model-a', undefined, undefined, undefined))
    expect(overseer.addCollaborator).toHaveBeenCalledExactlyOnceWith(DANA.id, 'build')
  })

  it('an "@" of someone in the chat is not sent', async () => {
    const { textarea, onSend } = await renderComposer(makeOverseer(), { isAgentActive: true })
    await setText(textarea, '@Bob Baker look at this')
    await waitFor(() => expect(hint()).toBe(AGENT_WORKING))
    await press(textarea, 'Escape')
    await press(textarea, 'Enter')
    await settle(300)
    expect(onSend).not.toHaveBeenCalled()
    expect(textarea.value).toBe('@Bob Baker look at this')
  })

  it('plain text still steers', async () => {
    const overseer = makeOverseer()
    const { textarea, onSend } = await renderComposer(overseer, { isAgentActive: true })
    await setText(textarea, 'make it dark')
    expect(hint()).toBeNull()
    await press(textarea, 'Enter')
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('make it dark', 'model-a', undefined, undefined, undefined))
    expect(overseer.getMetadata).not.toHaveBeenCalled()
  })
})

describe('a send before the people load', { timeout: 20_000 }, () => {
  it('goes as typed and grants nobody', async () => {
    const overseer = makeOverseer()
    let loadMetadata!: (value: { owner?: Person }) => void
    overseer.getMetadata.mockReturnValue(new Promise(resolve => {
      loadMetadata = resolve
    }))
    const consoleError = vi.spyOn(console, 'error')
    const { textarea, onSend } = await renderComposer(overseer)
    await setText(textarea, 'Hi @Bob Baker')
    expect(await press(textarea, 'Enter')).toBe(false)
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Hi @Bob Baker', 'model-a', undefined, undefined, undefined))
    expect(textarea.value).toBe('')
    await act(async () => loadMetadata({ owner: undefined }))
    expect(mentionList()).toBeNull()
    expect(overseer.addCollaborator).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('mid-turn, gets the server\'s refusal in the "Failed to send message" toast, and the draft stays', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const people = makeOverseer()
    people.listCollaborators.mockReturnValue(new Promise(() => {}))
    const chat: AiChatMetadata = { id: 1, title: 'Plan', started: new Date(), lastActive: new Date(), activeAgent: AGENT }
    const sendChatMessage = vi.fn<(chatId: number, message: string) => Promise<void>>(async () => {
      throw new Error(AGENT_RUNNING)
    })
    const overseer = {
      ...people,
      sendChatMessage,
      subscribeToActions: () => new Promise(() => {}),
      listActions: () => new Promise(() => {}),
      getChatMessage: async () => null,
      getChatHistory: async () => ({ messages: [] }),
      listChats: async () => [chat],
      listModels: async () => [AGENT],
      onRpcBroken: () => {},
      subscribeToChat: () => ({ [Symbol.dispose]: () => {} }),
      [Symbol.dispose]: () => {},
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ServerConfigContext.Provider value={serverConfig()}>
        <ChatInterface
          workspaceId="w1"
          overseer={overseer as unknown as RpcStub<Overseer>}
          selectedChatId={1}
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
    ))
    await waitFor(() => expect(container!.querySelector('[aria-label="Stop agent"]')).not.toBeNull())
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[role="combobox"]')!
    await setText(textarea, '@Bob Baker look at this')
    await waitFor(() => expect(people.listCollaborators).toHaveBeenCalled())
    expect(hint()).toBeNull()
    await press(textarea, 'Enter')
    await waitFor(() => expect(testState.addToast).toHaveBeenCalledWith(
      { title: 'Failed to send message', description: AGENT_RUNNING, variant: 'error' }))
    expect(sendChatMessage).toHaveBeenCalledOnce()
    expect(sendChatMessage.mock.calls[0]!.slice(0, 2)).toEqual([1, '@Bob Baker look at this'])
    expect(people.addCollaborator).not.toHaveBeenCalled()
    expect(textarea.value).toBe('@Bob Baker look at this')
    consoleError.mockRestore()
  })
})
