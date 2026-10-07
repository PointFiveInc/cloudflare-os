import { useEffect, useState } from 'react'
import { RpcTarget, type RpcStub } from 'capnweb'

/**
 * The bridge's frame half: a JS expression the frame prelude evaluates, with capnweb's `RpcTarget`
 * in scope, before the gadget's own code. It defines `globalThis.workshop` and yields the object the
 * frame exports on the gadget's MessagePort session, which the host calls to attach and to report
 * Back and Forward. The prelude and the gadget's code are one module, so it declares nothing at top
 * level and reads globals only through `globalThis`: a gadget that declares its own `workshop` (or
 * `CustomEvent`) still runs.
 */
export const WORKSHOP_FRAME = String.raw`((RpcTarget) => {
  const { CustomEvent, Object, Promise } = globalThis;
  let host = null;
  let state = { path: "/", appUrl: null };
  let markReady;
  const ready = new Promise(resolve => { markReady = resolve; });
  const connected = async () => { await ready; return host; };
  Object.defineProperty(globalThis, "workshop", {
    configurable: true,
    writable: true,
    value: Object.freeze({
      ready,
      location: Object.freeze({ get path() { return state.path; } }),
      get appUrl() { return state.appUrl; },
      async navigate(path, options) {
        state = await (await connected()).navigate(path, { replace: options?.replace === true });
      },
      async setTitle(text) {
        await (await connected()).setTitle(text);
      },
    }),
  });
  return new (class WorkshopFrame extends RpcTarget {
    attach(nextHost, nextState) {
      host = nextHost.dup();
      state = nextState;
      markReady();
    }
    moved(nextState) {
      state = nextState;
      globalThis.dispatchEvent(new CustomEvent("workshop:location", { detail: { path: state.path } }));
    }
  })();
})(RpcTarget)`

/** What a gadget reads as `workshop.location.path` and `workshop.appUrl`. */
type WorkshopState = { path: string; appUrl: string | null }

/** The object {@link WORKSHOP_FRAME} exports from the frame. */
type WorkshopFrame = {
  attach(host: WorkshopHost, state: WorkshopState): void
  moved(state: WorkshopState): void
}

/** The gadget's app page, which carries the inner path in the address bar. */
export type AppPageRoute = {
  /** The inner path the address bar holds now. */
  path: string
  /** The app page's address without an inner path; a gadget appends a path to link to a place. */
  appUrl: string
  /** Moves the address bar to `path`, adding a history entry unless `replace`. */
  onNavigate: (path: string, replace: boolean) => void
  /** Shows the gadget's text in the tab title, ahead of the gadget's own title. */
  onSetTitle: (text: string) => void
}

const MAX_PATH_LENGTH = 1024
const MAX_TITLE_LENGTH = 120
// At most this many history entries in any window of this length; past it a navigation replaces the
// current entry instead, so a gadget cannot bury the page it was opened from under Back presses.
const MAX_PUSHES = 10
const PUSH_WINDOW_MS = 10_000

const pathRefused = (why: string) => new TypeError(`workshop.navigate(): ${why}`)

/**
 * Returns `path` if the address bar may carry it after the app page's own prefix, and throws
 * otherwise. The route only ever places it in its splat, so it cannot leave the app page; these
 * checks also keep it out of the query and the hash (where a share key is read on every load) and
 * refuse anything a browser or the router would rewrite on the way back: control characters,
 * backslashes (read as slashes), empty segments and dot segments.
 */
export const checkAppPath = (path: unknown): string => {
  if (typeof path !== 'string') throw pathRefused('the path must be a string.')
  if (!path.startsWith('/')) throw pathRefused('the path must start with "/".')
  if (path.length > MAX_PATH_LENGTH) {
    throw pathRefused(`the path may hold at most ${MAX_PATH_LENGTH} characters.`)
  }
  if (/\p{Cc}/u.test(path)) throw pathRefused('the path may not hold control characters.')
  if (/[?#]/.test(path)) throw pathRefused('the path may not hold "?" or "#".')
  if (path.includes('\\')) throw pathRefused('the path may not hold "\\".')
  if (path === '/') return path
  const segments = path.slice(1).split('/')
  if (segments.includes('')) throw pathRefused('the path may not hold an empty segment or end in "/".')
  if (segments.some(segment => segment === '.' || segment === '..')) {
    throw pathRefused('the path may not hold a "." or ".." segment.')
  }
  return path
}

// Bidirectional controls could reorder the gadget's own title, which follows the text, so they go.
const titleText = (text: unknown): string => {
  if (typeof text !== 'string') throw new TypeError('workshop.setTitle(): the title must be a string.')
  const plain = text.replace(/[‎‏‪-‮⁦-⁩]/g, '')
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim()
  return Array.from(plain).slice(0, MAX_TITLE_LENGTH).join('')
}

/**
 * The host object a gadget's frame holds, shaped like the host gatekeeper app frames get: the frame
 * is untrusted, so each call is checked here, and these two methods are all it can reach.
 */
export class WorkshopHost extends RpcTarget {
  readonly #bridge: WorkshopBridge

  constructor(bridge: WorkshopBridge) {
    super()
    this.#bridge = bridge
  }

  navigate(path: unknown, options?: unknown): WorkshopState {
    const replace = typeof options === 'object' && options !== null &&
      (options as { replace?: unknown }).replace === true
    return this.#bridge.navigate(checkAppPath(path), replace)
  }

  setTitle(text: unknown): void {
    this.#bridge.setTitle(titleText(text))
  }
}

/**
 * One gadget frame's bridge. On the gadget's app page it moves the address bar and tells the frame
 * about Back and Forward; anywhere else it keeps the inner path itself and never touches the
 * address bar.
 */
export class WorkshopBridge {
  readonly #host = new WorkshopHost(this)
  #app: AppPageRoute | undefined
  #path: string
  #routePath: string | undefined
  #frame: RpcStub<WorkshopFrame> | null = null
  // Paths handed to the route that it has not reported back yet, oldest first.
  #pending: string[] = []
  #pushedAt: number[] = []

  constructor(app: AppPageRoute | undefined) {
    this.#app = app
    this.#path = app?.path ?? '/'
    this.#routePath = app?.path
  }

  /** Hands the bridge to a frame that has just connected. */
  attach(frame: RpcStub<WorkshopFrame>) {
    this.#frame = frame
    frame.attach(this.#host, this.#state()).catch(() => {})
  }

  /** Takes the route's latest state. A path change the gadget did not ask for is Back or Forward. */
  follow(app: AppPageRoute | undefined) {
    this.#app = app
    if (!app || app.path === this.#routePath) return
    this.#routePath = app.path
    const requested = this.#pending.indexOf(app.path)
    if (requested >= 0) {
      this.#pending.splice(0, requested + 1)
      return
    }
    this.#pending = []
    if (app.path === this.#path) return
    this.#path = app.path
    this.#frame?.moved(this.#state()).catch(() => {})
  }

  navigate(path: string, replace: boolean): WorkshopState {
    if (this.#app && path !== this.#path) {
      this.#pending.push(path)
      this.#app.onNavigate(path, replace || !this.#takePush())
    }
    this.#path = path
    return this.#state()
  }

  setTitle(text: string) {
    this.#app?.onSetTitle(text)
  }

  #takePush(): boolean {
    const now = Date.now()
    this.#pushedAt = this.#pushedAt.filter(at => now - at < PUSH_WINDOW_MS)
    if (this.#pushedAt.length >= MAX_PUSHES) return false
    this.#pushedAt.push(now)
    return true
  }

  #state(): WorkshopState {
    return { path: this.#path, appUrl: this.#app?.appUrl ?? null }
  }
}

/** The bridge for one gadget frame: kept for the frame host's lifetime, fed the route on each render. */
export const useWorkshopBridge = (app: AppPageRoute | undefined): WorkshopBridge => {
  const [bridge] = useState(() => new WorkshopBridge(app))
  useEffect(() => bridge.follow(app), [bridge, app])
  return bridge
}
