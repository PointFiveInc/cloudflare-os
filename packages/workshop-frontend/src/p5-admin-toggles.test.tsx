// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminSettingsView, ServerConfig } from '@gadgets/workshop-shared/api'
import type { P5ToggleChange, P5Toggles } from '@gadgets/workshop-shared/p5-admin-toggles'

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})

const mocks = vi.hoisted(() => ({
  addToast: vi.fn<(toast: { title: string; variant: string }) => void>(),
  admin: null as unknown,
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: mocks.addToast }),
}))

vi.mock('./AuthContext', () => {
  const context = { authenticatedApi: { getAdminApi: async () => mocks.admin }, isAdmin: true }
  return { useAuthenticatedApi: () => context }
})

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => () => {},
  useSearch: () => ({ tab: 'access' }),
}))

vi.mock('./features/deployment-updates/probeRouterTag', () => ({ probeRouterTag: async () => {} }))

import { makeTestRoot } from './action-test-harness'
import AdminPage from './AdminPage'
import { ServerConfigContext } from './ServerConfigContext'
import { P5_TOGGLE_WORDS, useP5Toggles } from './p5-admin-toggles'

const view = makeTestRoot()

const SETTINGS: AdminSettingsView = {
  signupsEnabled: false,
  userSearchEnabled: true,
  siteName: '',
  instanceInstructions: '',
  announcement: '',
  banner: { text: '', color: 'neutral' },
  accentColor: '',
  resourceVendors: [],
  formats: [],
}

/**
 * The admin capability as the server answers it, holding both switches. `refuse` makes the next
 * change fail with that sentence. `read` gates the first read, to see the switches before it lands.
 */
function adminApi(initial: P5Toggles, read: Promise<void> = Promise.resolve()) {
  const server = { toggles: { ...initial }, refuse: null as string | null }
  const changes: P5ToggleChange[] = []
  const p5Toggles = vi.fn<(change?: P5ToggleChange) => Promise<P5Toggles>>(async (change) => {
    if (change === undefined) {
      await read
      return { ...server.toggles }
    }
    changes.push(change)
    if (server.refuse) throw new Error(server.refuse)
    server.toggles[change.toggle] = change.on
    return { ...server.toggles }
  })
  mocks.admin = {
    getSettings: async () => SETTINGS,
    getUpdateStatus: async () => null,
    p5Toggles,
    [Symbol.dispose]: () => {},
  }
  return { server, changes }
}

const headings = () => Array.from(document.body.querySelectorAll('h2')).map(h => h.textContent)

const card = (label: string) => {
  const heading = Array.from(document.body.querySelectorAll('h2')).find(h => h.textContent === label)
  if (!heading) throw new Error(`No card ${label}`)
  return heading.closest('.rounded-xl')!
}

const toggleSwitch = (label: string) => {
  const element = document.body.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`)
  if (!element) throw new Error(`No switch ${label}`)
  return element
}

const checked = (label: string) => toggleSwitch(label).getAttribute('aria-checked')

// jsdom has no PointerEvent, which the switch forwards its clicks with, so click its checkbox.
const flip = async (label: string) => {
  const input = toggleSwitch(label).nextElementSibling
  if (!(input instanceof HTMLInputElement)) throw new Error('No checkbox behind the switch')
  await act(async () => { input.click() })
}

const TURN_END = P5_TOGGLE_WORDS.turnEndAccept.label
const SIMPLE = P5_TOGGLE_WORDS.simpleLook.label

beforeEach(() => {
  mocks.addToast.mockClear()
})

afterEach(() => {
  view.cleanup()
  vi.restoreAllMocks()
})

describe('the Access tab', () => {
  it('shows both switches right after "Allow user search", with their words and stored state', async () => {
    adminApi({ turnEndAccept: true, simpleLook: false })
    await view.render(<AdminPage />)

    expect(headings()).toEqual(['Allow new sign-ups', 'Allow user search', 'Turn-end accept', 'Simple look'])
    expect(card(TURN_END).querySelector('p')!.textContent).toBe(
      'When the agent finishes, its changes go live at once, with no Accept click. Press Stop to keep a change waiting under Pending changes; an error or a clash also leaves it waiting.')
    expect(card(SIMPLE).querySelector('p')!.textContent).toBe(
      'Hide each gadget’s Code tab and the button that sends captured errors to chat, for everyone, admins included. Scratch space stays. Turn it off to debug. Applies on each user’s next connection.')
    expect(checked(TURN_END)).toBe('true')
    expect(checked(SIMPLE)).toBe('false')
    expect(checked('Allow user search')).toBe('true')
  })

  it('shows the other stored state', async () => {
    adminApi({ turnEndAccept: false, simpleLook: true })
    await view.render(<AdminPage />)

    expect(checked(TURN_END)).toBe('false')
    expect(checked(SIMPLE)).toBe('true')
  })

  it('keeps both switches off and still until their state is read', async () => {
    let land!: () => void
    adminApi({ turnEndAccept: true, simpleLook: true }, new Promise<void>(resolve => { land = resolve }))
    await view.render(<AdminPage />)

    expect(checked(TURN_END)).toBe('false')
    expect(checked(SIMPLE)).toBe('false')
    expect(toggleSwitch(TURN_END).hasAttribute('data-disabled')).toBe(true)
    expect(toggleSwitch(SIMPLE).hasAttribute('data-disabled')).toBe(true)

    await act(async () => { land() })
    expect(checked(TURN_END)).toBe('true')
    expect(checked(SIMPLE)).toBe('true')
    expect(toggleSwitch(TURN_END).hasAttribute('data-disabled')).toBe(false)
  })

  it('turns only the switch clicked', async () => {
    const { server, changes } = adminApi({ turnEndAccept: false, simpleLook: false })
    await view.render(<AdminPage />)

    await flip(SIMPLE)
    expect(changes).toEqual([{ toggle: 'simpleLook', on: true }])
    expect(server.toggles).toEqual({ turnEndAccept: false, simpleLook: true })
    expect(checked(SIMPLE)).toBe('true')
    expect(checked(TURN_END)).toBe('false')

    await flip(TURN_END)
    expect(changes).toEqual([{ toggle: 'simpleLook', on: true }, { toggle: 'turnEndAccept', on: true }])
    expect(checked(TURN_END)).toBe('true')

    await flip(SIMPLE)
    expect(changes.at(-1)).toEqual({ toggle: 'simpleLook', on: false })
    expect(server.toggles).toEqual({ turnEndAccept: true, simpleLook: false })
    expect(checked(SIMPLE)).toBe('false')
    expect(checked(TURN_END)).toBe('true')
    expect(checked('Allow user search')).toBe('true')
  })

  it('turns a refused switch back and says why', async () => {
    const { server } = adminApi({ turnEndAccept: false, simpleLook: true })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await view.render(<AdminPage />)

    server.refuse = 'KV unavailable'
    await flip(TURN_END)
    expect(checked(TURN_END)).toBe('false')
    expect(checked(SIMPLE)).toBe('true')
    expect(mocks.addToast).toHaveBeenCalledWith({ title: 'KV unavailable', variant: 'error' })
  })
})

const Probe = () => <output>{JSON.stringify(useP5Toggles())}</output>

/** Both switches as a page reads them from `config`, its server config. */
const readToggles = async (config: object | null) => {
  await view.render(
    <ServerConfigContext.Provider value={config as ServerConfig | null}><Probe /></ServerConfigContext.Provider>)
  return JSON.parse(document.body.querySelector('output')!.textContent!) as P5Toggles
}

describe('useP5Toggles', () => {
  const BASE = { authVendors: [], siteName: '', userSearchEnabled: true }

  it('reads both off while the server config loads, and when it carries neither', async () => {
    expect(await readToggles(null)).toEqual({ turnEndAccept: false, simpleLook: false })
    expect(await readToggles(BASE)).toEqual({ turnEndAccept: false, simpleLook: false })
  })

  it('reads each switch alone', async () => {
    expect(await readToggles({ ...BASE, p5TurnEndAccept: true, p5SimpleLook: false }))
      .toEqual({ turnEndAccept: true, simpleLook: false })
    expect(await readToggles({ ...BASE, p5TurnEndAccept: false, p5SimpleLook: true }))
      .toEqual({ turnEndAccept: false, simpleLook: true })
  })

  it('reads a switch off when it is not a boolean', async () => {
    expect(await readToggles({ ...BASE, p5TurnEndAccept: 'true', p5SimpleLook: 1 }))
      .toEqual({ turnEndAccept: false, simpleLook: false })
  })
})
