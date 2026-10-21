/**
 * What a person's listing of a workspace says until they open it: who shared it with them, or who
 * named them in which chat.
 */
export type P5Mark =
  | { kind: "share"; by: string }
  | { kind: "mention"; by: string; chatId: number; chatTitle?: string };

/** A workspace listing that can carry a mark. Absent means unmarked, so older records need no change. */
export type P5Marked = { p5Mark?: P5Mark };
