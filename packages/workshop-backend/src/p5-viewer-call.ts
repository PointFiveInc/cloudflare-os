/**
 * Opens a viewer's session with a gadget as `connect` does, but asks only a gadget that can answer: one whose code
 * names `connectViewer` in any file of the version it runs, not only `server.js`, since a gadget may import it.
 * Any other gadget is its own session, as Cloudflare's "does not implement" fallback already makes it, without the
 * refused call, which can crash workerd once the workspace is aborted. The Workshop calls this where it would call
 * `connectViewer`: on a connection's first call, and again only after that failed. Reading `files` is its only cost.
 */
export async function p5ConnectGadgetViewer<Gadget, Viewer, Session>(
    gadget: Gadget, viewer: Viewer, connect: (gadget: Gadget, viewer: Viewer) => Promise<Session>,
    files: () => Promise<ReadonlyMap<string, unknown>>): Promise<Session | Gadget> {
  return namesConnectViewer(await files()) ? await connect(gadget, viewer) : gadget;
}

function namesConnectViewer(files: ReadonlyMap<string, unknown>): boolean {
  return [...files.values()].some(content => typeof content === "string" && content.includes("connectViewer"));
}
