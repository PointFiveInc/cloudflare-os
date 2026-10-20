// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, ConnectedAccountsSubscriber, Overseer } from '@gadgets/workshop-shared/api'
import type { AccountDescription, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

const toasts = vi.hoisted(() => ({ add: vi.fn<(options: unknown) => void>() }))

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  return { ...actual, useKumoToastManager: () => toasts }
})
const auth = vi.hoisted(() => ({ authenticatedApi: {} as Record<string, unknown> }))
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => auth }))

import { act } from 'react'
import { entry, makeTestRoot } from './action-test-harness'
import { useResolveAction } from './useResolveAction'

const view = makeTestRoot()

afterEach(() => {
  view.cleanup()
  vi.restoreAllMocks()
  toasts.add.mockClear()
})

const reason = 'Salesforce refused the change: FIELD_CUSTOM_VALIDATION_EXCEPTION: '
  + 'Close Date is required to move past Discovery'

async function renderFailingWith(error: unknown) {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const overseer = {
    approveAction: () => Promise.reject(error),
    rejectAction: () => Promise.reject(error),
    getGatekeeperById: async () => ({
      getCreationSpec: async () =>
        ({ type: 'gatekeeper', vendorId: 'test', typeUrlPattern: 'https://test.example/*' }),
      [Symbol.dispose]: () => {},
    }),
  } as unknown as RpcStub<Overseer>
  let hook!: ReturnType<typeof useResolveAction>
  function Probe() {
    hook = useResolveAction(overseer, () => {})
    return hook.creationAccountModal
  }
  await view.render(<Probe />)
  return (action: ActionLogEntry, decision: 'approve' | 'deny') =>
    act(() => hook.resolveAction(action, decision))
}

function onlyToast() {
  expect(toasts.add).toHaveBeenCalledTimes(1)
  return toasts.add.mock.calls[0][0] as { title: string, description?: string, variant: string }
}

async function approveFailingWith(error: unknown) {
  const resolveAction = await renderFailingWith(error)
  await resolveAction({ id: 7, type: 'action' } as ActionLogEntry, 'approve')
  return onlyToast()
}

describe('useResolveAction', () => {
  it("shows the gatekeeper's reason when approving fails", async () => {
    const toast = await approveFailingWith(new Error(reason))
    expect(toast).toEqual({ title: 'Failed to approve action', description: reason, variant: 'error' })
  })

  it("shows the gatekeeper's reason when denying fails", async () => {
    const resolveAction = await renderFailingWith(new Error(reason))
    await resolveAction({ id: 7, type: 'action' } as ActionLogEntry, 'deny')
    expect(onlyToast()).toEqual({ title: 'Failed to deny action', description: reason, variant: 'error' })
  })

  it("shows the gatekeeper's reason when approving a creation in the chosen account fails", async () => {
    auth.authenticatedApi = {
      listGatekeeperVendors: async () =>
        [{ id: 'test', description: { displayName: 'Test' }, supportedResources: [] }],
      subscribeConnectedAccounts: (subscriber: ConnectedAccountsSubscriber) => {
        subscriber.add(1, { uniqueName: 'work' } as AccountDescription, {} as VendorDescription, [], true,
            'test')
        subscriber.ready()
        return Object.assign(Promise.resolve({}), { [Symbol.dispose]: () => {} })
      },
    }
    const resolveAction = await renderFailingWith(new Error(reason))
    await resolveAction(entry(1, { gatekeeperId: 7, creation: true }), 'approve')
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('work')
    await act(async () =>
      [...dialog.querySelectorAll('button')].find(b => b.textContent === 'Approve')!.click())
    expect(onlyToast()).toEqual({ title: 'Failed to approve action', description: reason, variant: 'error' })
  })

  it('shortens a long reason', async () => {
    const toast = await approveFailingWith(new Error(`Salesforce refused the change: ${'x'.repeat(900)}`))
    expect(toast.description).toHaveLength(300)
    expect(toast.description?.startsWith('Salesforce refused the change: xxx')).toBe(true)
    expect(toast.description?.endsWith('…')).toBe(true)
  })

  it('keeps transport failures to the title', async () => {
    const toast = await approveFailingWith(new Error('Peer closed WebSocket: 1006 '))
    expect(toast.title).toBe('Failed to approve action')
    expect(toast.description).toBeUndefined()
  })
})
