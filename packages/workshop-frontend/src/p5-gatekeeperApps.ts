import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, GatekeeperAppInfo } from '@gadgets/workshop-shared/api'
import { p5AppsRequestByApi, p5RefreshListeners } from './useGatekeeperApps'

/**
 * Cloudflare's useGatekeeperApps() for a page that already holds the authenticated API, sharing its
 * request cache and refreshGatekeeperApps() signal, so the page and the nav make one call between them.
 * The request starts inside a promise callback: an API without listGatekeeperApps then leaves the list
 * empty instead of throwing from the effect and unmounting the page. It is never `Promise.resolve(api)`,
 * because a capnweb stub is thenable.
 */
export function useGatekeeperAppsOf(api: RpcStub<AuthenticatedApi> | undefined): GatekeeperAppInfo[] {
  const [apps, setApps] = useState<GatekeeperAppInfo[]>([])
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    const listener = () => setRefreshTick((t) => t + 1)
    p5RefreshListeners.add(listener)
    return () => { p5RefreshListeners.delete(listener) }
  }, [])

  useEffect(() => {
    if (!api) {
      setApps([])
      return
    }
    let request = p5AppsRequestByApi.get(api)
    if (!request) {
      request = Promise.resolve().then(() => api.listGatekeeperApps())
      p5AppsRequestByApi.set(api, request)
      request.catch(() => p5AppsRequestByApi.delete(api))
    }
    let cancelled = false
    request
      .then((list) => {
        if (!cancelled) setApps(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [api, refreshTick])

  return apps
}
