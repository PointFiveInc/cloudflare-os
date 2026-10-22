// @vitest-environment jsdom
// @ts-expect-error node builtin without @types/node
import { createHash } from 'node:crypto'
// @ts-expect-error node builtin without @types/node
import { readFileSync } from 'node:fs'
// @ts-expect-error node builtin without @types/node
import { createRequire } from 'node:module'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Toasty } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import ConnectHandoffPage from './ConnectHandoffPage'
import { HANDOFF_PATH } from './connectHandoff'
import { DeviceSessionHandoff } from './features/native-app/DeviceSessionHandoff'
import { NATIVE_AUTH_KEY } from './features/native-app/authPopup'
import { POINTFIVE_MARK } from './p5-brand'
import { Route } from './routes/gatekeepers'

const auth = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('./AuthContext', async importOriginal => ({
  ...await importOriginal<typeof import('./AuthContext')>(),
  useAuthenticatedApi: () => ({ authenticatedApi: auth.api }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NAME = 'PointFive OS'
const CLOUDFLARE_OS = /cloudflare(?:\s|&nbsp;)*os/i
const POINTFIVE_ICONS: Readonly<Record<string, string>> = {
  '/favicon.svg': '233cce86cc65bfc7ccb5daedb79baeef17cd75afc1d249ade8349889dc5dae0b',
  '/icons/app-192.png': '299cd8430c30be70129b752c1adcee9d1e9b84dc1d2c4039c293b6bc6c24f1a3',
  '/icons/app-512.png': '719c7eac6d7c3e9a946887ad3e0b1ea7a61735ae27b178706af38e397214a29e',
  '/icons/app-maskable-512.png': '009fc83bee7f365a4b1bfae17ee4abf8e38acf542e6636700a6437b11f55ecaa',
  '/icons/apple-touch-icon.png': '00bd2ab085b38c75aab216b2714fec6ba00cbf67c642620ccc8517b2eea78f4e',
}

const packageFile = (path: string) => readFileSync(createRequire(import.meta.url).resolve(`../${path}`))
const text = (path: string): string => packageFile(path).toString('utf8')
const servedSha256 = (href: string): string =>
  createHash('sha256').update(packageFile(`public${href}`)).digest('hex')

const indexHtml = text('index.html')
const manifest = JSON.parse(text('public/manifest.webmanifest')) as {
  name: string
  short_name: string
  icons: { src: string }[]
}

let root: Root | undefined
let container: HTMLDivElement | undefined

async function render(element: ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(element))
  await act(async () => { await Promise.resolve() })
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  vi.unstubAllGlobals()
  sessionStorage.clear()
  window.history.replaceState(null, '', '/')
})

describe('PointFive branding', () => {
  it('names PointFive OS in the first tab title, the install offer and the favicon label', () => {
    expect(indexHtml).toContain(`<title>${NAME}</title>`)
    expect({ name: manifest.name, short_name: manifest.short_name }).toEqual({ name: NAME, short_name: NAME })
    expect(text('public/favicon.svg')).toContain(`aria-label="${NAME}"`)
    const shipped = ['index.html', 'public/manifest.webmanifest', 'public/favicon.svg']
    expect(shipped.filter(path => CLOUDFLARE_OS.test(text(path)))).toEqual([])
  })

  it("shows PointFive's mark, byte for byte, in every icon the page, the manifest and the Connectors diagram use", () => {
    expect(POINTFIVE_MARK).toBe('/icons/app-192.png')
    const pageIcons = [...indexHtml.matchAll(/<link\b[^>]*>/g)]
      .filter(([tag]) => /\brel="[^"]*icon[^"]*"/.test(tag))
      .map(([tag]) => /\bhref="([^"]+)"/.exec(tag)?.[1] ?? tag)
    const used = new Set([...pageIcons, ...manifest.icons.map(({ src }) => src), POINTFIVE_MARK])
    expect(used).toEqual(new Set(Object.keys(POINTFIVE_ICONS)))
    expect(Object.fromEntries([...used].map(href => [href, servedSha256(href)]))).toEqual(POINTFIVE_ICONS)
  })

  it("says \"the app\" on the native app's sign-in, which names Cloudflare's own app", async () => {
    window.history.replaceState(null, '', `/?cfos_native_state=${'ABCDEFab-0000-0000-0000-000000000001'}&cfos_native_key=${'A'.repeat(87)}`)
    const user: AiChatAuthorInfo = { type: 'user', id: 'alice@example.com', name: 'Alice' }
    const authenticatedApi = { whoami: async () => user } as unknown as RpcStub<AuthenticatedApi>
    const page = await render(createElement(DeviceSessionHandoff, { authenticatedApi }))
    expect(page.querySelector('h1')?.textContent).toBe('Continue in the app?')
    expect(page.textContent).toContain('Continue only if you started this sign-in from the app.')
    expect(page.querySelector('button')?.textContent).toBe('Continue in the app')
    expect(page.textContent).not.toMatch(CLOUDFLARE_OS)
  })

  it("says \"the app\" while the connect relay returns to the native app", async () => {
    sessionStorage.setItem(NATIVE_AUTH_KEY, JSON.stringify({ id: 'c'.repeat(64), expiresAt: Date.now() + 60_000 }))
    vi.stubGlobal('location', { hash: `#${'a'.repeat(64)}`, pathname: HANDOFF_PATH, replace: vi.fn<(url: string) => void>() })
    const page = await render(createElement(ConnectHandoffPage))
    expect(page.textContent).toBe('Returning to the app…')
  })

  it("shows PointFive's mark beside the site name in the Connectors diagram", async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    auth.api = {
      listAddableGatekeepers: async () => [],
      listGatekeeperVendors: async () => [],
      subscribeConnectedAccounts: (subscriber: { ready(): void }) => {
        subscriber.ready()
        return Object.assign(Promise.resolve(), { [Symbol.dispose]() {} })
      },
      onRpcBroken: () => {},
    }
    const ConnectorsPage = Route.options.component!
    await ConnectorsPage.preload?.()
    const page = await render(createElement(Toasty, null, createElement(ConnectorsPage)))
    const marks = [...page.querySelectorAll('img')].filter(img => img.getAttribute('src') === POINTFIVE_MARK)
    expect(marks).toHaveLength(1)
    expect(marks[0].parentElement?.parentElement?.textContent).toBe(NAME)
  })
})
