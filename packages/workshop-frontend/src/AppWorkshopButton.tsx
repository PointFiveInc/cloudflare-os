import { DropdownMenu } from '@cloudflare/kumo'
import { CaretDown, Hexagon } from '@phosphor-icons/react'
import SiteLogo from './components/SiteLogo'
import { MENU_CONTENT, MENU_ITEM, MENU_POSITIONER_STYLE } from './components/menuStyles'

type Props = {
  gadgetTitle: string
  /** Null when the viewer owns the gadget. */
  ownerName: string | null
  onBackToWorkshop: () => void
  /** Only for people who may edit the gadget: its owner and build collaborators. */
  onOpenEditor?: () => void
}

/**
 * The app page's one Workshop control. It is drawn by the Workshop outside the gadget's frame, so
 * whatever the gadget shows, the page still says which gadget it is, whose it is, and that it runs
 * inside the Workshop; a gadget cannot pass itself off as a sign-in page.
 */
const AppWorkshopButton = ({ gadgetTitle, ownerName, onBackToWorkshop, onOpenEditor }: Props) => {
  const owner = `by ${ownerName ?? 'you'}`
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={(
          <button
            type="button"
            aria-label={`Workshop: ${gadgetTitle} ${owner}`}
            className="flex h-9 max-w-[18rem] min-w-0 cursor-pointer items-center gap-1.5 rounded-lg border border-kumo-line bg-kumo-base px-2.5 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-default transition-colors hover:bg-kumo-elevated"
          >
            <SiteLogo size={16} className="shrink-0">
              <Hexagon size={16} weight="bold" className="shrink-0 text-kumo-brand" />
            </SiteLogo>
            <span className="min-w-0 truncate font-medium">{gadgetTitle}</span>
            <span className="min-w-0 shrink-[2] truncate text-kumo-subtle">{owner}</span>
            <CaretDown size={12} className="shrink-0 text-kumo-subtle" />
          </button>
        )}
      />
      <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE}>
        <DropdownMenu.Item onClick={onBackToWorkshop} className={MENU_ITEM}>
          Back to Workshop
        </DropdownMenu.Item>
        {onOpenEditor && (
          <DropdownMenu.Item onClick={onOpenEditor} className={MENU_ITEM}>
            Open in editor
          </DropdownMenu.Item>
        )}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

export default AppWorkshopButton
