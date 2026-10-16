// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'

const toasts = vi.hoisted(() => ({ add: vi.fn<(options: unknown) => void>() }))

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  return { ...actual, useKumoToastManager: () => toasts }
})

import { act } from 'react'
import { makeTestRoot } from './action-test-harness'
import { useResolveAction } from './useResolveAction'

const view = makeTestRoot()

afterEach(() => {
  view.cleanup()
  vi.restoreAllMocks()
  toasts.add.mockClear()
})

async function approveFailingWith(error: unknown) {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const overseer = {
    approveAction: () => Promise.reject(error),
  } as unknown as RpcStub<Overseer>
  let resolve!: ReturnType<typeof useResolveAction>
  function Probe() {
    resolve = useResolveAction(overseer, () => {})
    return null
  }
  await view.render(<Probe />)
  await act(() => resolve(7, 'approve'))
  expect(toasts.add).toHaveBeenCalledTimes(1)
  return toasts.add.mock.calls[0][0] as { title: string, description?: string, variant: string }
}

describe('useResolveAction', () => {
  it("shows the gatekeeper's reason when approving fails", async () => {
    const reason = 'Salesforce refused the change: FIELD_CUSTOM_VALIDATION_EXCEPTION: '
      + 'Close Date is required to move past Discovery'
    const toast = await approveFailingWith(new Error(reason))
    expect(toast).toEqual({ title: 'Failed to approve action', description: reason, variant: 'error' })
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
