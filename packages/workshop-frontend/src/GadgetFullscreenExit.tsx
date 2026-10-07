import { useSyncExternalStore } from 'react'
import { X } from '@phosphor-icons/react'

const coarsePointerQuery = () => window.matchMedia?.('(pointer: coarse)')

function subscribeToPointer(onChange: () => void) {
  const query = coarsePointerQuery()
  query?.addEventListener?.('change', onChange)
  return () => query?.removeEventListener?.('change', onChange)
}

/** Whether the primary pointer is a finger, as on a phone or tablet, where there is no Esc key. */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribeToPointer, () => coarsePointerQuery()?.matches ?? false)
}

/** The on-screen way out of the editor's gadget full screen, for a touch screen. */
export function GadgetFullscreenExitButton({ onExit }: { onExit: () => void }) {
  return (
    <button
      type="button"
      aria-label="Exit full screen"
      title="Exit full screen"
      onClick={onExit}
      className="absolute right-3 top-3 z-10 flex h-11 w-11 items-center justify-center rounded-full border border-kumo-line bg-kumo-base/90 text-kumo-default shadow-md backdrop-blur-sm"
    >
      <X size={20} />
    </button>
  )
}
