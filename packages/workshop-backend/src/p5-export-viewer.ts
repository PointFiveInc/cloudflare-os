import type { GadgetExportFormat, WorkpieceId } from "@gadgets/workshop-shared/api";
import { retryOnDoReset } from "./do-retry";
import type { ExportsHost } from "./exports-session";
import type { createWorkshopLogger } from "./observability";
import type { OverseerStorage } from "./storage-schema/overseer-storage";
import type { UserDurableObject } from "./user.js";

type ExportViewer = { id: string; name: string; role: "owner" | "build" };

/** The overseer's public state and export pipeline that the agent's exports need. */
export interface P5AgentExportsOverseer {
  storage: Pick<OverseerStorage, "activeAgents">;
  ownerId?: string;
  logger: ReturnType<typeof createWorkshopLogger>;
  ownerUserDo(): DurableObjectStub<UserDurableObject>;
  getGadgetExportFormats(gadgetId: WorkpieceId, chatId?: number): Promise<GadgetExportFormat[]>;
  exportGadget(gadgetId: WorkpieceId, formatId: string, chatId: number | undefined,
      viewer: ExportViewer): Promise<ReadableStream<Uint8Array>>;
}

/**
 * The agent's `exports` host: each export renders for the person whose message started the chat's
 * current turn, running or paused, read when the export is made. A turn a gadget started, or no turn,
 * renders for the workspace owner.
 */
export function p5AgentExportsHost(overseer: P5AgentExportsOverseer): ExportsHost {
  return {
    getGadgetExportFormats: (gadgetId, chatId) =>
      overseer.getGadgetExportFormats(gadgetId, chatId),
    exportGadget: async (gadgetId, formatId, chatId) =>
      overseer.exportGadget(gadgetId, formatId, chatId, await viewerFor(overseer, chatId)),
  };
}

async function viewerFor(overseer: P5AgentExportsOverseer, chatId?: number)
    : Promise<ExportViewer> {
  let turn = chatId === undefined ? undefined : overseer.storage.activeAgents.get(chatId);
  if (turn?.initiator.type === "user") {
    let { id, name } = turn.initiator;
    return { id, name, role: turn.initiatorUserId === overseer.ownerId ? "owner" : "build" };
  }
  let { id, name } = await retryOnDoReset(() => overseer.ownerUserDo().whoami(), overseer.logger);
  return { id, name, role: "owner" };
}
