// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createBrowserHistory,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { newMessagePortRpcSession, RpcStub, RpcTarget } from 'capnweb'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  resolveSiteName,
  type GadgetClient,
  type WorkpieceSummary,
  type WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({ authenticatedApi: null as unknown }))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: () => {} }),
}))

vi.mock('./GadgetExportMenu', () => ({ default: () => null }))

import GadgetUI from './GadgetUI'
import { Route as AppsRouteImport } from './routes/apps.$workspaceId.$gadgetId.$'
import { WORKSHOP_FRAME, WorkshopBridge, WorkshopHost, type AppPageRoute } from './workshopBridge'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom doesn't implement scrolling; the router's scroll restoration calls it on mount.
window.scrollTo = () => {}

type Workshop = {
  ready: Promise<void>
  location: { readonly path: string }
  readonly appUrl: string | null
  navigate(path: unknown, options?: { replace?: boolean }): Promise<void>
  setTitle(text: unknown): Promise<void>
}

const frameGlobal = globalThis as typeof globalThis & { workshop?: Workshop }

class TestGadget extends RpcTarget {
  ping() {
    return 'pong'
  }
}

const fakeGadgetClient = () => ({
  connectToGadget: async () => new RpcStub(new TestGadget()),
  getUiBundle: async () => ({ jsCode: 'document.body.textContent = "gadget"' }),
  [Symbol.dispose]: () => {},
}) as unknown as RpcStub<GadgetClient>

const disposable = () => ({ [Symbol.dispose]: () => {} })

const fakeWorkspace = () => {
  const overseer = new Proxy({} as Record<string | symbol, unknown>, {
    get: (_target, property) => {
      if (property === Symbol.dispose) return () => {}
      if (typeof property !== 'string' || property === 'then') return undefined
      switch (property) {
        case 'subscribeToMetadata':
          return async (onMetadata: (metadata: unknown) => void) => {
            onMetadata({ id: 'ws', title: 'Workspace', role: 'use', owner: { type: 'user', id: 'o', name: 'Olive' } })
            return disposable()
          }
        case 'subscribeToWorkpieces':
          return async (subscriber: WorkpiecesSubscriber) => {
            subscriber.entry({ id: 0, type: 'gadget', title: 'Gadget 0' } as WorkpieceSummary)
            subscriber.ready()
            return disposable()
          }
        case 'getGadget':
          return () => fakeGadgetClient()
        default:
          return () => Promise.resolve()
      }
    },
  })
  testState.authenticatedApi = { openGadget: () => overseer }
}

let root: Root | undefined
let container: HTMLDivElement | undefined
const sessions: { [Symbol.dispose](): void }[] = []

afterEach(async () => {
  for (const session of sessions.splice(0)) session[Symbol.dispose]()
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  delete frameGlobal.workshop
  vi.restoreAllMocks()
})

const settle = async () => {
  for (let tick = 0; tick < 5; tick++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  }
}

const mount = async (element: ReactNode) => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(element))
  await settle()
  return container
}

// The real route module, wired the way routeTree.gen.ts wires it, on a real browser history.
const renderAppPage = async (url: string) => {
  window.history.replaceState(null, '', url)
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const appsRoute = AppsRouteImport.update({
    id: '/apps/$workspaceId/$gadgetId/$',
    path: '/apps/$workspaceId/$gadgetId/$',
    getParentRoute: () => rootRoute,
  } as never)
  const router = createRouter({ history: createBrowserHistory(), routeTree: rootRoute.addChildren([appsRoute]) })
  fakeWorkspace()
  const page = await mount(<RouterProvider router={router} />)
  return { router, page }
}

// Does what the frame prelude does: evaluates the frame half, exports it on the gadget's session,
// and hands the host the other end of the port.
const connectFrame = async (page: HTMLElement) => {
  await vi.waitFor(() => expect(page.querySelector('iframe')).not.toBeNull())
  const frameExport = new Function('RpcTarget', `return ${WORKSHOP_FRAME}`)(RpcTarget)
  const { port1, port2 } = new MessageChannel()
  sessions.push(newMessagePortRpcSession(port1, frameExport))
  window.dispatchEvent(new MessageEvent('message', {
    data: 'handshake',
    origin: 'null',
    source: page.querySelector('iframe')!.contentWindow,
    ports: [port2],
  }))
  const workshop = frameGlobal.workshop!
  await act(async () => { await workshop.ready })
  return workshop
}

const navigateIn = async (workshop: Workshop, path: unknown, options?: { replace?: boolean }) => {
  await act(async () => { await workshop.navigate(path, options) })
  await settle()
}

// Every workshop:location event since the last call.
const locationPaths: string[] = []
window.addEventListener('workshop:location', event => {
  locationPaths.push((event as CustomEvent<{ path: string }>).detail.path)
})
const locationEvents = () => {
  locationPaths.length = 0
  return locationPaths
}

const currentUrl = () => window.location.pathname + window.location.search + window.location.hash

// The router plugin code-splits the route's component; load it once up front.
beforeAll(async () => {
  await (AppsRouteImport.options.component as { preload?: () => Promise<void> }).preload?.()
}, 60_000)

describe('workshop on the app page', () => {
  it('holds the inner path and the app URL once the frame has connected', async () => {
    const { page } = await renderAppPage('/apps/ws/0/start/here?x=1')
    const workshop = await connectFrame(page)

    expect(workshop.location.path).toBe('/start/here')
    expect(workshop.appUrl).toBe(`${window.location.origin}/apps/ws/0`)
  })

  it('builds an app URL that the route opens at the place appended to it', async () => {
    const { page, router } = await renderAppPage('/apps/ws/0')
    const workshop = await connectFrame(page)
    const paths = locationEvents()

    const link = new URL(`${workshop.appUrl}/pieces/42`)
    expect(link.origin).toBe(window.location.origin)
    await act(async () => { await router.navigate({ href: link.pathname }) })
    await settle()

    expect(currentUrl()).toBe('/apps/ws/0/pieces/42')
    expect(workshop.location.path).toBe('/pieces/42')
    expect(paths).toEqual(['/pieces/42'])
  })

  it('moves the address bar on navigate, and fires workshop:location on Back and Forward', async () => {
    const { page } = await renderAppPage('/apps/ws/0/start?x=1')
    const workshop = await connectFrame(page)
    const paths = locationEvents()
    const startLength = window.history.length

    await navigateIn(workshop, '/a')
    expect(currentUrl()).toBe('/apps/ws/0/a?x=1')
    expect(workshop.location.path).toBe('/a')
    expect(window.history.length).toBe(startLength + 1)

    await navigateIn(workshop, '/b', { replace: true })
    expect(currentUrl()).toBe('/apps/ws/0/b?x=1')
    expect(window.history.length).toBe(startLength + 1)
    expect(paths).toEqual([])

    await act(async () => window.history.back())
    await settle()
    expect(currentUrl()).toBe('/apps/ws/0/start?x=1')
    expect(workshop.location.path).toBe('/start')

    await act(async () => window.history.forward())
    await settle()
    expect(workshop.location.path).toBe('/b')
    expect(paths).toEqual(['/start', '/b'])
  })

  it('fires nothing for its own navigations, however quickly they follow each other', async () => {
    const { page } = await renderAppPage('/apps/ws/0/start')
    const workshop = await connectFrame(page)
    const paths = locationEvents()

    await act(async () => {
      await Promise.all(['/a', '/b', '/c'].map(path => workshop.navigate(path)))
    })
    await settle()
    expect(currentUrl()).toBe('/apps/ws/0/c')
    expect(workshop.location.path).toBe('/c')
    expect(paths).toEqual([])
  })

  it('refuses every path the address bar may not carry', async () => {
    const { page } = await renderAppPage('/apps/ws/0/start')
    const workshop = await connectFrame(page)
    const startLength = window.history.length
    const refused: unknown[] = [
      42, null, '', 'a/b', 'https://evil.example/', '//evil.example/x', '/\\evil.example',
      '/a\\b', '/a?next=/x', '/a#share=key', '/a\u0000', '/a\nb', '/a\u007f', '/a\u0085',
      '/.', '/a/./b', '/..', '/a/../../workspaces', '/a//b', '/a/', `/${'a'.repeat(1024)}`,
    ]

    const outcomes = await Promise.allSettled(refused.map(path => workshop.navigate(path)))
    expect(refused.filter((_path, index) => outcomes[index].status !== 'rejected')).toEqual([])
    for (const outcome of outcomes) {
      expect((outcome as PromiseRejectedResult).reason.message).toMatch(/^workshop\.navigate\(\): /)
    }
    await settle()
    expect(currentUrl()).toBe('/apps/ws/0/start')
    expect(window.history.length).toBe(startLength)
    expect(workshop.location.path).toBe('/start')

    await navigateIn(workshop, `/${'a'.repeat(1023)}`)
    expect(workshop.location.path).toHaveLength(1024)
  })

  it('keeps every accepted path inside the app page and reads it back unchanged', async () => {
    const { page } = await renderAppPage('/apps/ws/0')
    const workshop = await connectFrame(page)
    const paths = locationEvents()

    for (const path of ['/a b', '/ü/%2e%2e/x', '/100%', '/%41', '/a+b;c=d&e', '/@x/:y/~z', '/\'"<>`{}']) {
      await navigateIn(workshop, path)
      expect(window.location.origin + window.location.pathname)
        .toMatch(new RegExp(`^${window.location.origin}/apps/ws/0/[^/]`))
      expect(workshop.location.path).toBe(path)
    }
    expect(paths).toEqual([])
  })

  it('stops adding history entries past ten in ten seconds, replacing instead', async () => {
    const { page } = await renderAppPage('/apps/ws/0')
    const workshop = await connectFrame(page)
    const startLength = window.history.length

    for (let step = 0; step < 12; step++) await navigateIn(workshop, `/p${step}`)
    expect(window.history.length).toBe(startLength + 10)
    expect(currentUrl()).toBe('/apps/ws/0/p11')

    const later = Date.now() + 10_001
    vi.spyOn(Date, 'now').mockReturnValue(later)
    await navigateIn(workshop, '/p12')
    expect(window.history.length).toBe(startLength + 11)
  })

  it('titles the tab with the text ahead of the gadget title', async () => {
    const { page } = await renderAppPage('/apps/ws/0')
    const workshop = await connectFrame(page)
    const site = resolveSiteName(undefined)

    expect(document.title).toBe(`Gadget 0 - ${site}`)
    await act(async () => { await workshop.setTitle('Draft 42') })
    expect(document.title).toBe(`Draft 42 – Gadget 0 - ${site}`)
    await act(async () => { await workshop.setTitle('‮Sign\n in\u0000') })
    expect(document.title).toBe(`Sign in – Gadget 0 - ${site}`)
    await expect(workshop.setTitle(7)).rejects.toThrow(/workshop\.setTitle\(\)/)
  })

  it('gives the frame navigate and setTitle and nothing else', () => {
    expect(Object.getOwnPropertyNames(WorkshopHost.prototype).toSorted())
      .toEqual(['constructor', 'navigate', 'setTitle'])
  })
})

describe('workshop outside the app page', () => {
  it('keeps the path itself and never touches the address bar', async () => {
    window.history.replaceState(null, '', '/workspace/ws?w=0')
    const startLength = window.history.length
    const startTitle = document.title
    const page = await mount(<GadgetUI gadget={fakeGadgetClient()} height="100px" />)
    const workshop = await connectFrame(page)

    expect(workshop.location.path).toBe('/')
    expect(workshop.appUrl).toBeNull()
    await navigateIn(workshop, '/a/b')
    await act(async () => { await workshop.setTitle('Elsewhere') })
    expect(workshop.location.path).toBe('/a/b')
    await expect(workshop.navigate('/a?b')).rejects.toThrow(/workshop\.navigate\(\)/)
    expect(currentUrl()).toBe('/workspace/ws?w=0')
    expect(window.history.length).toBe(startLength)
    expect(document.title).toBe(startTitle)
  })
})

describe('the frame half', () => {
  it('declares nothing a gadget might declare itself, and reads globals it may shadow up front', () => {
    const run = new Function('RpcTarget', `
      const frame = ${WORKSHOP_FRAME};
      let workshop = 'the gadget\\'s own';
      let CustomEvent = null;
      let Promise = null;
      return { frame, workshop };
    `)
    const { frame, workshop } = run(RpcTarget)
    const paths = locationEvents()
    frame.moved({ path: '/z', appUrl: null })

    expect(workshop).toBe('the gadget\'s own')
    expect(frameGlobal.workshop!.location.path).toBe('/z')
    expect(paths).toEqual(['/z'])
  })
})

describe('the bridge following the route', () => {
  it('knows its own navigations even when the route reports them late or in between', () => {
    const navigations: string[] = []
    const route = (path: string): AppPageRoute => ({
      path,
      appUrl: 'https://os.example/apps/ws/0',
      onNavigate: next => navigations.push(next),
      onSetTitle: () => {},
    })
    const moved: string[] = []
    const bridge = new WorkshopBridge(route('/start'))
    bridge.attach({
      attach: () => Promise.resolve(),
      moved: (state: { path: string }) => {
        moved.push(state.path)
        return Promise.resolve()
      },
    } as never)

    bridge.navigate('/a', false)
    bridge.navigate('/b', false)
    for (const reported of ['/start', '/a', '/b']) bridge.follow(route(reported))
    expect(moved).toEqual([])
    expect(navigations).toEqual(['/a', '/b'])

    bridge.follow(route('/a'))
    expect(moved).toEqual(['/a'])
  })
})
