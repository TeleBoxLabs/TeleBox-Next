import type { Message } from "@mtcute/core";
import { isoFromUnixSeconds } from "./dateRange";
import { safeJsonStringify, toIdString, toNumber } from "./json";
import type { LeechChatIdentity, LeechStoredMessage } from "./types";

function getClassName(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const anyVal = value as { className?: string; constructor?: { name?: string } };
  return anyVal.className ?? anyVal.constructor?.name ?? null;
}

function inferMediaType(msg: Message): string | null {
  const anyMsg = msg as unknown as { media?: unknown };
  if (!anyMsg.media) return null;
  return getClassName(anyMsg.media);
}

function getSenderName(sender: unknown): string | null {
  if (!sender) return null;
  const anySender = sender as {
    title?: string;
    firstName?: string;
    lastName?: string;
  };
  if (anySender.title) return anySender.title;
  const parts = [anySender.firstName, anySender.lastName].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

function buildRawMessageSnapshot(msg: Message): Record<string, unknown> {
  const anyMsg = msg as unknown as {
    className?: string;
    id: number;
    date: Date;
    editDate?: Date | null;
    text?: string;
    senderId?: unknown;
    chatId?: unknown;
    peerId?: unknown;
    replyTo?: { replyToMsgId?: number };
    replyToMessageId?: number;
    fwdFrom?: unknown;
    media?: unknown;
    entities?: unknown;
    groupedId?: unknown;
    postAuthor?: string;
    views?: number | null;
    forwards?: number | null;
    isOutgoing?: boolean;
  };
  return {
    className: anyMsg.className,
    id: anyMsg.id,
    date: anyMsg.date instanceof Date ? anyMsg.date.getTime() / 1000 : anyMsg.date,
    editDate: anyMsg.editDate ? (anyMsg.editDate instanceof Date ? anyMsg.editDate.getTime() / 1000 : anyMsg.editDate) : null,
    text: anyMsg.text,
    senderId: toIdString(anyMsg.senderId),
    chatId: toIdString(anyMsg.chatId),
    peerId: toIdString(anyMsg.peerId),
    replyTo: anyMsg.replyTo,
    fwdFrom: anyMsg.fwdFrom,
    mediaClassName: getClassName(anyMsg.media),
    entities: anyMsg.entities,
    groupedId: toIdString(anyMsg.groupedId),
    postAuthor: anyMsg.postAuthor,
    views: anyMsg.views ?? null,
    forwards: anyMsg.forwards ?? null,
    out: Boolean(anyMsg.isOutgoing),
    mentioned: false,
    post: false,
  };
}

/**
 * Convert a mtcute Message into a stable SQLite row.
 * 将 Telegram 消息转换为稳定的 SQLite 行，避免把 client/circular object 存入 DB。
 */
export function serializeLeechMessage(
  msg: Message,
  chat: LeechChatIdentity,
  jobId: number
): LeechStoredMessage | null {
  const anyMsg = msg as unknown as {
    id: number;
    date: Date;
    editDate?: Date | null;
    text?: string;
    senderId?: unknown;
    sender?: { username?: string; firstName?: string; lastName?: string };
    replyToMessage?: { id: number | null };
    groupedId?: unknown;
    views?: number | null;
    forwards?: number | null;
    isOutgoing?: boolean;
  };
  const messageId = toNumber(anyMsg.id);
  const dateTs = anyMsg.date instanceof Date ? Math.floor(anyMsg.date.getTime() / 1000) : toNumber(anyMsg.date);
  if (!messageId || !dateTs) return null;

  const sender = anyMsg.sender;
  const replyToMsgId = toNumber(anyMsg.replyToMessage?.id ?? null);
  const editDateTs = anyMsg.editDate
    ? anyMsg.editDate instanceof Date
      ? Math.floor(anyMsg.editDate.getTime() / 1000)
      : toNumber(anyMsg.editDate)
    : null;
  const dateIso = isoFromUnixSeconds(dateTs) ?? new Date(dateTs * 1000).toISOString();

  return {
    chatId: chat.chatId,
    messageId,
    firstJobId: jobId,
    lastJobId: jobId,
    dateTs,
    dateIso,
    editDateTs,
    senderId: toIdString(anyMsg.senderId),
    senderUsername: sender?.username ?? null,
    senderName: getSenderName(sender),
    messageText: typeof anyMsg.text === "string" ? anyMsg.text : null,
    rawJson: safeJsonStringify(buildRawMessageSnapshot(msg)),
    mediaType: inferMediaType(msg),
    replyToMsgId,
    groupedId: toIdString(anyMsg.groupedId),
    views: toNumber(anyMsg.views),
    forwards: toNumber(anyMsg.forwards),
    isOut: Boolean(anyMsg.isOutgoing),
    savedAt: new Date().toISOString(),
  };
}
