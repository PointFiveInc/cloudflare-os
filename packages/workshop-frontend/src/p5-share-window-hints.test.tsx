// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo, AuthenticatedApi, CollaboratorInfo, CollaboratorRole, GadgetMetadata, Overseer, ServerConfig,
  WorkpieceSummary, WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'
import { ServerConfigContext } from './ServerConfigContext'

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <dialog open>{children}</dialog>,
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render }: { render: (props: object) => ReactElement }) => render({ 'aria-label': 'Close' }),
    },
  )
  const DropdownMenu = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Trigger: ({ render }: { render: ReactElement }) => render,
      Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Item: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
        <button type="button" role="menuitem" onClick={onClick}>{children}</button>
      ),
    },
  )
  return {
    Checkbox: ({ label }: { label: ReactNode }) => <label>{label}</label>,
    Dialog,
    DropdownMenu,
    useKumoToastManager: () => ({ add: () => {} }),
  }
})
vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, tone: _tone, ...props }: ComponentProps<'button'> & { tone?: string }) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopIconButton: ({ children, danger: _danger, ...props }: ComponentProps<'button'> & { danger?: boolean }) => (
    <button type="button" {...props}>{children}</button>
  ),
}))
vi.mock('./components/PersonAvatar', () => ({ PersonAvatar: () => <span /> }))

import ShareModal from './ShareModal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OWNER: AiChatAuthorInfo = { type: 'user', id: 'maya@example.com', name: 'Maya' }
const COLLABORATOR: AiChatAuthorInfo = { type: 'user', id: 'daniel@example.com', name: 'Daniel' }
const WORKSPACE = { id: 'q3-plan', title: 'Q3 plan', ownerInvitesOnly: true } as GadgetMetadata
const AS_COLLABORATOR = { ...WORKSPACE, owner: OWNER } as GadgetMetadata

const ACCEPTED: WorkpieceSummary = { id: 1, type: 'gadget', title: 'Itinerary', commitId: 'a'.repeat(40) }
const PENDING: WorkpieceSummary = { id: 1, type: 'gadget', title: 'Itinerary', chatId: 3 }

const NOT_LISTED = `Not listed? Ask them to open ${window.location.host} once.`
const NO_GADGETS =
  'This workspace has no gadgets yet, so "Gadget only" would show them nothing. Did you mean "Workspace"?'

let workpieces: WorkpieceSummary[] = []
let liveSubscriber: WorkpiecesSubscriber | undefined
const disposeWorkpieces = vi.fn<() => void>()
const subscribeToWorkpieces = vi.fn<(subscriber: WorkpiecesSubscriber) => Promise<Disposable>>(async subscriber => {
  liveSubscriber = subscriber
  for (const summary of workpieces) subscriber.entry(summary)
  subscriber.ready()
  return { [Symbol.dispose]: disposeWorkpieces }
})
const addCollaborator = vi.fn<(id: string, role: CollaboratorRole, note?: string) => Promise<CollaboratorInfo>>(
  async (id, role) => ({ profile: { type: 'user', id, name: 'Daniel' }, role, addedBy: [] }),
)

const overseer = {
  listCollaborators: async () => [],
  listShareLinks: async () => [],
  listObserverRequirements: async () => [],
  addCollaborator,
  subscribeToWorkpieces,
} as unknown as RpcStub<Overseer>
const authenticatedApi = {} as RpcStub<AuthenticatedApi>

type WindowOptions = {
  open?: boolean
  userSearchEnabled?: boolean
  signupsEnabled?: boolean
  metadata?: GadgetMetadata
  currentUser?: AiChatAuthorInfo
}

const shareWindow = ({
  open = true, userSearchEnabled = true, signupsEnabled = true, metadata = WORKSPACE, currentUser = OWNER,
}: WindowOptions = {}) => (
  <ServerConfigContext.Provider value={{ userSearchEnabled, signupsEnabled } as ServerConfig}>
    <ShareModal open={open} onClose={() => {}} overseer={overseer} metadata={metadata} currentUser={currentUser}
      authenticatedApi={authenticatedApi} />
  </ServerConfigContext.Provider>
)

let root: Root | undefined
let container: HTMLDivElement | undefined

beforeEach(() => {
  workpieces = [ACCEPTED]
  liveSubscriber = undefined
  disposeWorkpieces.mockClear()
  subscribeToWorkpieces.mockClear()
  addCollaborator.mockClear()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  vi.unstubAllGlobals()
})

async function openShareWindow(options: WindowOptions = {}): Promise<HTMLElement> {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => root!.render(shareWindow(options)))
  await act(async () => { await Promise.resolve() })
  return container
}

async function rerenderShareWindow(options: WindowOptions) {
  await act(async () => root!.render(shareWindow(options)))
  await act(async () => { await Promise.resolve() })
}

const lineSaying = (rendered: HTMLElement, words: string) =>
  [...rendered.querySelectorAll('p')].find(line => line.textContent === words)

const roleShown = (rendered: HTMLElement) =>
  rendered.querySelector('button[aria-label="Access to grant"]')?.textContent

async function pickRole(rendered: HTMLElement, label: string) {
  const option = [...rendered.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(item => item.textContent?.startsWith(label))
  if (!option) throw new Error(`No role option "${label}" in: ${rendered.textContent}`)
  await act(async () => option.click())
}

async function typePerson(rendered: HTMLElement, id: string) {
  const input = rendered.querySelector<HTMLInputElement>('input[aria-label="Username or email"]')!
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  vi.useFakeTimers()
  try {
    await act(async () => {
      setValue.call(input, id)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => vi.advanceTimersByTimeAsync(225))
  } finally {
    vi.useRealTimers()
  }
}

function inviteButton(rendered: HTMLElement): HTMLButtonElement {
  const found = [...rendered.querySelectorAll('button')].find(candidate => candidate.textContent === 'Invite')
  if (!found) throw new Error(`No Invite button in: ${rendered.textContent}`)
  return found
}

describe('the "Not listed?" hint in the owner\'s Share window', () => {
  it("names this site's own address while user search and sign-ups are on", async () => {
    const rendered = await openShareWindow()
    expect(window.location.host).not.toBe('')
    expect(lineSaying(rendered, NOT_LISTED)).toBeDefined()
  })

  it('is left out while user search is off', async () => {
    const rendered = await openShareWindow({ userSearchEnabled: false })
    expect(rendered.querySelector('input[aria-label="Username or email"]')).not.toBeNull()
    expect(rendered.textContent).not.toContain('Not listed?')
  })

  it('is left out while sign-ups are off, since a first open then creates no account', async () => {
    const rendered = await openShareWindow({ signupsEnabled: false })
    expect(rendered.querySelector('input[aria-label="Search people"]')).not.toBeNull()
    expect(rendered.textContent).not.toContain('Not listed?')
  })

  it('is left out for a collaborator, who cannot invite', async () => {
    const rendered = await openShareWindow({ metadata: AS_COLLABORATOR, currentUser: COLLABORATOR })
    expect(rendered.textContent).toContain('Manage access.')
    expect(rendered.textContent).not.toContain('Not listed?')
  })
})

describe('the warning at "Gadget only" in a workspace with no gadgets', () => {
  it('shows at "Gadget only" when the only gadget is still pending', async () => {
    workpieces = [PENDING]
    const rendered = await openShareWindow()
    expect(roleShown(rendered)).toBe('Gadget only')
    expect(lineSaying(rendered, NO_GADGETS)).toBeDefined()
  })

  it('goes once "Workspace" is picked', async () => {
    workpieces = []
    const rendered = await openShareWindow()
    expect(lineSaying(rendered, NO_GADGETS)).toBeDefined()
    await pickRole(rendered, 'Workspace')
    expect(roleShown(rendered)).toBe('Workspace')
    expect(rendered.textContent).not.toContain('has no gadgets yet')
  })

  it('shows again when "Gadget only" is picked back', async () => {
    workpieces = []
    const rendered = await openShareWindow()
    await pickRole(rendered, 'Workspace')
    await pickRole(rendered, 'Gadget only')
    expect(lineSaying(rendered, NO_GADGETS)).toBeDefined()
  })

  it('is left out when the workspace has an accepted gadget', async () => {
    workpieces = [ACCEPTED, { ...PENDING, id: 2 }]
    const rendered = await openShareWindow()
    expect(roleShown(rendered)).toBe('Gadget only')
    expect(rendered.textContent).not.toContain('has no gadgets yet')
  })

  it('goes once a gadget is accepted while the window is open', async () => {
    workpieces = [PENDING]
    const rendered = await openShareWindow()
    expect(lineSaying(rendered, NO_GADGETS)).toBeDefined()
    await act(async () => liveSubscriber!.entry(ACCEPTED))
    expect(rendered.textContent).not.toContain('has no gadgets yet')
  })

  it('still lets the owner invite at "Gadget only" while it shows', async () => {
    workpieces = []
    const rendered = await openShareWindow({ userSearchEnabled: false })
    expect(lineSaying(rendered, NO_GADGETS)).toBeDefined()
    await typePerson(rendered, 'daniel@example.com')
    await act(async () => inviteButton(rendered).click())
    expect(addCollaborator).toHaveBeenCalledWith('daniel@example.com', 'use', undefined)
  })

  it('reads no workpieces while the window is closed', async () => {
    workpieces = []
    const rendered = await openShareWindow({ open: false })
    expect(rendered.querySelector('[data-testid="people-composer"]')).not.toBeNull()
    expect(subscribeToWorkpieces).not.toHaveBeenCalled()
    expect(rendered.textContent).not.toContain('has no gadgets yet')
  })

  it('stops reading workpieces when the window closes', async () => {
    workpieces = []
    const rendered = await openShareWindow()
    expect(subscribeToWorkpieces).toHaveBeenCalledOnce()
    expect(disposeWorkpieces).not.toHaveBeenCalled()
    expect(lineSaying(rendered, NO_GADGETS)).toBeDefined()
    await rerenderShareWindow({ open: false })
    expect(disposeWorkpieces).toHaveBeenCalledOnce()
    expect(rendered.textContent).not.toContain('has no gadgets yet')
  })

  it('never shows to a collaborator', async () => {
    workpieces = []
    const rendered = await openShareWindow({ metadata: AS_COLLABORATOR, currentUser: COLLABORATOR })
    expect(rendered.textContent).toContain('Manage access.')
    expect(rendered.textContent).not.toContain('has no gadgets yet')
    expect(subscribeToWorkpieces).not.toHaveBeenCalled()
  })
})
