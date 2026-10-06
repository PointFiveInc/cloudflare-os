import { createFileRoute, useNavigate } from '@tanstack/react-router'
import GadgetAppView from '../GadgetAppView'
import { parseAppLocation } from '../appLocation'

const AppPage = () => {
  const params = Route.useParams()
  const location = parseAppLocation(params)
  const navigate = useNavigate()
  return (
    <GadgetAppView
      key={`${location.workspaceId}/${location.gadgetId}`}
      location={location}
      // The share key is a bearer capability, so it leaves the address bar once redeemed; the
      // place inside the gadget that the link points to stays.
      onShareKeyConsumed={() => {
        void navigate({ to: Route.fullPath, params, search: true, replace: true })
      }}
    />
  )
}

/** `/apps/<workspace>/<gadget>/<inner path>`: one gadget, full screen, at a place inside it. */
export const Route = createFileRoute('/apps/$workspaceId/$gadgetId/$')({
  component: AppPage,
})
