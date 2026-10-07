// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { RpcStub } from 'capnweb'
import { expect, it, vi } from 'vitest'
import type { GadgetClient } from '@gadgets/workshop-shared/api'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
testGlobal.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', () => ({
  Banner: () => null,
  Loader: () => null,
  Text: ({ children }: { children: ReactNode }) => children,
}))

import GadgetUI from './GadgetUI'

it('lets the gadget UI write to the clipboard, and never read it', async () => {
  const gadget = { getUiBundle: async () => ({ jsCode: '' }) } as unknown as RpcStub<GadgetClient>
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)

  await act(async () => root.render(<GadgetUI gadget={gadget} height="100px" />))
  await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())

  const features = (container.querySelector('iframe')!.getAttribute('allow') ?? '')
    .split(';')
    .map(directive => directive.trim().split(/\s+/)[0])
  expect(features).toContain('clipboard-write')
  expect(features).not.toContain('clipboard-read')

  await act(async () => root.unmount())
  container.remove()
})
