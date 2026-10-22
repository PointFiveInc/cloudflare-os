// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CollaboratorRole, GadgetBindingInfo, ObserverBindingNeed } from '@gadgets/workshop-shared/api'

const addToast = vi.hoisted(() => vi.fn<(options: unknown) => void>())

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  const toasts = { add: addToast }
  return { ...actual, useKumoToastManager: () => toasts }
})

vi.mock('./AuthContext', () => {
  const context = { authenticatedApi: { listGatekeeperVendors: async () => [] }, currentUser: null }
  return { useAuthenticatedApi: () => context, useOptionalAuthenticatedApi: () => context }
})

import { makeTestRoot } from './action-test-harness'
import Connections from './Connections'

const view = makeTestRoot()

beforeEach(() => {
  addToast.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  view.cleanup()
  vi.restoreAllMocks()
})

const HEADING = 'Not used by any gadget'
const DESCRIPTION =
  'Connections in this workspace that no gadget uses. A Workspace collaborator must still verify their access to each one.'
const STILL_USED = 'A chat or a draft may still use one.'
const DENIED = "Unauthorized: this collaborator only has permission to use the gadget's UI."

type Connection = {
  id: number
  type: 'gatekeeper' | 'ambient'
  title: string
  url?: string
  usedByGadget: boolean
  boundHere?: { name: string; draft?: boolean }
}

const DRIVE: Connection = {
  id: 11, type: 'gatekeeper', title: 'Google Drive Account', url: 'https://drive.google.com/drive/my-drive',
  usedByGadget: false,
}
const SHEET: Connection = { id: 12, type: 'gatekeeper', title: 'Claims sheet', usedByGadget: true }
const AMBIENT: Connection = { id: 13, type: 'ambient', title: 'Workspace assistant', usedByGadget: false }
const DRAFT_DOC: Connection = {
  id: 14, type: 'gatekeeper', title: 'Draft doc', usedByGadget: false, boundHere: { name: 'DOC', draft: true },
}
const BOUND_DOC: Connection = {
  id: 15, type: 'gatekeeper', title: 'Bound doc', usedByGadget: true, boundHere: { name: 'DOC' },
}

/**
 * A workspace as the overseer reports it to a viewer: "Workspace" scope is every connection,
 * "Gadget only" scope the ones a gadget uses. A "Gadget only" viewer's overseer refuses both reads.
 */
function workspace(connections: Connection[], viewer: 'Workspace' | 'Gadget only' = 'Workspace') {
  const server = { connections: connections.map(c => ({ ...c })) }
  const need = (c: Connection): ObserverBindingNeed =>
    ({ gatekeeperId: c.id, vendorId: 'google', resourceTitle: c.title, resourceUrl: c.url })
  const removed: number[] = []
  const opened: number[] = []
  const disposed: number[] = []
  const scopesRead = new Set<CollaboratorRole>()
  let denied = 0
  const deny = () => {
    denied++
    throw new Error(DENIED)
  }
  const remove = vi.fn<(id: number) => Promise<void>>(async (id) => {
    server.connections = server.connections.filter(c => c.id !== id)
    removed.push(id)
  })
  const overseer = {
    listHooks: async () => [],
    listObserverRequirements: async (role: CollaboratorRole) => {
      scopesRead.add(role)
      if (viewer === 'Gadget only') deny()
      return server.connections.filter(c => role === 'build' || c.usedByGadget).map(need)
    },
    getGatekeeperById: async (id: number) => {
      if (viewer === 'Gadget only') deny()
      opened.push(id)
      return {
        getCreationSpec: async () => ({ type: server.connections.find(c => c.id === id)!.type, vendorId: 'google' }),
        remove: () => remove(id),
        [Symbol.dispose]: () => { disposed.push(id) },
      }
    },
    [Symbol.dispose]: () => {},
  }
  const unbind = vi.fn<(name: string) => Promise<void>>(async (name) => {
    const bound = server.connections.find(c => c.boundHere?.name === name)!
    bound.boundHere = undefined
    bound.usedByGadget = false
  })
  const gadget = {
    getId: async () => 1,
    getTitle: async () => 'Collections tracker',
    listBindings: async (): Promise<GadgetBindingInfo[]> => server.connections.filter(c => c.boundHere).map(c => ({
      name: c.boundHere!.name, target: c.id, resourceTitle: c.title, vendorId: 'google',
      ...(c.boundHere!.draft ? { chatId: 3 } : {}),
    })),
    unbind,
  }
  return { overseer, gadget, remove, unbind, removed, opened, disposed, scopesRead, denials: () => denied }
}

async function render(ws: ReturnType<typeof workspace>) {
  await view.render(
    <Connections overseer={ws.overseer as never} gadget={ws.gadget as never}
      authenticatedApi={{ listGatekeeperVendors: async () => [] } as never} />,
  )
  await act(async () => {})
}

const settle = () => act(async () => {})

function unusedHeading(): HTMLElement | null {
  return [...document.querySelectorAll('h2')].find(h => h.textContent === HEADING) ?? null
}

function unusedSection(): HTMLElement | null {
  return unusedHeading()?.closest('section') ?? null
}

function rowTitles(section: HTMLElement | null): string[] {
  return [...(section?.querySelectorAll('p.font-medium') ?? [])].map(p => p.textContent ?? '')
}

function button(section: HTMLElement, label: string): HTMLButtonElement {
  const found = [...section.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? b.textContent) === label)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`No "${label}" button`)
  return found
}

const click = (element: HTMLElement) => act(async () => element.click())

it('lists each connection no gadget uses with its address, and none a gadget uses, an ambient one or one this gadget binds', async () => {
  const ws = workspace([DRIVE, SHEET, AMBIENT, DRAFT_DOC])
  await render(ws)

  const section = unusedSection()
  const [ownConnections, next] = document.querySelectorAll('section')
  expect(ownConnections!.querySelector('h2')?.textContent).toBe('Connections')
  expect(next).toBe(section)
  expect(section?.textContent).toContain(DESCRIPTION)
  expect(rowTitles(section)).toEqual(['Google Drive Account'])
  expect(section?.textContent).toContain('https://drive.google.com/drive/my-drive')
  expect(ws.opened).not.toEqual([])
  expect(ws.disposed.toSorted()).toEqual(ws.opened.toSorted())
})

it('says under its heading that a chat or a draft may still use one', async () => {
  await render(workspace([DRIVE]))

  expect([...unusedHeading()!.parentElement!.children].map(child => child.textContent)).toEqual(
    [HEADING, DESCRIPTION, STILL_USED])
})

it('shows nothing when every connection is used by a gadget', async () => {
  const ws = workspace([SHEET, BOUND_DOC])
  await render(ws)

  expect([...ws.scopesRead].toSorted()).toEqual(['build', 'use'])
  expect(unusedSection()).toBeNull()
})

it('shows a "Gadget only" viewer no section and no toast', async () => {
  const ws = workspace([DRIVE, BOUND_DOC], 'Gadget only')
  await render(ws)

  expect(document.body.textContent).toContain('Bound doc')
  expect(ws.denials()).toBeGreaterThan(0)
  expect(document.body.textContent).not.toContain(HEADING)
  expect(addToast).not.toHaveBeenCalled()
})

it("deletes a connection from the workspace after its confirm, through the connection's own remove", async () => {
  const ws = workspace([DRIVE, SHEET])
  await render(ws)

  await click(button(unusedSection()!, 'Delete connection'))
  expect(unusedSection()?.textContent).toContain('Delete Google Drive Account?')
  expect(unusedSection()?.textContent).toContain('The connection will be removed from this workspace.')
  expect(ws.remove).not.toHaveBeenCalled()

  await click(button(unusedSection()!, 'Delete'))
  expect(ws.removed).toEqual([DRIVE.id])
  expect(ws.unbind).not.toHaveBeenCalled()
  expect(ws.disposed.toSorted()).toEqual(ws.opened.toSorted())
  expect(unusedSection()).toBeNull()
  expect(addToast).not.toHaveBeenCalled()
})

it('keeps the connection on Cancel', async () => {
  const ws = workspace([DRIVE])
  await render(ws)

  await click(button(unusedSection()!, 'Delete connection'))
  await click(button(unusedSection()!, 'Cancel'))

  expect(ws.remove).not.toHaveBeenCalled()
  expect(rowTitles(unusedSection())).toEqual(['Google Drive Account'])
})

it("lists a connection once this tab's delete unbinds it from the gadget", async () => {
  const ws = workspace([BOUND_DOC])
  await render(ws)
  expect(unusedSection()).toBeNull()

  const bindingRow = [...document.querySelectorAll('section')][0]!
  await click(button(bindingRow, 'Delete connection'))
  await click(button(bindingRow, 'Delete'))
  await settle()

  expect(ws.unbind).toHaveBeenCalledExactlyOnceWith('DOC')
  expect(rowTitles(unusedSection())).toEqual(['Bound doc'])
  expect(ws.remove).not.toHaveBeenCalled()
})

it('keeps a connection whose delete is refused, and says why', async () => {
  const ws = workspace([DRIVE])
  ws.remove.mockRejectedValueOnce(new Error(DENIED))
  await render(ws)

  await click(button(unusedSection()!, 'Delete connection'))
  await click(button(unusedSection()!, 'Delete'))

  expect(addToast).toHaveBeenCalledExactlyOnceWith(
    { title: 'Failed to remove connection', description: DENIED, variant: 'error' })
  expect(rowTitles(unusedSection())).toEqual(['Google Drive Account'])
  expect(ws.disposed.toSorted()).toEqual(ws.opened.toSorted())
})
