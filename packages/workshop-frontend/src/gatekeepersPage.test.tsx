// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentType, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ConnectedAccountsSubscriber } from '@gadgets/workshop-shared/api'

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ to, params, children, ...rest }: {
    to: string
    params?: Record<string, string>
    children: ReactNode
    'aria-label'?: string
  }) => (
    <a
      href={to.replace(/\$(\w+)/g, (_, key: string) => params?.[key] ?? '')}
      aria-label={rest['aria-label']}
    >
      {children}
    </a>
  ),
}))
vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: () => {} }),
}))
vi.mock('./ServerConfigContext', () => ({ useSiteName: () => 'Workshop' }))
vi.mock('./components/ConnectConnectorModal', () => ({ default: () => null }))
vi.mock('./useGatekeeperApps', () => ({
  refreshGatekeeperApps: () => {},
  useGatekeeperApps: () => [
    { id: 'salesforce', title: 'Salesforce' },
    { id: 'jira', title: 'Jira' },
    { id: 'newsletters', title: 'Newsletters' },
  ],
}))

const account = (id: number, vendorId: string, displayName: string, credentialsValid = true) => (
  subscriber: ConnectedAccountsSubscriber,
) =>
  subscriber.add(
    id,
    { displayName: `${displayName} account`, avatar: { url: 'https://example.com/avatar' } },
    { displayName, url: 'https://example.com' },
    [],
    credentialsValid,
    vendorId,
  )

const accounts = [
  account(1, 'salesforce', 'Salesforce'),
  account(2, 'gmail', 'Gmail'),
  account(3, 'jira', 'Jira', false),
]

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi }),
}))

const authenticatedApi = {
  listAddableGatekeepers: () => Promise.resolve([]),
  listGatekeeperVendors: () => Promise.resolve([]),
  subscribeConnectedAccounts: (subscriber: ConnectedAccountsSubscriber) => {
    for (const add of accounts) add(subscriber)
    subscriber.ready()
    return Object.assign(Promise.resolve(), { [Symbol.dispose]: () => {} })
  },
}

import { Route } from './routes/gatekeepers'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The router plugin code-splits route components; preload resolves the real one before rendering.
const ConnectorsPage = Route.options.component as ComponentType & { preload?: () => Promise<void> }

describe('Gatekeepers page', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  beforeAll(async () => {
    await ConnectorsPage.preload?.()
  }, 60_000)

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
  })

  it("links every gatekeeper's own page, from its card or, with no card, from Built in", async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(<ConnectorsPage />))

    const appLinks = [...container.querySelectorAll('a')].filter((a) =>
      a.getAttribute('href')?.startsWith('/gatekeepers/'),
    )
    expect(appLinks.map((a) => [a.getAttribute('href'), a.textContent])).toEqual([
      ['/gatekeepers/salesforce', 'View page'],
      ['/gatekeepers/newsletters', 'Newsletters'],
    ])
  })
})
