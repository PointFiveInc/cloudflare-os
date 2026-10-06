// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createOpenGadgetError,
  OPEN_GADGET_ERROR_CODES,
  type CollaboratorRole,
  type WorkpieceSummary,
  type WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  authenticatedApi: null as unknown,
  gadgetUiMounts: 0,
}))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: () => {} }),
}))

vi.mock('./GadgetUI', () => ({
  default: ({ gadget }: { gadget: { name: string } }) => {
    useEffect(() => {
      testState.gadgetUiMounts++
    }, [])
    return <div data-testid="gadget-ui">{gadget.name}</div>
  },
}))

vi.mock('./GadgetExportMenu', () => ({
  default: ({ gadgetTitle }: { gadgetTitle: string }) => (
    <div data-testid="export-menu">{gadgetTitle}</div>
  ),
}))

import { Route as AppsRouteImport } from './routes/apps.$workspaceId.$gadgetId.$'
import { parseAppLocation } from './appLocation'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom doesn't implement scrolling; the router's scroll restoration calls it on mount.
window.scrollTo = () => {}

const disposable = () => ({ [Symbol.dispose]: () => {} })

const gadgetSummary = (id: number, extra: Partial<WorkpieceSummary> = {}) =>
  ({ id, type: 'gadget', title: `Gadget ${id}`, ...extra }) as WorkpieceSummary

// The use role's restricted overseer allows only these; the backend refuses everything else.
const USE_SURFACE = new Set(['subscribeToMetadata', 'subscribeToWorkpieces', 'getGadget'])

type FakeWorkspace = {
  role?: CollaboratorRole
  workpieces?: WorkpieceSummary[]
  openError?: Error
}

const fakeAuthenticatedApi = ({ role, workpieces = [gadgetSummary(0)], openError }: FakeWorkspace) => {
  const calledMethods = new Set<string>()
  const overseer = new Proxy({} as Record<string | symbol, unknown>, {
    get: (_target, property) => {
      if (property === Symbol.dispose) return () => {}
      if (typeof property !== 'string' || property === 'then') return undefined
      calledMethods.add(property)
      switch (property) {
        case 'subscribeToMetadata':
          return async (onMetadata: (metadata: unknown) => void) => {
            if (openError) throw openError
            onMetadata({ id: 'ws', title: 'Workspace', role })
            return disposable()
          }
        case 'subscribeToWorkpieces':
          return async (subscriber: WorkpiecesSubscriber) => {
            if (openError) throw openError
            for (const summary of workpieces) subscriber.entry(summary)
            subscriber.ready()
            return disposable()
          }
        case 'getGadget':
          return (id: number) => ({ name: `client ${id}`, ...disposable() })
        default:
          return () => Promise.resolve()
      }
    },
  })
  const openGadget = vi.fn<(id: string, shareKey?: string, configure?: unknown) => unknown>(() => overseer)
  testState.authenticatedApi = { openGadget }
  return { openGadget, calledMethods }
}

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  testState.gadgetUiMounts = 0
})

// The real route module, wired the way routeTree.gen.ts wires it, on a real browser history:
// share redemption reads the hash from window.location.
const renderAt = async (url: string) => {
  window.history.replaceState(null, '', url)
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const appsRoute = AppsRouteImport.update({
    id: '/apps/$workspaceId/$gadgetId/$',
    path: '/apps/$workspaceId/$gadgetId/$',
    getParentRoute: () => rootRoute,
  } as never)
  const workspacesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workspaces',
    component: () => <div data-testid="workspaces" />,
  })
  const router = createRouter({
    history: createBrowserHistory(),
    routeTree: rootRoute.addChildren([appsRoute, workspacesRoute]),
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<RouterProvider router={router} />))
  await settle()
  return { router, page: container }
}

const settle = async () => {
  for (let tick = 0; tick < 5; tick++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  }
}

// The router plugin code-splits the route's component; load it once up front rather than inside
// the first test's render.
beforeAll(async () => {
  await (AppsRouteImport.options.component as { preload?: () => Promise<void> }).preload?.()
}, 60_000)

const currentUrl = () => window.location.pathname + window.location.search + window.location.hash

describe('app page location', () => {
  it('parses gadget id 0 and the inner path from the splat', () => {
    expect(parseAppLocation({ workspaceId: 'ws', gadgetId: '0', _splat: 'a/b' }))
      .toEqual({ workspaceId: 'ws', gadgetId: 0, innerPath: '/a/b' })
    expect(parseAppLocation({ workspaceId: 'ws', gadgetId: '12' }))
      .toEqual({ workspaceId: 'ws', gadgetId: 12, innerPath: '/' })
  })

  it('matches no gadget for a segment that is not a workpiece id', () => {
    for (const segment of ['', 'x', '-1', '01', '1.5', '1e3', '99999999999999999999']) {
      expect(parseAppLocation({ workspaceId: 'ws', gadgetId: segment }).gadgetId).toBeNull()
    }
  })
})

describe('GadgetAppView', () => {
  it('opens gadget 0 at its inner path and leaves the link in place', async () => {
    const { openGadget } = fakeAuthenticatedApi({ role: 'build' })
    const { page } = await renderAt('/apps/ws/0/a/b')

    expect(openGadget).toHaveBeenCalledWith('ws', undefined, expect.anything())
    expect(page.querySelector('[data-testid="gadget-ui"]')?.textContent).toBe('client 0')
    expect(page.querySelector('[data-testid="export-menu"]')?.textContent).toBe('Gadget 0')
    expect(currentUrl()).toBe('/apps/ws/0/a/b')
  })

  it('renders only the gadget for a use-role open, never the editor', async () => {
    const { calledMethods } = fakeAuthenticatedApi({ role: 'use' })
    const { page } = await renderAt('/apps/ws/0/a/b')

    expect(page.querySelector('[data-testid="gadget-ui"]')).not.toBeNull()
    expect(page.querySelector('textarea')).toBeNull()
    expect(page.querySelector('[aria-label="Share workspace"]')).toBeNull()
    expect([...calledMethods].filter(name => !USE_SURFACE.has(name))).toEqual([])
  })

  it('redeems #share= and strips only the hash, keeping the inner path and query', async () => {
    const { openGadget } = fakeAuthenticatedApi({ role: 'use' })
    const historyLength = window.history.length
    const { page } = await renderAt('/apps/ws/0/a/b?x=1#share=key123')

    expect(openGadget).toHaveBeenCalledWith('ws', 'key123', expect.anything())
    expect(currentUrl()).toBe('/apps/ws/0/a/b?x=1')
    expect(window.history.length).toBe(historyLength)
    expect(page.querySelector('[data-testid="gadget-ui"]')).not.toBeNull()
  })

  it('shows the open-error page when the viewer has no access', async () => {
    fakeAuthenticatedApi({
      openError: createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied),
    })
    const { page } = await renderAt('/apps/ws/0/a/b')

    expect(page.textContent).toContain("You don't have access to this workspace")
    expect(page.querySelector('[data-testid="gadget-ui"]')).toBeNull()
  })

  it('shows the not-found page for a gadget the workspace does not have, or only as a draft', async () => {
    fakeAuthenticatedApi({ role: 'build', workpieces: [gadgetSummary(0), gadgetSummary(1, { chatId: 3 })] })

    for (const url of ['/apps/ws/7/a', '/apps/ws/1/a', '/apps/ws/x/a']) {
      const { page } = await renderAt(url)
      expect(page.textContent).toContain('Workspace not found')
      expect(page.querySelector('[data-testid="gadget-ui"]')).toBeNull()
      await act(async () => root?.unmount())
      container?.remove()
      root = undefined
    }
  })

  it('keeps the workspace open and the frame mounted while the inner path changes', async () => {
    const { openGadget } = fakeAuthenticatedApi({ role: 'use' })
    const { router } = await renderAt('/apps/ws/0/a')

    await act(async () => {
      await router.navigate({
        to: '/apps/$workspaceId/$gadgetId/$',
        params: { workspaceId: 'ws', gadgetId: '0', _splat: 'b' },
      } as never)
    })
    expect(currentUrl()).toBe('/apps/ws/0/b')
    await act(async () => router.history.back())
    await settle()
    expect(currentUrl()).toBe('/apps/ws/0/a')

    expect(openGadget).toHaveBeenCalledTimes(1)
    expect(testState.gadgetUiMounts).toBe(1)
  })
})
