// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider,
} from '@tanstack/react-router'
import type { GadgetMetadataWithTimestamps } from '@gadgets/workshop-shared/api'

const mocks = vi.hoisted(() => {
  const state = { gadgets: [] as unknown[] }
  return {
    state,
    authenticatedApi: {
      whoami: async () => ({ type: 'user', id: 'dana@example.com', name: 'Dana' }),
      listGadgets: async () => state.gadgets,
    },
  }
})

vi.mock('@cloudflare/kumo', () => {
  const DropdownMenu = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Trigger: ({ render }: { render: ReactElement }) => render,
      Content: () => null,
      Item: () => null,
      Separator: () => null,
    },
  )
  const Dialog = Object.assign(() => null, { Root: () => null, Title: () => null, Close: () => null })
  return { Button: () => null, Dialog, DropdownMenu, useKumoToastManager: () => ({ add: () => {} }) }
})
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: mocks.authenticatedApi }) }))
vi.mock('./ShareModal', () => ({ default: () => null }))
vi.mock('./components/DeleteConfirmationDialog', () => ({ default: () => null }))

import GadgetList from './components/GadgetList'
import SidebarGadgetRow from './components/AppShell/SidebarGadgetRow'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
window.scrollTo = () => {}

const ALEX = { type: 'user' as const, id: 'alex@example.com', name: 'Alex' }

function workspace(id: string, title: string, p5Mark?: unknown): GadgetMetadataWithTimestamps {
  return { id, title, owner: ALEX, created: new Date(), lastActive: new Date(), p5Mark } as GadgetMetadataWithTimestamps
}

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

async function renderLists(workspaces: GadgetMetadataWithTimestamps[]) {
  mocks.state.gadgets = workspaces
  const handlers = {
    onTogglePin: () => {}, onRename: () => {}, onShare: () => {}, onNotificationMuteChange: () => {}, onDelete: () => {},
  }
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <nav>{workspaces.map(gadget => <SidebarGadgetRow key={gadget.id} gadget={gadget} {...handlers} />)}</nav>
        <main><GadgetList showHeader={false} /></main>
      </>
    ),
  })
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: '/workspace/$id', component: () => null }),
  ])
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/'] }) })
  const target = document.body.appendChild(document.createElement('div'))
  const reactRoot = createRoot(target)
  container = target
  root = reactRoot
  await act(async () => reactRoot.render(<RouterProvider router={router} />))
  await act(async () => { await router.load() })
  return router
}

function rowLink(list: 'nav' | 'main', title: string): HTMLAnchorElement {
  const found = [...(container?.querySelectorAll<HTMLAnchorElement>(`${list} a`) ?? [])]
    .find(link => link.textContent?.includes(title))
  if (!found) throw new Error(`No ${list} row for "${title}" in: ${container?.textContent}`)
  return found
}

function chip(title: string) {
  const found = rowLink('nav', title).querySelector('[role="img"]')
  return found && { text: found.textContent, name: found.getAttribute('aria-label'), title: found.getAttribute('title') }
}

const lines = (title: string) => [...rowLink('main', title).querySelectorAll('p')].map(line => line.textContent)

describe('the marks on the sidebar and the Workspaces list', () => {
  it('draws a share mark and a mention mark in both lists', async () => {
    await renderLists([
      workspace('both-share', 'Q3 plan', { kind: 'share', by: 'Alex' }),
      workspace('both-mention', 'Denials', { kind: 'mention', by: 'Bob', chatId: 3, chatTitle: 'March denials' }),
      workspace('both-new-chat', 'KPIs', { kind: 'mention', by: 'Bob', chatId: 0 }),
    ])

    expect(chip('Q3 plan')).toEqual({ text: 'new', name: 'new · shared by Alex', title: 'new · shared by Alex' })
    expect(chip('Denials')).toEqual({
      text: '@', name: "Bob mentioned you in 'March denials'", title: "Bob mentioned you in 'March denials'",
    })
    expect(chip('KPIs')).toEqual({
      text: '@', name: 'Bob mentioned you in a new chat', title: 'Bob mentioned you in a new chat',
    })
    expect(lines('Q3 plan')).toEqual(['Shared by Alex', 'new'])
    expect(lines('Denials')).toEqual(['Shared by Alex', "Bob mentioned you in 'March denials'"])
    expect(lines('KPIs')).toEqual(['Shared by Alex', 'Bob mentioned you in a new chat'])
  })

  it("links a mention mark's row to its chat, and a share mark's row to the workspace", async () => {
    await renderLists([
      workspace('link-share', 'Q3 plan', { kind: 'share', by: 'Alex' }),
      workspace('link-mention', 'Denials', { kind: 'mention', by: 'Bob', chatId: 3, chatTitle: 'March denials' }),
      workspace('link-new-chat', 'KPIs', { kind: 'mention', by: 'Bob', chatId: 0 }),
    ])

    for (const list of ['nav', 'main'] as const) {
      expect(rowLink(list, 'Q3 plan').getAttribute('href')).toBe('/workspace/link-share')
      expect(rowLink(list, 'Denials').getAttribute('href')).toBe('/workspace/link-mention?chat=3&showChat=true')
      expect(rowLink(list, 'KPIs').getAttribute('href')).toBe('/workspace/link-new-chat?chat=0&showChat=true')
    }
  })

  it('draws nothing for no mark or a kind it does not know, and keeps the link plain', async () => {
    await renderLists([
      workspace('plain-none', 'AR aging'),
      workspace('plain-retired', 'Payer mix', { kind: 'retired', by: 'Alex', chatId: 4 }),
    ])

    for (const [title, id] of [['AR aging', 'plain-none'], ['Payer mix', 'plain-retired']]) {
      expect(chip(title)).toBeNull()
      expect(lines(title)).toEqual(['Shared by Alex'])
      expect(rowLink('nav', title).getAttribute('href')).toBe(`/workspace/${id}`)
      expect(rowLink('main', title).getAttribute('href')).toBe(`/workspace/${id}`)
    }
  })

  it('hides the mark and drops its chat link on that workspace, and after leaving it', async () => {
    const router = await renderLists([
      workspace('open-mention', 'Denials', { kind: 'mention', by: 'Bob', chatId: 3, chatTitle: 'March denials' }),
      workspace('open-other', 'Q3 plan', { kind: 'share', by: 'Alex' }),
    ])
    const marked = () => ({
      chip: chip('Denials'),
      line: lines('Denials').includes("Bob mentioned you in 'March denials'"),
      hrefs: [rowLink('nav', 'Denials').getAttribute('href'), rowLink('main', 'Denials').getAttribute('href')],
    })
    expect(marked().chip).not.toBeNull()

    await act(async () => { await router.navigate({ to: '/workspace/$id', params: { id: 'open-mention' } }) })
    expect(marked()).toEqual({ chip: null, line: false, hrefs: ['/workspace/open-mention', '/workspace/open-mention'] })

    await act(async () => { await router.navigate({ to: '/' }) })
    expect(marked()).toEqual({ chip: null, line: false, hrefs: ['/workspace/open-mention', '/workspace/open-mention'] })
    expect(chip('Q3 plan')?.text).toBe('new')
    expect(lines('Q3 plan')).toEqual(['Shared by Alex', 'new'])
  })
})
