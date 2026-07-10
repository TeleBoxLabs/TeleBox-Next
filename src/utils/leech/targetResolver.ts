import type { TelegramClient, Peer, Chat, User } from "@mtcute/node";
import { toIdString } from "./json";
import type { LeechChatIdentity } from "./types";

function normalizeTelegramLink(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/^https?:\/\/t\.me\/(.+)$/i);
  if (!match) return trimmed;

  const path = match[1].replace(/[?#].*$/, "");
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "c" && parts[1]) {
    return `-100${parts[1]}`;
  }
  if (parts[0]) {
    return parts[0].startsWith("@") ? parts[0] : `@${parts[0]}`;
  }
  return trimmed;
}

function isChat(peer: Peer): peer is Chat {
  return (peer as { type?: string }).type === "chat";
}

function isUser(peer: Peer): peer is User {
  return (peer as { type?: string }).type === "user";
}

function fullChatId(entity: Peer): string {
  const raw = toIdString(entity.id) ?? "unknown";
  if (isChat(entity)) {
    const chatType = entity.chatType;
    if (chatType === "channel" || chatType === "supergroup") {
      return raw.startsWith("-100") ? raw : `-100${raw.replace(/^-100/, "")}`;
    }
    if (chatType === "group") {
      return raw.startsWith("-") ? raw : `-${raw}`;
    }
    return raw;
  }
  return raw;
}

function chatTitle(entity: Peer): string {
  const anyEntity = entity as { title?: string; firstName?: string; lastName?: string; username?: string | null };
  if (anyEntity.title) return anyEntity.title;
  const parts = [anyEntity.firstName, anyEntity.lastName].filter(Boolean);
  if (parts.length) return parts.join(" ");
  if (anyEntity.username) return `@${anyEntity.username}`;
  return (entity as { type?: string }).type || "unknown";
}

function chatType(entity: Peer): string {
  if (isChat(entity)) {
    return entity.chatType;
  }
  if (isUser(entity)) {
    return entity.isBot ? "bot" : "user";
  }
  return (entity as { type?: string }).type || "unknown";
}

export async function resolveLeechTarget(params: {
  client: TelegramClient;
  commandMessage: { chat: Peer; sender?: Peer };
  targetInput?: string;
}): Promise<{ entity: Peer; identity: LeechChatIdentity }> {
  const targetInput = params.targetInput?.trim();
  const hereAliases = new Set(["", "here", "current", "this", "当前", "本群"]);

  let entityLike: string | number | Peer;
  if (!targetInput || hereAliases.has(targetInput.toLowerCase())) {
    entityLike = params.commandMessage.chat;
  } else {
    const normalized = normalizeTelegramLink(targetInput);
    entityLike = /^-?\d+$/.test(normalized) || normalized.startsWith("@")
      ? normalized
      : `@${normalized}`;
  }

  const entity = await params.client.getChat(entityLike as never);
  const rawUsername = (entity as { username?: string | null }).username;
  const identity: LeechChatIdentity = {
    input: targetInput || "here",
    chatId: fullChatId(entity),
    chatTitle: chatTitle(entity),
    chatType: chatType(entity),
    username: rawUsername ? `@${rawUsername}` : undefined,
  };

  return { entity, identity };
}
