import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { thtml as html, TelegramClient, type InputPeerLike } from "@mtcute/node";
import type { MessageContext } from "@mtcute/dispatcher";
import { createDirectoryInTemp } from "@utils/pathHelpers";
import fs from "fs";
import path from "path";
import { getGlobalClient } from "@utils/runtimeManager";
import { execFile } from "child_process";
import { promisify } from "util";
import { getCurrentGenerationContext } from "@utils/runtimeManager";
import { reloadRuntime } from "@utils/runtimeManager";
import { logger } from "@utils/logger";
import { htmlEscape } from "@utils/htmlEscape";
import { getErrorMessage } from "@utils/errorHelpers";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const execFileAsync = promisify(execFile);

const exitDir = createDirectoryInTemp("exit");
const exitFile = path.join(exitDir, "msg.json");
const pendingExitTimers = new Set<ReturnType<typeof setTimeout>>();

async function updateReloadStatus(params: {
  client: TelegramClient;
  targetChat: InputPeerLike;
  targetMessageId: number;
  text: string;
  isHtml?: boolean;
}) {
  const { client, targetChat, targetMessageId, text, isHtml } = params;
  try {
    await client?.editMessage({
      chatId: targetChat,
      message: targetMessageId,
      text: isHtml ? html(text) : text,
    });
  } catch (error: unknown) {
    logger.error("Failed to edit reload status message, falling back to sendText:", error);
    try {
      await client?.sendText(targetChat, isHtml ? html(text) : text);
    } catch (sendError: unknown) {
      logger.error("Fallback sendText also failed (client may be destroyed):", sendError);
    }
  }
}

function scheduleTrackedTimeout(
  callback: () => void | Promise<void>,
  delay: number
): ReturnType<typeof setTimeout> {
  let timer: ReturnType<typeof setTimeout>;
  const context = getCurrentGenerationContext();
  timer = context.setTimeout(() => {
    pendingExitTimers.delete(timer);
    const task = Promise.resolve(callback());
    context.trackTask(task, { label: "reload:scheduled-timeout" });
    task.catch((error: unknown) => {
      logger.error("[RELOAD] Scheduled timeout failed:", error);
    });
  }, delay, { label: "reload:scheduled-timeout" });
  pendingExitTimers.add(timer);
  return timer;
}

const editExitMsg = async () => {
  try {
    const data = fs.readFileSync(exitFile, "utf-8");
    const { messageId, chatId, time, successText, isHtml } = JSON.parse(data);
    const client = await getGlobalClient();
    if (client) {
      const elapsedMs = Date.now() - time;
      const tmpl: string = successText || "✅ 重启完成，耗时 {elapsedMs}ms";
      const text = tmpl.replace(/\{elapsedMs\}/g, String(elapsedMs));
      await client.editMessage({
        chatId,
        message: messageId,
        text: isHtml ? html(text) : text,
      });
      fs.unlinkSync(exitFile);
    }
  } catch (e: unknown) {
    logger.error("Failed to edit exit message:", e);
  }
};

if (fs.existsSync(exitFile)) {
  editExitMsg().catch((e: unknown) => logger.error("Failed to handle exit message on startup:", e));
}

export async function executeExit(
  msg: MessageContext,
  options?: {
    pendingText?: string;
    successText?: string;
    isHtml?: boolean;
  }
) {
  const pendingText = options?.pendingText ?? "🔄 正在结束进程...";
  const isHtml = options?.isHtml ?? false;
  const result = await msg.edit({
    text: isHtml ? html(pendingText) : pendingText,
  });
  if (result) {
    fs.writeFileSync(
      exitFile,
      JSON.stringify({
        messageId: result.id,
        chatId: result.chat.id,
        time: Date.now(),
        successText: options?.successText,
        isHtml,
      }),
      "utf-8"
    );
  }
  process.exit(0);
}

const HELP_TEXT = `🔄 Reload - 插件重载

🔧 命令:
• <code>${mainPrefix}reload</code> - 重新加载所有插件
• <code>${mainPrefix}exit</code> / <code>${mainPrefix}restart</code> - 退出进程（PM2 自动拉起）
• <code>${mainPrefix}pmr</code> - PM2 进程重启

🩺 内存与健康请使用系统插件 <code>health</code>：
• <code>${mainPrefix}health</code> · <code>${mainPrefix}memory status</code>
`;

class ReloadPlugin extends Plugin {
  cleanup(): void {
    for (const timer of pendingExitTimers) {
      clearTimeout(timer);
    }
    pendingExitTimers.clear();
  }

  description = HELP_TEXT;

  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    reload: async (msg) => {
      const statusMessage = await msg.edit({ text: "🔄 正在重新加载插件..." });
      const targetChat = statusMessage?.chat?.id ?? msg.chat.id;
      const targetMessageId = statusMessage?.id ?? msg.id;
      try {
        const startTime = Date.now();
        const runtime = await reloadRuntime();
        const loadTime = Date.now() - startTime;
        try {
          const { noteReloadCompleted } = await import("./health");
          await noteReloadCompleted();
        } catch (e: unknown) {
          logger.warn("[RELOAD] noteReloadCompleted:", e);
        }
        await updateReloadStatus({
          client: runtime.client,
          targetChat,
          targetMessageId,
          text: `✅ 重载完成，耗时 ${loadTime}ms`,
          isHtml: true,
        });
      } catch (error: unknown) {
        logger.error("Plugin reload failed:", error);
        const errorMessage = getErrorMessage(error) || String(error);
        try {
          const client = await getGlobalClient();
          await updateReloadStatus({
            client,
            targetChat,
            targetMessageId,
            text: `❌ 插件重新加载失败\n错误信息：${htmlEscape(errorMessage)}\n请检查控制台日志获取详细信息`,
          });
        } catch (editError: unknown) {
          logger.error("Failed to update reload status message:", editError);
        }
      }
    },

    exit: async (msg) => {
      await executeExit(msg);
    },

    restart: async (msg) => {
      await executeExit(msg);
    },

    pmr: async (msg) => {
      await msg.delete();
      scheduleTrackedTimeout(async () => {
        try {
          const pm2Name = process.env.name || "telebox-next";
          await execFileAsync("pm2", ["restart", pm2Name]);
        } catch (error: unknown) {
          logger.error("PM2 restart failed:", error);
        }
      }, 500);
    },
  };
}

export default new ReloadPlugin();
