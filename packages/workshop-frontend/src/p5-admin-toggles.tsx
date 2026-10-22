import { use, useEffect, useState, type ReactNode } from 'react'
import type { RpcStub } from 'capnweb'
import { Switch, useKumoToastManager } from '@cloudflare/kumo'
import { CheckCircle, EyeSlash } from '@phosphor-icons/react'
import type { AdminApi } from '@gadgets/workshop-shared/api'
import {
  p5TogglesOf,
  type P5AdminTogglesApi,
  type P5Toggle,
  type P5Toggles,
} from '@gadgets/workshop-shared/p5-admin-toggles'
import { ServerConfigContext } from './ServerConfigContext'

/** Each switch's heading and the line under it on `/admin` → Access. */
export const P5_TOGGLE_WORDS: Record<P5Toggle, { label: string; description: string }> = {
  turnEndAccept: {
    label: 'Turn-end accept',
    description:
      'When the agent finishes, its changes go live at once, with no Accept click. Press Stop to keep a change waiting under Pending changes; an error or a clash also leaves it waiting.',
  },
  simpleLook: {
    label: 'Simple look',
    description:
      'Hide each gadget’s Code tab and the button that sends captured errors to chat, for everyone, admins included. Scratch space stays. Turn it off to debug. Applies on each user’s next connection.',
  },
}

const TOGGLE_ICONS: Record<P5Toggle, ReactNode> = {
  turnEndAccept: <CheckCircle size={18} className="text-kumo-subtle" />,
  simpleLook: <EyeSlash size={18} className="text-kumo-subtle" />,
}

const TOGGLES: P5Toggle[] = ['turnEndAccept', 'simpleLook']

/**
 * Both switches as of this page's last (re)connect: off while the server config loads. It reads
 * the config with React's `use`, so it may also be called after an early return or in a condition.
 */
export const useP5Toggles = (): P5Toggles => p5TogglesOf(use(ServerConfigContext))

/**
 * The two switches' cards on `/admin` → Access, after "Allow user search" and laid out like it. The
 * state is read from the admin capability, not the server config, which is only as fresh as this
 * page's connection.
 */
export const P5AdminToggles = ({ admin }: { admin: RpcStub<AdminApi> }) => {
  const api = admin as RpcStub<AdminApi & P5AdminTogglesApi>
  const toasts = useKumoToastManager()
  const [toggles, setToggles] = useState<P5Toggles | null>(null)
  const [saving, setSaving] = useState<ReadonlySet<P5Toggle>>(new Set())

  useEffect(() => {
    let cancelled = false
    api.p5Toggles().then(
      (read) => { if (!cancelled) setToggles(read) },
      (err) => { console.error('Failed to load the admin switches:', err) },
    )
    return () => { cancelled = true }
  }, [api])

  const handleToggle = async (toggle: P5Toggle, on: boolean) => {
    setSaving((prev) => new Set(prev).add(toggle))
    setToggles((prev) => prev && { ...prev, [toggle]: on })
    try {
      await api.p5Toggles({ toggle, on })
    } catch (err) {
      setToggles((prev) => prev && { ...prev, [toggle]: !on })
      const message = err instanceof Error ? err.message : 'Update failed'
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSaving((prev) => {
        const next = new Set(prev)
        next.delete(toggle)
        return next
      })
    }
  }

  return (
    <>
      {TOGGLES.map((toggle) => (
        <div key={toggle} className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <div className="flex items-center gap-4">
            <div className="w-9 h-9 rounded-lg flex-shrink-0 flex items-center justify-center bg-kumo-tint">
              {TOGGLE_ICONS[toggle]}
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-semibold text-kumo-strong">{P5_TOGGLE_WORDS[toggle].label}</h2>
              <p className="text-sm text-kumo-subtle mt-0.5">{P5_TOGGLE_WORDS[toggle].description}</p>
            </div>
            <Switch
              aria-label={P5_TOGGLE_WORDS[toggle].label}
              checked={toggles?.[toggle] ?? false}
              disabled={toggles === null || saving.has(toggle)}
              onCheckedChange={(on) => { void handleToggle(toggle, on) }}
            />
          </div>
        </div>
      ))}
    </>
  )
}
