import type { InteractionZone } from "./interaction.js";

export interface ContextualChatLayout {
  direction: "row" | "column";
  archive: { x: number; y: number; width: number; height: number };
  chat: { x: number; y: number; width: number; height: number };
}

/**
 * Grounded chat is a tool beside the archive, never a replacement for it.
 * Wide terminals use a sidecar; narrow terminals retain a compact archive
 * context above the chat drawer.
 */
export function contextualChatLayout(width: number, height: number): ContextualChatLayout {
  const safeWidth = Math.max(40, Math.floor(width));
  const safeHeight = Math.max(10, Math.floor(height));
  if (safeWidth >= 100) {
    const archiveWidth = Math.max(48, Math.min(84, Math.floor(safeWidth * 0.56)));
    const chatWidth = safeWidth - archiveWidth;
    return {
      direction: "row",
      archive: { x: 0, y: 0, width: archiveWidth, height: safeHeight },
      chat: { x: archiveWidth, y: 0, width: chatWidth, height: safeHeight },
    };
  }
  const archiveHeight = Math.max(3, Math.min(Math.max(3, safeHeight - 8), Math.floor(safeHeight * 0.4)));
  return {
    direction: "column",
    archive: { x: 0, y: 0, width: safeWidth, height: archiveHeight },
    chat: { x: 0, y: archiveHeight, width: safeWidth, height: safeHeight - archiveHeight },
  };
}

export function offsetInteractionZones(
  zones: readonly InteractionZone[],
  x: number,
  y: number,
  scope: string,
): InteractionZone[] {
  return zones.map((zone) => ({
    ...zone,
    id: `${scope}:${zone.id}`,
    parentId: undefined,
    rect: { ...zone.rect, x: zone.rect.x + x, y: zone.rect.y + y },
  }));
}
