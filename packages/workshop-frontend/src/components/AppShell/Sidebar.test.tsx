// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GatekeeperAppInfo } from '@gadgets/workshop-shared/api'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children }: { to: string; params?: Record<string, string>; children: ReactNode }) => (
    <a href={to.replace(/\$(\w+)/g, (_, key: string) => params?.[key] ?? '')}>{children}</a>
  ),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: '/' } }),
}))
vi.mock('../../ServerConfigContext', () => ({ useSiteName: () => 'Workshop' }))
vi.mock('../SiteLogo', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('./SidebarWorkspaces', () => ({
  SidebarWorkspacesProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  SidebarWorkspacesTools: () => null,
  SidebarWorkspacesLists: () => null,
}))
vi.mock('./SidebarUtilityStrip', () => ({ default: () => null }))

let gatekeeperApps: GatekeeperAppInfo[] = []
vi.mock('../../useGatekeeperApps', () => ({ useGatekeeperApps: () => gatekeeperApps }))

const otherApps: GatekeeperAppInfo[] = [
  { id: 'brain', title: 'The Brain' },
  { id: 'salesforce', title: 'Salesforce' },
  { id: 'google', title: 'Google' },
]
const contextApp: GatekeeperAppInfo = {
  id: 'context',
  title: 'Context & Skills',
  icon: { url: 'https://example.com/library.svg' },
}

import Sidebar from './Sidebar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function connectorPageLinks(sidebar: HTMLElement) {
  return [...sidebar.querySelectorAll('a')]
    .filter((a) => a.getAttribute('href')?.startsWith('/gatekeepers/'))
    .map((a) => [a.getAttribute('href'), a.textContent])
}

describe('Sidebar', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
  })

  function renderSidebar(apps: GatekeeperAppInfo[]) {
    gatekeeperApps = apps
    container = document.createElement('div')
    root = createRoot(container)
    act(() => root!.render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />))
    return container
  }

  it('lists Context & Skills as its only connector page, beside the Gatekeepers page', () => {
    const sidebar = renderSidebar([...otherApps, contextApp])

    expect(connectorPageLinks(sidebar)).toEqual([['/gatekeepers/context', 'Context & Skills']])
    expect(sidebar.textContent).not.toContain('The Brain')
    expect(sidebar.textContent).not.toContain('Salesforce')
    expect(sidebar.textContent).not.toContain('Google')
    expect(sidebar.querySelector('a[href="/gatekeepers"]')?.textContent).toBe('Gatekeepers')
  })

  it('lists no connector page while the Context app is out of reach', () => {
    const sidebar = renderSidebar(otherApps)

    expect(connectorPageLinks(sidebar)).toEqual([])
    expect(sidebar.textContent).not.toContain('Context & Skills')
    expect(sidebar.querySelector('a[href="/gatekeepers"]')?.textContent).toBe('Gatekeepers')
  })
})
