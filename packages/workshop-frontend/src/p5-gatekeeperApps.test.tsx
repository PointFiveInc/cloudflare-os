// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, GatekeeperAppInfo } from '@gadgets/workshop-shared/api'
import { AuthProvider, useAuthenticatedApi } from './AuthContext'
import { refreshGatekeeperApps, useGatekeeperApps } from './useGatekeeperApps'
import { useGatekeeperAppsOf } from './p5-gatekeeperApps'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const skills: GatekeeperAppInfo = { id: 'context', title: 'Skills' }
const brain: GatekeeperAppInfo = { id: 'brain', title: 'The Brain' }

const ids = (apps: GatekeeperAppInfo[]) => apps.map((app) => app.id).join(',')

function Cloudflare() {
  return <p data-hook="cloudflare">{ids(useGatekeeperApps())}</p>
}

function Ours() {
  return <p data-hook="ours">{ids(useGatekeeperAppsOf(useAuthenticatedApi().authenticatedApi))}</p>
}

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = undefined
})

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

const shown = () => ({
  cloudflare: container?.querySelector('[data-hook="cloudflare"]')?.textContent,
  ours: container?.querySelector('[data-hook="ours"]')?.textContent,
})

function fakeApi(methods: object) {
  return {
    ...methods,
    whoami: async () => ({ type: 'user', id: 'alice', name: 'Alice' }),
    amIAdmin: async () => false,
  } as unknown as RpcStub<AuthenticatedApi>
}

async function render(api: RpcStub<AuthenticatedApi>, hooks: ReactNode) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(<AuthProvider authenticatedApi={api} onLogout={() => {}}>{hooks}</AuthProvider>))
  await settle()
}

describe('useGatekeeperAppsOf beside Cloudflare\'s useGatekeeperApps', () => {
  it.each([
    ['Cloudflare\'s hook mounts first', <><Cloudflare /><Ours /></>],
    ['ours mounts first', <><Ours /><Cloudflare /></>],
  ])('shares one request and hears refreshGatekeeperApps (%s)', async (_, hooks) => {
    const listGatekeeperApps = vi.fn<() => Promise<GatekeeperAppInfo[]>>(async () => [skills])
    const api = fakeApi({ listGatekeeperApps })
    await render(api, hooks)
    expect(listGatekeeperApps).toHaveBeenCalledTimes(1)
    expect(shown()).toEqual({ cloudflare: 'context', ours: 'context' })

    listGatekeeperApps.mockResolvedValueOnce([skills, brain])
    await act(async () => refreshGatekeeperApps(api))
    await settle()
    expect(listGatekeeperApps).toHaveBeenCalledTimes(2)
    expect(shown()).toEqual({ cloudflare: 'context,brain', ours: 'context,brain' })
  })

  it('leaves the list empty when the API has no listGatekeeperApps', async () => {
    await render(fakeApi({}), <Ours />)
    expect(shown().ours).toBe('')
  })

  it('drops a failed request from the shared cache, so the next hook asks again', async () => {
    const listGatekeeperApps = vi.fn<() => Promise<GatekeeperAppInfo[]>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([skills])
    const api = fakeApi({ listGatekeeperApps })
    await render(api, <Ours />)
    expect(shown().ours).toBe('')

    act(() => root?.unmount())
    container?.remove()
    await render(api, <Cloudflare />)
    expect(listGatekeeperApps).toHaveBeenCalledTimes(2)
    expect(shown().cloudflare).toBe('context')
  })
})
