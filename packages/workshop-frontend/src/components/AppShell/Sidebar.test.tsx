// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
vi.mock('../../useGatekeeperApps', () => ({
  useGatekeeperApps: () => [
    { id: 'brain', title: 'The Brain' },
    { id: 'salesforce', title: 'Salesforce' },
  ],
}))

import Sidebar from './Sidebar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Sidebar', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
  })

  it('lists no per-connector pages, only one labelled way to the Gatekeepers page', () => {
    container = document.createElement('div')
    root = createRoot(container)
    act(() => root!.render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />))

    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(hrefs.filter((href) => href?.startsWith('/gatekeepers/'))).toEqual([])
    expect(container.textContent).not.toContain('The Brain')
    expect(container.textContent).not.toContain('Salesforce')
    expect(container.querySelector('a[href="/gatekeepers"]')?.textContent).toBe('Gatekeepers')
  })
})
