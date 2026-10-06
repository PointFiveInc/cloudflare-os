// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentType, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { PublicApi } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({ pathname: '/' }))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: testState.pathname } }),
  Outlet: () => <div data-testid="outlet">routed page</div>,
}))

vi.mock('./useAuth', () => ({
  CF_ACCESS_MODE: false,
  useAuth: () => ({
    isAuthenticated: true,
    authenticatedApi: {
      isOnboardingCompleted: () => Promise.resolve(true),
      whoami: () => Promise.resolve(null),
      amIAdmin: () => Promise.resolve(false),
    },
    isLoading: false,
    error: null,
    login: () => {},
    logout: () => {},
  }),
}))

vi.mock('./FeatureFlagsContext', () => ({
  FeatureFlagsProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('./components/billing/AccountSelectionModal', () => ({ default: () => null }))
vi.mock('./components/AppShell/AppShell', () => ({
  default: ({ children }: { children: ReactNode }) => <div data-testid="app-shell">{children}</div>,
}))

import { Route } from './routes/__root'
import { RpcContext } from './RpcContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RootComponent = Route.options.component as ComponentType

describe('root route for the app page', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
  })

  const renderAt = async (pathname: string) => {
    testState.pathname = pathname
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <RpcContext.Provider value={{ stub: {} as RpcStub<PublicApi>, connectionLost: false }}>
          <RootComponent />
        </RpcContext.Provider>,
      )
    })
    return container
  }

  it('renders /apps/ pages without the app shell', async () => {
    const page = await renderAt('/apps/ws/0/a/b')

    expect(page.querySelector('[data-testid="outlet"]')).not.toBeNull()
    expect(page.querySelector('[data-testid="app-shell"]')).toBeNull()
  })

  it('still wraps other signed-in pages in the app shell', async () => {
    const page = await renderAt('/workspaces')

    expect(page.querySelector('[data-testid="app-shell"] [data-testid="outlet"]')).not.toBeNull()
  })
})
