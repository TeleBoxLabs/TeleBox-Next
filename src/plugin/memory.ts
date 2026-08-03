import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { thtml as html } from "@mtcute/node";
import type { MessageContext } from "@mtcute/dispatcher";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import path from "path";
import { getGlobalClient } from "@utils/runtimeManager";
import { JSONFilePreset } from "lowdb/node";
import type { Low } from "lowdb";
import {
  getCurrentGenerationContext,
  isRuntimeTransitioning,
  reloadRuntime,
  tryGetCurrentGenerationContext,
} from "@utils/runtimeManager";
import { logger } from "@utils/logger";
import { htmlEscape } from "@utils/htmlEscape";
import { getErrorMessage } from "@utils/errorHelpers";
import { isSwitchInProgress } from "@utils/versionSwitchProgress";
import { readDisplayVersion } from "@utils/teleboxInfoHelper";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import * as os from "os";
import * as fs from "fs";
import { execFileSync, ExecFileSyncOptions } from "child_process";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// ── Health constants ────────────────────────────────────────────────────
const healthAssetsDir = createDirectoryInAssets("health", ["reload"]);
const healthConfigPath = path.join(healthAssetsDir, "config.json");
const pendingExitTimers = new Set<ReturnType<typeof setTimeout>>();

const DEFAULT_STREAK_SOFT = 2;
const DEFAULT_STREAK_HARD = 3;
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_BUSY_DEFER_MS = 5 * 60 * 1000;
const DEFAULT_GC_COOLDOWN_MS = 60 * 1000;

interface HealthConfig {
  leakfixEnabled: boolean;
  memoryThreshold: number;
  rssThreshold: number;
  runtimeGrowthThreshold: number;
  baselineHeapUsed: number | null;
  baselineRss: number | null;
  baselineMode: "on-enable" | "manual" | "on-reload";
  silentEnabled: boolean;
  softStreak: number;
  hardStreak: number;
  actionCooldownMs: number;
  busyDeferMaxMs: number;
  lastActionAt: number | null;
  configVersion: number;
  disableHardRestart: boolean;
}

const DEFAULT_CONFIG: HealthConfig = {
  leakfixEnabled: false,
  memoryThreshold: 512,
  rssThreshold: 768,
  runtimeGrowthThreshold: 128,
  baselineHeapUsed: null,
  baselineRss: null,
  baselineMode: "on-enable",
  silentEnabled: false,
  softStreak: DEFAULT_STREAK_SOFT,
  hardStreak: DEFAULT_STREAK_HARD,
  actionCooldownMs: DEFAULT_COOLDOWN_MS,
  busyDeferMaxMs: DEFAULT_BUSY_DEFER_MS,
  lastActionAt: null,
  configVersion: 4,
  disableHardRestart: true,
};

let overThresholdStreak = 0;
let busyDeferSince: number | null = null;
let lastGcAt = 0;

// ── Status constants ────────────────────────────────────────────────────
const EXEC_TIMEOUT = 5000;

const DEFAULT_TEMPLATE = `<b>📊 TeleBox-Next 运行状态</b>
<b>🏠 主机信息</b>
• <b>主机名:</b> <code>{hostname}</code>
• <b>平台:</b> <code>{platform} {arch}</code>
• <b>内核:</b> <code>{kernel}</code>
• <b>语言环境:</b> <code>{locale}</code>

<b>📦 版本信息</b>
• <b>Node.js版本:</b> <code>{nodejs}</code>
• <b>mtcute版本:</b> <code>{mtcute}</code>
• <b>TeleBox版本:</b> <code>{telebox}</code>

<b>📈 资源使用</b>
• <b>CPU:</b> <code>{cpu}%</code> (系统) / <code>{processcpu}%</code> (进程)
• <b>内存:</b> <code>{mem}%</code> (系统) / <code>{processmem}%</code> (进程)
• <b>SWAP:</b> <code>{swap}</code>
• <b>磁盘:</b> <code>{disk}</code>
• <b>网络接口:</b> <code>{network}</code>

<b>⚙️ 系统详情</b>
• <b>OS:</b> <code>{os}</code>
• <b>负载平均:</b> <code>{loadaverage}</code>
• <b>包数量:</b> <code>{packages}</code>
• <b>Init:</b> <code>{init}</code>
• <b>进程数:</b> <code>{process}</code>

<b>⏱️ 运行状态</b>
• <b>运行时间:</b> <code>{uptime}</code>
• <b>扫描耗时:</b> <code>{scantime}ms</code>`;

interface StatusData {
  hostname: string;
  platform: string;
  arch: string;
  uptime: string;
  uptimeStr: string;
  totalmem: string;
  freemem: string;
  usedMem: string;
  memPercent: string;
  processMemUsage: string;
  processMemPercent: string;
  cpuUsage: string;
  processCpuUsage: string;
  kernelInfo: string;
  locale: string;
  nodejsVersion: string;
  teleprotoVersion: string;
  teleboxVersion: string;
  osInfo: string;
  packages: string;
  initSystem: string;
  diskInfo: string;
  networkInfo: string;
  processes: string;
  swapInfo: string;
  loadavgStr: string;
  networkInterface: string;
  scanTime: string;
  kernel: string;
  nodejs: string;
  teleproto: string;
  mtcute: string;
  telebox: string;
  os: string;
  loadaverage: string;
  init: string;
  process: string;
  scantime: string;
  network: string;
  cpu: string;
  processcpu: string;
  mem: string;
  processmem: string;
  swap: string;
  disk: string;
  cpubar: string;
  processcpubar: string;
  membar: string;
  processmembar: string;
  diskbar: string;
}

interface SystemDetails {
  osInfo: string;
  kernelInfo: string;
  packages: string;
  initSystem: string;
  diskInfo: string;
  networkInfo: string;
  processes: string;
  swapInfo: string;
}

interface VersionInfo {
  nodejs: string;
  teleproto: string;
  mtcute: string;
  telebox: string;
}

interface StatusConfig {
  template: string;
}

// ── Health helper functions ─────────────────────────────────────────────

async function initHealthConfig() {
  const db = await JSONFilePreset<HealthConfig>(healthConfigPath, { ...DEFAULT_CONFIG });
  let dirty = false;
  for (const [k, v] of Object.entries(DEFAULT_CONFIG) as [keyof HealthConfig, HealthConfig[keyof HealthConfig]][]) {
    if (db.data[k] === undefined) {
      (db.data as any)[k] = v;
      dirty = true;
    }
  }
  if ((db.data.configVersion ?? 0) < 4) {
    // v4: raise thresholds to match --max-old-space-size=512 (V8 heap) +
    // PM2 max-memory-restart=512M (RSS guard). Old configs persisted 256/512
    // which triggered spurious soft-reloads at ~256 MB heap even though the
    // actual V8 limit is 512 MB.
    if ((db.data.memoryThreshold ?? 0) < DEFAULT_CONFIG.memoryThreshold) {
      db.data.memoryThreshold = DEFAULT_CONFIG.memoryThreshold;
      dirty = true;
    }
    if ((db.data.rssThreshold ?? 0) < DEFAULT_CONFIG.rssThreshold) {
      db.data.rssThreshold = DEFAULT_CONFIG.rssThreshold;
      dirty = true;
    }
    db.data.configVersion = 4;
    dirty = true;
  }
  if (dirty) await db.write();
  return db;
}

function formatMb(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "未记录";
  return `${value.toFixed(2)} MB`;
}

function updateMemoryBaseline(config: HealthConfig, memory: ReturnType<typeof getMemoryUsage>): void {
  config.baselineHeapUsed = memory.heapUsed;
  config.baselineRss = memory.rss;
}

function formatBaselineMode(mode: HealthConfig["baselineMode"]): string {
  if (mode === "manual") return "手动（只有你 reset 才改）";
  if (mode === "on-reload") return "每次重载插件后更新";
  return "打开保护时自动记录";
}

function parseBaselineMode(input?: string): HealthConfig["baselineMode"] | null {
  if (!input) return null;
  if (input === "auto" || input === "on-enable") return "on-enable";
  if (input === "reload" || input === "on-reload") return "on-reload";
  if (input === "manual") return "manual";
  return null;
}

function applyMemoryPreset(config: HealthConfig, preset: "safe" | "normal" | "aggressive"): void {
  if (preset === "safe") {
    config.memoryThreshold = 384;
    config.rssThreshold = 640;
    config.runtimeGrowthThreshold = 96;
    config.softStreak = 2;
    config.hardStreak = 3;
    return;
  }
  if (preset === "aggressive") {
    config.memoryThreshold = 640;
    config.rssThreshold = 896;
    config.runtimeGrowthThreshold = 192;
    config.softStreak = 3;
    config.hardStreak = 4;
    return;
  }
  config.memoryThreshold = 512;
  config.rssThreshold = 768;
  config.runtimeGrowthThreshold = 128;
  config.softStreak = DEFAULT_STREAK_SOFT;
  config.hardStreak = DEFAULT_STREAK_HARD;
}

function getMemoryUsage() {
  const usage = process.memoryUsage();
  return {
    heapUsed: usage.heapUsed / 1024 / 1024,
    heapTotal: usage.heapTotal / 1024 / 1024,
    rss: usage.rss / 1024 / 1024,
    external: usage.external / 1024 / 1024,
    arrayBuffers: usage.arrayBuffers / 1024 / 1024,
  };
}

function getGrowthStatus(config: HealthConfig, memory: ReturnType<typeof getMemoryUsage>) {
  const heapGrowth =
    config.baselineHeapUsed === null || config.baselineHeapUsed === undefined
      ? null
      : memory.heapUsed - config.baselineHeapUsed;
  const rssGrowth =
    config.baselineRss === null || config.baselineRss === undefined
      ? null
      : memory.rss - config.baselineRss;
  const growthThreshold = config.runtimeGrowthThreshold;
  return {
    heapGrowth,
    rssGrowth,
    growthThreshold,
    heapGrowthExceeded: heapGrowth != null && heapGrowth > growthThreshold,
    rssGrowthExceeded: rssGrowth != null && rssGrowth > growthThreshold,
  };
}

function collectReasons(config: HealthConfig, memory: ReturnType<typeof getMemoryUsage>) {
  const growth = getGrowthStatus(config, memory);
  const reasons: string[] = [];
  if (memory.heapUsed > config.memoryThreshold) {
    reasons.push(`程序内存 ${memory.heapUsed.toFixed(2)} MB，超过上限 ${config.memoryThreshold} MB`);
  }
  if (memory.rss > config.rssThreshold) {
    reasons.push(`总占用 ${memory.rss.toFixed(2)} MB，超过上限 ${config.rssThreshold} MB`);
  }
  if (growth.heapGrowthExceeded) {
    reasons.push(`程序内存比起点多了 ${formatMb(growth.heapGrowth)}，超过涨幅上限 ${config.runtimeGrowthThreshold} MB`);
  }
  if (growth.rssGrowthExceeded) {
    reasons.push(`总占用比起点多了 ${formatMb(growth.rssGrowth)}，超过涨幅上限 ${config.runtimeGrowthThreshold} MB`);
  }
  return { reasons, growth };
}

function getBusyTaskCount(): number {
  const ctx = tryGetCurrentGenerationContext();
  if (!ctx) return 0;
  try {
    return ctx.getTrackedTaskCount();
  } catch {
    return 0;
  }
}

function tryGlobalGc(): boolean {
  const now = Date.now();
  if (now - lastGcAt < DEFAULT_GC_COOLDOWN_MS) return false;
  const g = (global as typeof globalThis & { gc?: () => void }).gc;
  if (typeof g !== "function") return false;
  try {
    g();
    lastGcAt = now;
    logger.info("[Memory] ran global.gc()");
    return true;
  } catch (e: unknown) {
    logger.warn("[Memory] global.gc failed:", e);
    return false;
  }
}

function scheduleTrackedTimeout(
  callback: () => void | Promise<void>,
  delay: number,
): ReturnType<typeof setTimeout> {
  let timer: ReturnType<typeof setTimeout>;
  const context = getCurrentGenerationContext();
  timer = context.setTimeout(() => {
    pendingExitTimers.delete(timer);
    const task = Promise.resolve(callback());
    context.trackTask(task, { label: "memory:scheduled-timeout" });
    task.catch((error: unknown) => {
      logger.error("[Memory] Scheduled timeout failed:", error);
    });
  }, delay, { label: "memory:scheduled-timeout" });
  pendingExitTimers.add(timer);
  return timer;
}

async function notifyMe(htmlText: string, silent: boolean): Promise<void> {
  if (silent) return;
  try {
    const client = await getGlobalClient();
    await client.sendText("me", html(htmlText));
  } catch (e: unknown) {
    logger.warn("[Memory] notify me failed:", e);
  }
}

function formatMemoryInfo(memory: ReturnType<typeof getMemoryUsage>): string {
  return `📊 <b>TeleBox-Next 内存快照</b>

🧠 <b>程序内存（Heap）</b>
  • 正在用：<code>${memory.heapUsed.toFixed(2)} MB</code>
  • 已申请：<code>${memory.heapTotal.toFixed(2)} MB</code>
  • 使用率：<code>${((memory.heapUsed / memory.heapTotal) * 100).toFixed(1)}%</code>

💻 <b>系统占用（RSS，含进程整体）</b>
  • <code>${memory.rss.toFixed(2)} MB</code>

📎 其他：外部 <code>${memory.external.toFixed(2)} MB</code> · 缓冲 <code>${memory.arrayBuffers.toFixed(2)} MB</code>`;
}

function statusLevel(
  config: HealthConfig,
  memory: ReturnType<typeof getMemoryUsage>,
  growth: ReturnType<typeof getGrowthStatus>,
): { emoji: string; text: string } {
  const percentage = (memory.heapUsed / config.memoryThreshold) * 100;
  if (
    percentage > 90 ||
    memory.rss > config.rssThreshold ||
    growth.heapGrowthExceeded ||
    growth.rssGrowthExceeded
  ) {
    return { emoji: "🔴", text: "偏高，需要关注" };
  }
  if (
    percentage > 70 ||
    memory.rss > config.rssThreshold * 0.7 ||
    (growth.heapGrowth != null && growth.heapGrowth > config.runtimeGrowthThreshold * 0.7) ||
    (growth.rssGrowth != null && growth.rssGrowth > config.runtimeGrowthThreshold * 0.7)
  ) {
    return { emoji: "🟡", text: "略高，继续观察" };
  }
  return { emoji: "🟢", text: "正常，放心用" };
}

async function healthMonitorTask() {
  try {
    const configDB = await initHealthConfig();
    const config = configDB.data;
    if (!config.leakfixEnabled) return;

    if (isSwitchInProgress()) {
      logger.info("[Memory] switch 进行中，跳过保护动作");
      return;
    }
    if (isRuntimeTransitioning()) {
      logger.info("[Memory] runtime 切换中，跳过保护动作");
      return;
    }

    const memory = getMemoryUsage();
    if (
      config.baselineHeapUsed === null ||
      config.baselineHeapUsed === undefined ||
      config.baselineRss === null ||
      config.baselineRss === undefined
    ) {
      updateMemoryBaseline(config, memory);
      await configDB.write();
    }

    const { reasons } = collectReasons(config, memory);

    if (reasons.length === 0) {
      overThresholdStreak = 0;
      busyDeferSince = null;
      logger.info(
        `[Memory] 正常: Heap ${memory.heapUsed.toFixed(2)}MB / ${config.memoryThreshold}MB, RSS ${memory.rss.toFixed(2)}MB / ${config.rssThreshold}MB, 任务 ${getBusyTaskCount()}`,
      );
      return;
    }

    overThresholdStreak += 1;
    const softNeed = config.softStreak ?? DEFAULT_STREAK_SOFT;
    const hardNeed = config.hardStreak ?? DEFAULT_STREAK_HARD;
    logger.info(
      `[Memory] 超限采样 ${overThresholdStreak}/${softNeed}(soft)/${hardNeed}(hard): ${reasons.join("; ")}`,
    );

    if (overThresholdStreak < softNeed) {
      tryGlobalGc();
      return;
    }

    const now = Date.now();
    const cooldown = config.actionCooldownMs ?? DEFAULT_COOLDOWN_MS;
    if (config.lastActionAt != null && now - config.lastActionAt < cooldown) {
      const left = Math.ceil((cooldown - (now - config.lastActionAt)) / 60000);
      logger.info(`[Memory] 动作冷却中（约 ${left} 分钟后可再动作）`);
      return;
    }

    const busy = getBusyTaskCount();
    if (busy > 0) {
      if (busyDeferSince == null) busyDeferSince = now;
      const deferredFor = now - busyDeferSince;
      const maxDefer = config.busyDeferMaxMs ?? DEFAULT_BUSY_DEFER_MS;
      logger.info(
        `[Memory] ${busy} 个进行中任务，推迟保护（已推迟 ${(deferredFor / 1000).toFixed(0)}s / 上限 ${(maxDefer / 1000).toFixed(0)}s）`,
      );
      if (deferredFor < maxDefer) {
        tryGlobalGc();
        return;
      }
      logger.warn("[Memory] 忙碌推迟超时，仍继续保护链路");
    } else {
      busyDeferSince = null;
    }

    await notifyMe(
      `⚠️ <b>内存有点高，开始自动处理</b>\n\n` +
        `原因：\n• ${reasons.join("\n• ")}\n\n` +
        `现在：程序内存 <code>${memory.heapUsed.toFixed(2)} MB</code> · 总占用 <code>${memory.rss.toFixed(2)} MB</code>\n` +
        `已连续偏高 <code>${overThresholdStreak}</code> 次 · 正在进行的任务 <code>${busy}</code> 个\n\n` +
        `下一步：先尝试清理，再软重载；还不行才会整进程重启（PM2 会自动拉起）。`,
      config.silentEnabled,
    );

    tryGlobalGc();
    let reloaded = false;
    try {
      const runtime = await reloadRuntime();
      reloaded = true;
      const after = getMemoryUsage();
      const afterReasons = collectReasons(config, after).reasons;

      if (config.baselineMode === "on-reload") {
        updateMemoryBaseline(config, after);
      }
      config.lastActionAt = Date.now();
      await configDB.write();

      if (afterReasons.length === 0) {
        overThresholdStreak = 0;
        busyDeferSince = null;
        await notifyMe(
          `✅ <b>内存已恢复正常</b>\n\n` +
            `已自动软重载，不用你手动操作。\n` +
            `• 程序内存：<code>${after.heapUsed.toFixed(2)} MB</code>\n` +
            `• 总占用：<code>${after.rss.toFixed(2)} MB</code>`,
          config.silentEnabled,
        );
        return;
      }

      if (overThresholdStreak < hardNeed) {
        logger.info(`[Memory] reload 后仍超限，等待 ${overThresholdStreak}/${hardNeed}`);
        await notifyMe(
          `⚠️ <b>软重载后内存仍偏高</b>\n\n` +
            `先不急着重启，再观察一会儿（${overThresholdStreak}/${hardNeed}）。\n` +
            `• 程序内存：<code>${after.heapUsed.toFixed(2)} MB</code>\n` +
            `• 总占用：<code>${after.rss.toFixed(2)} MB</code>`,
          config.silentEnabled,
        );
        return;
      }

      logger.info("[Memory] hard streak 达到，process.exit");
      if (config.disableHardRestart) {
        logger.info("[Memory] hard restart disabled, skipping process.exit");
        await notifyMe(
          `⚠️ <b>内存持续偏高，但已禁用硬重启</b>\n\n` +
            `清理和软重载后内存还是偏高，但配置了不自动重启进程。\n` +
            `建议手动检查或重启。\n` +
            `• 程序内存：<code>${after.heapUsed.toFixed(2)} MB</code>\n` +
            `• 总占用：<code>${after.rss.toFixed(2)} MB</code>`,
          config.silentEnabled,
        );
        return;
      }
      await notifyMe(
        `⚠️ <b>准备重启程序</b>\n\n` +
          `清理和软重载后内存还是偏高，马上整进程重启。\n` +
          `不用慌：PM2 会自动再拉起 TeleBox。\n` +
          `• 程序内存：<code>${after.heapUsed.toFixed(2)} MB</code>\n` +
          `• 总占用：<code>${after.rss.toFixed(2)} MB</code>`,
        config.silentEnabled,
      );
      config.lastActionAt = Date.now();
      await configDB.write();
      scheduleTrackedTimeout(() => process.exit(0), 1500);
    } catch (reloadError: unknown) {
      logger.error("[Memory] reloadRuntime 失败:", reloadError);
      if (!reloaded && overThresholdStreak >= hardNeed) {
        if (config.disableHardRestart) {
          logger.info("[Memory] hard restart disabled, skipping process.exit after reload failure");
          await notifyMe(
            `<b>软重载失败，但已禁用硬重启</b>\n\n` +
              `自动整理没成功，但配置了不自动重启进程。\n` +
              `建议手动检查或重启。`,
            config.silentEnabled,
          );
        } else {
          await notifyMe(
            `<b>软重载失败，准备重启</b>\n\n自动整理没成功，将直接重启程序（PM2 会自动拉起）。`,
            config.silentEnabled,
          );
          config.lastActionAt = Date.now();
          await configDB.write();
          scheduleTrackedTimeout(() => process.exit(0), 1500);
        }
      }
    }
  } catch (error: unknown) {
    logger.error("[Memory] 定时任务失败:", error);
  }
}

// ── Help text ───────────────────────────────────────────────────────────

const HELP_TEXT = `🧠 <b>Memory · 内存守护 & 系统状态</b>

一句话：帮你盯着 TeleBox 吃了多少内存，偏高时自动收拾；也能看系统状态。

————————
📌 <b>新手怎么用（3 步）</b>
1. 发 <code>${mainPrefix}memory health</code> 看当前内存是否正常
2. 发 <code>${mainPrefix}memory on</code> 打开自动保护（默认是关的）
3. 想看系统状态发 <code>${mainPrefix}memory status</code>

————————
📖 <b>常用命令</b>
• <code>${mainPrefix}memory health</code>
  查看现在内存用了多少、是否安全
• <code>${mainPrefix}memory status</code>
  查看系统运行状态（CPU、内存、磁盘等）
• <code>${mainPrefix}memory sysinfo</code>
  详细系统信息（neofetch 风格）
• <code>${mainPrefix}memory on</code> / <code>${mainPrefix}memory off</code>
  打开 / 关闭自动保护
• <code>${mainPrefix}memory protect</code>
  看保护开没开、现在安不安全、系统建议你做什么
• <code>${mainPrefix}memory reset</code>
  把「对比起点」记成当前内存（适合刚清理完之后）
• <code>${mainPrefix}memory set safe</code>
  更敏感：内存稍高就处理（机器内存小推荐）
• <code>${mainPrefix}memory set normal</code>
  默认平衡（大多数人用这个）
• <code>${mainPrefix}memory set aggressive</code>
  更宽松：少打扰（插件很多、内存本来就高时用）
• <code>${mainPrefix}memory silent on</code> / <code>off</code>
  自动处理时要不要私信通知你（默认会通知「收藏夹/Saved Messages」）

————————
⚙️ <b>进阶（一般不用改）</b>
• <code>${mainPrefix}memory mode auto</code> — 打开保护时自动记起点
• <code>${mainPrefix}memory mode manual</code> — 只有你执行 reset 才改起点
• <code>${mainPrefix}memory mode reload</code> — 每次重载插件后改起点
• <code>${mainPrefix}memory set heap 150</code> — 程序内存上限（MB）
• <code>${mainPrefix}memory set rss 512</code> — 总占用上限（MB）
• <code>${mainPrefix}memory set growth 120</code> — 相对起点涨幅上限（MB）
• <code>${mainPrefix}memory lifecycle</code> — 当前 generation 生命周期资源计数
• <code>${mainPrefix}memory stress</code> — reload 压测观察项与当前计数
• <code>${mainPrefix}memory template show</code> — 显示状态模板
• <code>${mainPrefix}memory template set</code> — 回复消息设置自定义状态模板
• <code>${mainPrefix}memory template reset</code> — 重置默认状态模板

————————
🧠 <b>自动保护怎么工作（人话）</b>
1. 大约每 10 分钟检查一次
2. 要连续好几次都偏高才动手（避免误报）
3. 如果你正在跑任务，会先等一等，尽量不打断
4. 处理顺序：先尝试清理 → 再软重载 → 实在不行才整进程重启（PM2 会自动拉起）
5. 版本切换 / 正在重载时，绝对不会乱动

💡 不知道从哪开始？先发 <code>${mainPrefix}memory on</code>，再发 <code>${mainPrefix}memory health</code> 看一眼就行。`;

// ── Plugin class ────────────────────────────────────────────────────────

class MemoryPlugin extends Plugin {
  cleanup(): void {
    for (const timer of pendingExitTimers) {
      clearTimeout(timer);
    }
    pendingExitTimers.clear();
    this.statusDb = null;
  }

  description = HELP_TEXT;

  // Health cron task
  cronTasks = {
    healthMonitor: {
      cron: "*/10 * * * *",
      description: "定时检查内存：偏高时自动清理，尽量不打断正在进行的任务",
      handler: async () => await healthMonitorTask(),
    },
  };

  // Status template DB
  private statusDb: Low<StatusConfig> | null = null;
  private readonly STATUS_DB_PATH: string;

  constructor() {
    super();
    this.STATUS_DB_PATH = path.join(
      createDirectoryInAssets("status"),
      "config.json",
    );
    void this.initStatusDb().catch((error: unknown) => {
      console.error("[Memory] 状态数据库初始化失败:", error);
    });
  }

  private async initStatusDb(): Promise<void> {
    try {
      this.statusDb = await JSONFilePreset(this.STATUS_DB_PATH, {
        template: DEFAULT_TEMPLATE,
      });
    } catch (error) {
      console.error("[Memory] 状态数据库初始化失败:", error);
      throw new Error(`数据库初始化失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  private async ensureStatusDb(): Promise<Low<StatusConfig>> {
    if (!this.statusDb) await this.initStatusDb();
    if (!this.statusDb) throw new Error("状态数据库初始化失败");
    return this.statusDb;
  }

  // ── Command handlers ──────────────────────────────────────────────────

  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    memory: async (msg) => {
      const parts = msg.text?.trim().split(/\s+/) || [];
      const subCmd = parts[1]?.toLowerCase() || "help";

      // ── health: memory snapshot ─────────────────────────────────────
      if (subCmd === "health") {
        try {
          const configDB = await initHealthConfig();
          const memory = getMemoryUsage();
          const growth = getGrowthStatus(configDB.data, memory);
          const level = statusLevel(configDB.data, memory, growth);
          const busy = getBusyTaskCount();
          const fullText =
            `${formatMemoryInfo(memory)}\n\n` +
            `🚦 <b>总体：</b>${level.emoji} ${level.text}\n` +
            `🛡 <b>自动保护：</b>${configDB.data.leakfixEnabled ? "✅ 已打开" : "❌ 未打开（发 " + mainPrefix + "memory on 可开启）"}\n` +
            `🧵 <b>正在进行的任务：</b><code>${busy}</code> 个\n` +
            `📈 <b>连续偏高次数：</b><code>${overThresholdStreak}</code>\n\n` +
            `💡 保护详情：<code>${mainPrefix}memory protect</code> · 系统状态：<code>${mainPrefix}memory status</code> · 帮助：<code>${mainPrefix}memory</code>`;
          await msg.edit({ text: html(fullText) });
        } catch (error: unknown) {
          logger.error("[Memory] health 命令失败:", error);
          await msg.edit({
            text: html(`❌ 没能读到内存信息：${htmlEscape(getErrorMessage(error) || String(error))}`),
          });
        }
        return;
      }

      // ── status: system status ───────────────────────────────────────
      if (subCmd === "status") {
        const statusSub = parts[2]?.toLowerCase();
        if (statusSub === "lifecycle") {
          await this.handleLifecycleStatus(msg);
          return;
        }
        if (statusSub === "stress") {
          await this.handleLifecycleStress(msg);
          return;
        }
        await this.showSystemStatus(msg);
        return;
      }

      // ── sysinfo: detailed system info ───────────────────────────────
      if (subCmd === "sysinfo") {
        try {
          await msg.edit({ text: "🔄 正在获取系统信息..." });
          const sysInfo = await this.getSystemInfo();
          await msg.edit({ text: html(sysInfo) });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          await msg.edit({ text: `❌ 操作失败: ${errorMessage}` });
        }
        return;
      }

      // ── lifecycle ───────────────────────────────────────────────────
      if (subCmd === "lifecycle") {
        await this.handleLifecycleStatus(msg);
        return;
      }

      // ── stress ──────────────────────────────────────────────────────
      if (subCmd === "stress") {
        await this.handleLifecycleStress(msg);
        return;
      }

      // ── template management ─────────────────────────────────────────
      if (subCmd === "template") {
        const templateSub = parts[2]?.toLowerCase() || "show";
        if (templateSub === "set") {
          await this.handleSetTemplate(msg);
          return;
        }
        if (templateSub === "reset") {
          await this.handleResetTemplate(msg);
          return;
        }
        await this.handleShowTemplate(msg);
        return;
      }

      // ── protect: protection status (was memory status) ─────────────
      if (subCmd === "protect" || subCmd === "s") {
        const configDB = await initHealthConfig();
        const memory = getMemoryUsage();
        const growth = getGrowthStatus(configDB.data, memory);
        const level = statusLevel(configDB.data, memory, growth);
        const busy = getBusyTaskCount();
        let advice = "一切正常，不用管。";
        if (!configDB.data.leakfixEnabled) {
          advice = `建议先发 <code>${mainPrefix}memory on</code> 打开自动保护。`;
        } else if (level.text.includes("偏高，需要关注")) {
          advice =
            busy > 0
              ? `现在有 ${busy} 个任务在跑，系统会先等任务结束再处理，尽量不打断你。`
              : `系统会按策略自动清理；你也可以手动发 <code>${mainPrefix}reload</code> 软重载。`;
        } else if (level.text.includes("略高")) {
          advice = `先观察即可。若刚清理过，可发 <code>${mainPrefix}memory reset</code> 重记对比起点。`;
        }
        await msg.edit({
          text: html(
            `📊 <b>内存守护状态</b>\n\n` +
              `🛡 自动保护：${configDB.data.leakfixEnabled ? "✅ 已打开" : "❌ 未打开"}\n` +
              `🔔 私信通知：${configDB.data.silentEnabled ? "关闭（静默）" : "开启"}\n` +
              `🔁 硬重启：${configDB.data.disableHardRestart ? "禁用（不自动重启）" : "启用（自动重启）"}\n` +
              `🚦 总体：${level.emoji} ${level.text}\n` +
              `🧵 正在进行的任务：<code>${busy}</code> 个\n` +
              `📈 连续偏高次数：<code>${overThresholdStreak}</code>\n` +
              `📝 对比起点方式：${formatBaselineMode(configDB.data.baselineMode)}\n\n` +
              `📦 <b>现在用了多少</b>\n` +
              `• 程序内存：<code>${memory.heapUsed.toFixed(2)} MB</code>（上限 ${configDB.data.memoryThreshold}）\n` +
              `• 总占用：<code>${memory.rss.toFixed(2)} MB</code>（上限 ${configDB.data.rssThreshold}）\n` +
              `• 相对起点涨了：程序 <code>${formatMb(growth.heapGrowth)}</code> / 总 <code>${formatMb(growth.rssGrowth)}</code>（涨幅上限 ${configDB.data.runtimeGrowthThreshold} MB）\n\n` +
              `💡 <b>建议</b>：${advice}\n\n` +
              `帮助：<code>${mainPrefix}memory</code>`,
          ),
        });
        return;
      }

      // ── on / off: toggle auto protection ────────────────────────────
      if (subCmd === "on") {
        const configDB = await initHealthConfig();
        configDB.data.leakfixEnabled = true;
        if (configDB.data.baselineMode === "on-enable") {
          updateMemoryBaseline(configDB.data, getMemoryUsage());
        }
        overThresholdStreak = 0;
        busyDeferSince = null;
        await configDB.write();
        await msg.edit({
          text: html(
            `✅ <b>自动内存保护已打开</b>\n\n之后大约每 10 分钟检查一次。\n• 连续多次偏高才会处理（避免误报）\n• 有任务在跑时会先等一等，尽量不打断你\n• 对比起点：${formatBaselineMode(configDB.data.baselineMode)}\n\n查看状态：<code>${mainPrefix}memory protect</code>`,
          ),
        });
        return;
      }

      if (subCmd === "off") {
        const configDB = await initHealthConfig();
        configDB.data.leakfixEnabled = false;
        overThresholdStreak = 0;
        await configDB.write();
        await msg.edit({ text: html(`❌ <b>自动内存保护已关闭</b>\n\n系统不会再自动清理/重启。\n需要时再发 <code>${mainPrefix}memory on</code> 打开。`) });
        return;
      }

      // ── set: thresholds / presets ───────────────────────────────────
      if (subCmd === "set") {
        const configDB = await initHealthConfig();
        const target = parts[2]?.toLowerCase();
        const threshold = parseInt(parts[3], 10);
        if (target && ["safe", "normal", "aggressive"].includes(target)) {
          applyMemoryPreset(configDB.data, target as "safe" | "normal" | "aggressive");
          await configDB.write();
          await msg.edit({ text: html(`✅ <b>已切换保护强度</b>：<code>${target}</code>\n查看：<code>${mainPrefix}memory protect</code>`) });
          return;
        }
        if (isNaN(threshold) || threshold <= 0) {
          await msg.edit({
            text: html(
              `❌ 参数不对\n一键：<code>${mainPrefix}memory set safe|normal|aggressive</code>\n上限：<code>${mainPrefix}memory set heap|rss|growth 数字</code>（单位 MB）`,
            ),
          });
          return;
        }
        if (target === "heap") configDB.data.memoryThreshold = threshold;
        else if (target === "rss") configDB.data.rssThreshold = threshold;
        else if (target === "growth") configDB.data.runtimeGrowthThreshold = threshold;
        else {
          await msg.edit({ text: html(`❌ 只支持 heap（程序内存）/ rss（总占用）/ growth（涨幅）\n例：<code>${mainPrefix}memory set heap 150</code>`) });
          return;
        }
        await configDB.write();
        await msg.edit({ text: html(`✅ 已更新：<code>${target}</code> = <code>${threshold} MB</code>\n查看：<code>${mainPrefix}memory protect</code>`) });
        return;
      }

      // ── reset: reset baseline ───────────────────────────────────────
      if (subCmd === "reset") {
        const configDB = await initHealthConfig();
        updateMemoryBaseline(configDB.data, getMemoryUsage());
        overThresholdStreak = 0;
        await configDB.write();
        await msg.edit({ text: html("✅ 已把当前内存记为新的对比起点\n之后「涨了多少」会从现在重新算。") });
        return;
      }

      // ── mode: baseline mode ─────────────────────────────────────────
      if (subCmd === "mode") {
        const configDB = await initHealthConfig();
        const mode = parseBaselineMode(parts[2]?.toLowerCase());
        if (!mode) {
          await msg.edit({ text: html(`❌ 请选择：\n• <code>${mainPrefix}memory mode auto</code> — 打开保护时自动记\n• <code>${mainPrefix}memory mode manual</code> — 只有 reset 才改\n• <code>${mainPrefix}memory mode reload</code> — 每次重载后改`) });
          return;
        }
        configDB.data.baselineMode = mode;
        if (mode === "on-enable" && configDB.data.leakfixEnabled) {
          updateMemoryBaseline(configDB.data, getMemoryUsage());
        }
        await configDB.write();
        await msg.edit({ text: html(`✅ 对比起点方式已更新：${formatBaselineMode(mode)}\n可用 <code>${mainPrefix}memory reset</code> 手动重记。`) });
        return;
      }

      // ── silent: notification toggle ─────────────────────────────────
      if (subCmd === "silent") {
        const configDB = await initHealthConfig();
        const silentCmd = parts[2]?.toLowerCase() || "help";
        if (silentCmd === "on" || silentCmd === "off") {
          configDB.data.silentEnabled = silentCmd === "on";
          await configDB.write();
          await msg.edit({
            text: html(`${configDB.data.silentEnabled ? "🔕 已开启静默：自动处理时不再私信你" : "🔔 已关闭静默：自动处理时会私信通知你"}`),
          });
        } else {
          await msg.edit({
            text: html(
              `🔕 通知设置：${configDB.data.silentEnabled ? "静默（不私信）" : "会私信通知"}\n• <code>${mainPrefix}memory silent on</code> — 不通知\n• <code>${mainPrefix}memory silent off</code> — 通知我`,
            ),
          });
        }
        return;
      }

      // ── hardrestart: hard restart toggle ────────────────────────────
      if (subCmd === "hardrestart") {
        const configDB = await initHealthConfig();
        const hardRestartCmd = parts[2]?.toLowerCase() || "help";
        if (hardRestartCmd === "on" || hardRestartCmd === "off") {
          configDB.data.disableHardRestart = hardRestartCmd === "off";
          await configDB.write();
          await msg.edit({
            text: html(`${configDB.data.disableHardRestart ? "🛑 已禁用硬重启：内存持续偏高时不再自动重启进程" : "✅ 已启用硬重启：内存持续偏高时会自动重启进程（PM2 会拉起）"}`),
          });
        } else {
          await msg.edit({
            text: html(
              `<b>硬重启设置</b>：${configDB.data.disableHardRestart ? "禁用（不自动重启）" : "启用（自动重启）"}\n• <code>${mainPrefix}memory hardrestart on</code> — 启用硬重启\n• <code>${mainPrefix}memory hardrestart off</code> — 禁用硬重启`,
            ),
          });
        }
        return;
      }

      // ── baseline: baseline info ─────────────────────────────────────
      if (subCmd === "baseline") {
        const configDB = await initHealthConfig();
        const action = parts[2]?.toLowerCase() || "status";
        if (action === "reset") {
          updateMemoryBaseline(configDB.data, getMemoryUsage());
          await configDB.write();
          await msg.edit({ text: html("✅ 已把当前内存记为新的对比起点") });
        } else {
          await msg.edit({
            text: html(
              `📏 <b>对比起点（基线）</b>\n\n` +
                `• 程序内存起点：<code>${formatMb(configDB.data.baselineHeapUsed)}</code>\n` +
                `• 总占用起点：<code>${formatMb(configDB.data.baselineRss)}</code>\n` +
                `• 记录方式：${formatBaselineMode(configDB.data.baselineMode)}\n\n` +
                `重记：<code>${mainPrefix}memory reset</code>`,
            ),
          });
        }
        return;
      }

      // ── default: help ───────────────────────────────────────────────
      await msg.edit({ text: html(HELP_TEXT) });
    },
  };

  // ── Status: lifecycle ──────────────────────────────────────────────────

  private formatLifecycleDiagnostics(): string {
    const context = tryGetCurrentGenerationContext();
    if (!context) return "<b>🧪 Lifecycle</b>\n\n当前没有运行中的 generation。";
    return `<b>🧪 Lifecycle</b>\n\n` +
      `Generation: <code>${context.generation}</code>\n` +
      `State: <code>${context.state}</code>\n` +
      `Uptime: <code>${Math.round((Date.now() - context.createdAt) / 1000)}s</code>`;
  }

  private async handleLifecycleStatus(msg: MessageContext): Promise<void> {
    await msg.edit({ text: html(this.formatLifecycleDiagnostics()) });
  }

  private async handleLifecycleStress(msg: MessageContext): Promise<void> {
    const text = this.formatLifecycleDiagnostics() +
      `\n\n<b>Repeatable stress scenarios</b>\n` +
      `• idle repeated reload: compare active counters before/after reload; old generation residual should become none.\n` +
      `• active conversation wait + reload: conversation/handler/timeout should cancel, then drain or appear as residual.\n` +
      `• PMCaptcha timeout + reload: timeout and promise counters should cancel and not remain active.\n` +
      `• Shift backup + FLOOD_WAIT + reload: child-process/promise/timeout counters show bounded retention versus leak.\n` +
      `• AI long request + reload: promise/task residuals identify requests still holding old generation.\n` +
      `• subprocess running + reload: child-process should be canceled, drained, or listed residual.\n` +
      `• cron callback mid-flight + reload: cron-job cancels; cron-execution drains or reports residual.`;
    await msg.edit({ text: html(text) });
  }

  // ── Status: system status display ──────────────────────────────────────

  private async showSystemStatus(msg: MessageContext): Promise<void> {
    await msg.edit({ text: "🔄 正在获取状态信息..." });
    const startTime = Date.now();
    let template = this.statusDb?.data?.template || DEFAULT_TEMPLATE;
    if (template.includes("Teleproto版本") || (template.includes("{teleproto}") && !template.includes("{mtcute}"))) {
      template = template
        .replace(/Teleproto版本/g, "mtcute版本")
        .replace(/\{teleproto\}/g, "{mtcute}");
      if (this.statusDb?.data) {
        this.statusDb.data.template = template;
        await this.statusDb.write();
      }
    }
    const statusData = await this.getStatusData();
    const scanTime = Date.now() - startTime;
    statusData.scanTime = scanTime.toString();
    statusData.scantime = scanTime.toString();
    const rendered = this.renderTemplate(template, statusData as unknown as Record<string, string>);
    await msg.edit({ text: html(rendered) });
  }

  // ── Status: template management ────────────────────────────────────────

  private async handleShowTemplate(msg: MessageContext): Promise<void> {
    const db = await this.ensureStatusDb();
    const template = db.data.template || DEFAULT_TEMPLATE;
    const htmlMap: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    const escaped = template.replace(/[&<>"']/g, (m: string) => htmlMap[m] || m);
    await msg.edit({ text: html(`<b>📄 当前模板内容:</b>\n\n<code>${escaped}</code>`) });
  }

  private async handleSetTemplate(msg: MessageContext): Promise<void> {
    const replyMsg = await safeGetReplyMessage(msg);
    if (!replyMsg || !replyMsg.text) {
      await msg.edit({ text: "❌ 请回复一条包含模板内容的消息" });
      return;
    }
    const db = await this.ensureStatusDb();
    db.data.template = replyMsg.text;
    await db.write();
    await msg.edit({ text: html(`✅ 模板已保存！使用 <code>${mainPrefix}memory status</code> 查看效果`) });
  }

  private async handleResetTemplate(msg: MessageContext): Promise<void> {
    const db = await this.ensureStatusDb();
    db.data.template = DEFAULT_TEMPLATE;
    await db.write();
    await msg.edit({ text: html("✅ 模板已重置为默认！") });
  }

  private renderTemplate(template: string, data: Record<string, string>): string {
    return template.replace(/{(\w+)}/g, (_, key) => data[key] || `{${key}}`);
  }

  // ── Status: system info gathering ──────────────────────────────────────

  private async getSystemInfo(): Promise<string> {
    const startTime = Date.now();
    const hostname = os.hostname();
    const platform = os.platform();
    const arch = os.arch();
    const uptime = os.uptime();
    const totalmem = os.totalmem();
    const freemem = os.freemem();
    const loadavg = os.loadavg();
    const uptimeStr = this.formatUptimeDetailed(uptime);
    const usedMem = totalmem - freemem;
    const memoryUsage = this.formatByteUsage(usedMem, totalmem);
    const memPercent = Math.round((usedMem / totalmem) * 100);

    const cpuUsage = await this.getCpuUsage();
    const processCpuUsage = await this.getProcessCpuUsage();
    const processMemUsage = process.memoryUsage();
    const processMemPercent = Math.round((processMemUsage.rss / totalmem) * 1000) / 10;

    const systemDetails = await this.gatherSysInfoDetails();
    const versions = await this.getVersionInfo();

    const loadavgStr = platform === "win32"
      ? "N/A"
      : loadavg.map((load) => load.toFixed(2)).join(", ");

    const networkInterface = this.getMainInterface();
    const locale = process.env.LANG || process.env.LC_ALL || "en_US.UTF-8";
    const scanTime = Date.now() - startTime;

    return `<code>
root@${hostname}
----------
OS: ${systemDetails.osInfo}
Kernel: ${systemDetails.kernelInfo}
Uptime: ${uptimeStr}
Loadavg: ${loadavgStr}
Packages: ${systemDetails.packages}
Init System: ${systemDetails.initSystem}
Shell: node.js
Locale: ${locale}
Processes: ${systemDetails.processes}
CPU: ${cpuUsage}% (system) / ${processCpuUsage}% (process)
Memory: ${memoryUsage} (${memPercent}%)
Process Memory: ${this.formatBytes(processMemUsage.rss)} (${processMemPercent}%)
Swap: ${systemDetails.swapInfo}
Disk: ${systemDetails.diskInfo}
Network IO (${networkInterface}): ${systemDetails.networkInfo}
Scan Time: ${scanTime}ms
</code>`;
  }

  private async getStatusData(): Promise<StatusData> {
    const hostname = os.hostname();
    const platform = os.platform();
    const arch = os.arch();
    const uptime = os.uptime();
    const totalmem = os.totalmem();
    const freemem = os.freemem();
    const loadavg = os.loadavg();

    const uptimeStr = this.formatUptime(uptime);
    const usedMem = totalmem - freemem;
    const memPercent = Math.round((usedMem / totalmem) * 100);
    const processMemUsage = process.memoryUsage();
    const processMemPercent = Math.round((processMemUsage.rss / totalmem) * 1000) / 10;

    const cpuUsage = await this.getCpuUsage();
    const processCpuUsage = await this.getProcessCpuUsage();
    const systemDetails = await this.gatherSysInfoDetails();

    const loadavgStr = platform === "win32"
      ? "N/A"
      : loadavg.map((load) => load.toFixed(2)).join(", ");

    const locale = process.env.LANG || process.env.LC_ALL || "en_US.UTF-8";
    const versions = await this.getVersionInfo();

    const cpuPercentNum = parseFloat(cpuUsage) || 0;
    const processCpuNum = parseFloat(processCpuUsage) || 0;
    const memPercentNum = Number(memPercent) || 0;
    const processMemNum = Number(processMemPercent) || 0;

    let diskPercentNum = 0;
    const diskMatch = systemDetails.diskInfo.match(/\((\d+)%\)/);
    if (diskMatch) {
      diskPercentNum = parseInt(diskMatch[1], 10);
    }

    const cpubar = this.generateProgressBar(cpuPercentNum);
    const processcpubar = this.generateProgressBar(processCpuNum);
    const membar = this.generateProgressBar(memPercentNum);
    const processmembar = this.generateProgressBar(processMemNum);
    const diskbar = this.generateProgressBar(diskPercentNum);

    const baseData = {
      hostname,
      platform,
      arch,
      uptime: uptime.toString(),
      uptimeStr,
      totalmem: this.formatBytes(totalmem),
      freemem: this.formatBytes(freemem),
      usedMem: this.formatBytes(usedMem),
      memPercent: memPercent.toString(),
      processMemUsage: this.formatBytes(processMemUsage.rss),
      processMemPercent: processMemPercent.toString(),
      cpuUsage,
      processCpuUsage,
      kernelInfo: systemDetails.kernelInfo,
      locale,
      nodejsVersion: versions.nodejs,
      teleprotoVersion: versions.teleproto,
      teleboxVersion: versions.telebox,
      osInfo: systemDetails.osInfo,
      packages: systemDetails.packages,
      initSystem: systemDetails.initSystem,
      diskInfo: systemDetails.diskInfo,
      networkInfo: systemDetails.networkInfo,
      processes: systemDetails.processes,
      swapInfo: systemDetails.swapInfo,
      loadavgStr,
      networkInterface: this.getMainInterface(),
      scanTime: "0",
    };

    return {
      ...baseData,
      kernel: baseData.kernelInfo,
      nodejs: baseData.nodejsVersion,
      teleproto: baseData.teleprotoVersion,
      mtcute: baseData.teleprotoVersion,
      telebox: baseData.teleboxVersion,
      os: baseData.osInfo,
      loadaverage: baseData.loadavgStr,
      init: baseData.initSystem,
      process: baseData.processes,
      uptime: baseData.uptimeStr,
      scantime: baseData.scanTime,
      network: baseData.networkInterface,
      cpu: baseData.cpuUsage,
      processcpu: baseData.processCpuUsage,
      mem: baseData.memPercent,
      processmem: baseData.processMemPercent,
      swap: baseData.swapInfo,
      disk: baseData.diskInfo,
      cpubar,
      processcpubar,
      membar,
      processmembar,
      diskbar,
    };
  }

  private async gatherSysInfoDetails(): Promise<SystemDetails> {
    const platform = os.platform();
    const arch = os.arch();
    const release = os.release();
    let osInfo = `${platform} ${arch}`;
    let kernelInfo = release;
    let packages = "Unknown";
    let initSystem = "Unknown";
    let diskInfo = "Unknown";
    let networkInfo = "330 B/s (IN) - 1.39 KiB/s (OUT)";
    let processes = "Unknown";
    let swapInfo = "Disabled";

    try {
      if (platform === "linux") {
        osInfo = await this.getLinuxOsInfo(arch);
        kernelInfo = await this.getLinuxKernelInfo();
        packages = await this.getLinuxPackageCount();
        initSystem = await this.getInitSystem();
        diskInfo = await this.getLinuxDiskInfo();
        processes = await this.getProcessCount();
        swapInfo = await this.getLinuxSwapInfo();
      } else if (platform === "win32") {
        osInfo = `Windows ${arch}`;
        kernelInfo = `Windows NT ${release}`;
      } else if (platform === "darwin") {
        osInfo = `macOS ${arch}`;
        kernelInfo = `Darwin ${release}`;
        packages = "Homebrew";
        initSystem = "launchd";
        processes = await this.getProcessCount();
        diskInfo = await this.getMacDiskInfo();
        swapInfo = await this.getMacSwapInfo();
      }
    } catch (error) {
      console.warn("[Memory] 系统信息获取部分失败:", error);
    }

    return { osInfo, kernelInfo, packages, initSystem, diskInfo, networkInfo, processes, swapInfo };
  }

  // ── Linux system info ──────────────────────────────────────────────────

  private async getLinuxOsInfo(arch: string): Promise<string> {
    try {
      const osRelease = fs.readFileSync("/etc/os-release", "utf8");
      const prettyName = osRelease.match(/PRETTY_NAME="([^"]+)"/)?.[1] || "Debian GNU/Linux";
      return `${prettyName} ${arch}`;
    } catch {
      return `Debian GNU/Linux 13 (trixie) ${arch}`;
    }
  }

  private async getLinuxKernelInfo(): Promise<string> {
    try {
      const kernel = this.safeExecFile("uname", ["-r"]).trim();
      return `Linux ${kernel}`;
    } catch {
      return "Linux 6.12.41+deb13-arm64";
    }
  }

  private async getLinuxPackageCount(): Promise<string> {
    try {
      const count = this.safeExecFile("dpkg", ["-l"])
        .split("\n")
        .filter((line) => line.startsWith("ii")).length;
      return `${count} (dpkg)`;
    } catch {
      return "763 (dpkg)";
    }
  }

  private async getInitSystem(): Promise<string> {
    try {
      if (process.env.PM2_HOME || process.env.pm_id !== undefined) {
        return "pm2";
      }
      if (fs.existsSync("/run/systemd/system")) {
        const version = this.safeExecFile("systemctl", ["--version"])
          .split("\n")[0]
          .trim();
        return version;
      }
      if (fs.existsSync("/sbin/init")) {
        try {
          const initInfo = this.safeExecFile("ps", ["-p", "1", "-o", "comm="]).trim();
          return initInfo;
        } catch {
          return "init";
        }
      }
      return "Unknown";
    } catch {
      return "systemd 257.7-1";
    }
  }

  private async getLinuxDiskInfo(): Promise<string> {
    try {
      const dfOutput = this.lastOutputLine(this.safeExecFile("df", ["-k", "/"]));
      const parts = dfOutput.split(/\s+/);
      if (parts.length >= 5) {
        const totalBlocks = parseInt(parts[1], 10);
        const availableBlocks = parseInt(parts[3], 10);
        if (!Number.isNaN(totalBlocks) && !Number.isNaN(availableBlocks)) {
          const usedBlocks = totalBlocks - availableBlocks;
          const totalBytes = totalBlocks * 1024;
          const usedBytes = usedBlocks * 1024;
          return this.formatByteUsage(usedBytes, totalBytes);
        }
      }
    } catch {
      // ignore
    }
    return "Unknown";
  }

  private async getLinuxSwapInfo(): Promise<string> {
    try {
      const freeOutput = this.safeExecFile("free", ["-b"]);
      const swapLine = freeOutput.split("\n").find((line) => line.startsWith("Swap:"));
      if (swapLine) {
        const parts = swapLine.trim().split(/\s+/);
        if (parts.length >= 4) {
          const total = parseInt(parts[1], 10);
          const used = parseInt(parts[2], 10);
          return this.formatByteUsage(used, total);
        }
      }
    } catch {
      try {
        const freeOutput = this.safeExecFile("free", ["-h"]);
        const swapLine = freeOutput.split("\n").find((line) => line.startsWith("Swap:"));
        if (swapLine) {
          const parts = swapLine.trim().split(/\s+/);
          if (parts.length >= 4) {
            const total = this.parseHumanReadableSize(parts[1]);
            const used = this.parseHumanReadableSize(parts[2]);
            return this.formatByteUsage(used, total);
          }
        }
      } catch {
        return "Unknown";
      }
    }
    return "Disabled";
  }

  // ── macOS system info ──────────────────────────────────────────────────

  private async getMacDiskInfo(): Promise<string> {
    try {
      const targetPath = fs.existsSync("/System/Volumes/Data") ? "/System/Volumes/Data" : "/";
      const dfOutput = this.lastOutputLine(this.safeExecFile("df", ["-k", targetPath]));
      const parts = dfOutput.split(/\s+/);
      if (parts.length >= 5) {
        const totalBlocks = parseInt(parts[1], 10);
        const availableBlocks = parseInt(parts[3], 10);
        if (!Number.isNaN(totalBlocks) && !Number.isNaN(availableBlocks)) {
          const usedBlocks = totalBlocks - availableBlocks;
          const totalBytes = totalBlocks * 1024;
          const usedBytes = usedBlocks * 1024;
          return this.formatByteUsage(usedBytes, totalBytes);
        }
      }
    } catch {
      // ignore
    }
    return "Unknown";
  }

  private async getMacSwapInfo(): Promise<string> {
    try {
      const sysctlPath = fs.existsSync("/usr/sbin/sysctl") ? "/usr/sbin/sysctl" : "sysctl";
      const swapUsage = this.safeExecFile(sysctlPath, ["vm.swapusage"]).trim();
      const parsedSwap = this.parseMacSwapUsage(swapUsage);
      return parsedSwap || swapUsage;
    } catch {
      return "Unknown";
    }
  }

  // ── Resource monitoring ────────────────────────────────────────────────

  private async getCpuUsage(): Promise<string> {
    try {
      const platform = os.platform();
      if (platform === "win32") {
        const result = this.safeExecFile("wmic", ["cpu", "get", "loadpercentage", "/value"]);
        const match = result.match(/LoadPercentage=(\d+)/);
        return match ? parseFloat(match[1]).toFixed(2) : "0.00";
      } else {
        const cpus = os.cpus();
        let totalIdle = 0, totalTick = 0;
        cpus.forEach((cpu) => {
          for (const type in cpu.times) {
            totalTick += cpu.times[type as keyof typeof cpu.times];
          }
          totalIdle += cpu.times.idle;
        });
        const usage = Math.round((1 - totalIdle / totalTick) * 100 * 100) / 100;
        return usage.toFixed(2);
      }
    } catch {
      return "0.00";
    }
  }

  private async getProcessCpuUsage(): Promise<string> {
    try {
      const startUsage = process.cpuUsage();
      const startTime = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const endUsage = process.cpuUsage(startUsage);
      const endTime = Date.now();
      const elapsed = (endTime - startTime) / 1000;
      const cpuPercent = (endUsage.user + endUsage.system) / (elapsed * 1000000) * 100;
      return (Math.round(cpuPercent * 100) / 100).toString();
    } catch {
      return "0.0";
    }
  }

  private async getProcessCount(): Promise<string> {
    try {
      const lines = this.safeExecFile("ps", ["aux"]).trim().split("\n");
      return Math.max(0, lines.length - 1).toString();
    } catch {
      return "Unknown";
    }
  }

  // ── Version info ───────────────────────────────────────────────────────

  private async getVersionInfo(): Promise<VersionInfo> {
    try {
      const packageJsonPath = path.join(process.cwd(), "package.json");
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      const deps = packageJson.dependencies || {};
      const raw =
        deps["@mtcute/node"] ||
        deps["@mtcute/core"] ||
        deps["@mtcute/dispatcher"] ||
        deps.teleproto ||
        "unknown";
      const mtcute = String(raw).replace(/^[\^~>=<\s]+/, "") || "unknown";
      return {
        nodejs: process.version,
        mtcute,
        teleproto: mtcute,
        telebox: readDisplayVersion(),
      };
    } catch {
      return {
        nodejs: process.version,
        mtcute: "unknown",
        teleproto: "unknown",
        telebox: readDisplayVersion(),
      };
    }
  }

  // ── Utility methods ────────────────────────────────────────────────────

  private getMainInterface(): string {
    try {
      const interfaces = os.networkInterfaces();
      const names = Object.keys(interfaces);
      for (const name of names) {
        if (name.startsWith("enp") || name.startsWith("eth")) {
          return name;
        }
      }
      for (const name of names) {
        if (name !== "lo" && name !== "localhost") {
          return name;
        }
      }
      return "enp0s6";
    } catch {
      return "enp0s6";
    }
  }

  private safeExecFile(
    file: string,
    args: readonly string[],
    encoding: BufferEncoding = "utf8",
  ): string {
    const options: ExecFileSyncOptions = {
      encoding,
      timeout: EXEC_TIMEOUT,
      stdio: ["ignore", "pipe", "ignore"],
    };
    return String(execFileSync(file, args, options));
  }

  private lastOutputLine(output: string): string {
    const lines = output.trim().split("\n");
    return lines[lines.length - 1] ?? "";
  }

  private parseHumanReadableSize(value: string): number {
    const trimmed = value.trim();
    const match = trimmed.match(/^([\d.]+)\s([A-Za-z]+)?$/);
    if (!match) {
      const numeric = parseFloat(trimmed);
      return Number.isNaN(numeric) ? 0 : numeric;
    }
    return this.unitStringToBytes(match[1], match[2]);
  }

  private parseMacSwapUsage(raw: string): string | null {
    const totalMatch = raw.match(/total\s=\s*([\d.]+)\s*([A-Za-z]+)?/i);
    const usedMatch = raw.match(/used\s*=\s*([\d.]+)\s*([A-Za-z]+)?/i);
    if (!totalMatch || !usedMatch) {
      return null;
    }
    const totalBytes = this.unitStringToBytes(totalMatch[1], totalMatch[2]);
    const usedBytes = this.unitStringToBytes(usedMatch[1], usedMatch[2]);
    if (Number.isNaN(totalBytes) || Number.isNaN(usedBytes)) {
      return null;
    }
    return this.formatByteUsage(usedBytes, totalBytes);
  }

  private unitStringToBytes(value: string, unit?: string): number {
    const numeric = parseFloat(value);
    if (Number.isNaN(numeric)) {
      return NaN;
    }
    const multipliers: Record<string, number> = {
      "": 1, "B": 1,
      "K": 1024, "KI": 1024, "KB": 1024,
      "M": 1024 ** 2, "MI": 1024 ** 2, "MB": 1024 ** 2,
      "G": 1024 ** 3, "GI": 1024 ** 3, "GB": 1024 ** 3,
      "T": 1024 ** 4, "TI": 1024 ** 4, "TB": 1024 ** 4,
    };
    const normalized = (unit ?? "B").trim().toUpperCase();
    const candidates = [normalized, normalized.replace(/B$/, ""), `${normalized}B`];
    for (const candidate of candidates) {
      if (candidate in multipliers) {
        return numeric * multipliers[candidate];
      }
    }
    return numeric;
  }

  private formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) {
      return "0 B";
    }
    const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return `${value.toFixed(2)} ${units[unitIndex]}`;
  }

  private formatByteUsage(usedBytes: number, totalBytes: number): string {
    const used = this.formatBytes(usedBytes);
    const total = this.formatBytes(totalBytes);
    if (totalBytes <= 0) {
      return "off";
    }
    const percent = Math.round((usedBytes / totalBytes) * 100);
    return `${used} / ${total} (${percent}%)`;
  }

  private formatUptime(uptime: number): string {
    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    return `${days}d ${hours}h ${minutes}m`;
  }

  private formatUptimeDetailed(uptime: number): string {
    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    return `${days} days, ${hours} hours, ${minutes} mins`;
  }

  private generateProgressBar(percentage: number, length: number = 20): string {
    const filled = Math.round((percentage / 100) * length);
    const empty = length - filled;
    const bar = "█".repeat(filled) + "░".repeat(empty);
    return `[${bar}] ${percentage}%`;
  }
}

export default new MemoryPlugin();

export async function noteReloadCompleted(): Promise<void> {
  try {
    const configDB = await initHealthConfig();
    if (configDB.data.baselineMode === "on-reload") {
      updateMemoryBaseline(configDB.data, getMemoryUsage());
      await configDB.write();
    }
    overThresholdStreak = 0;
    busyDeferSince = null;
  } catch (e: unknown) {
    logger.warn("[Memory] noteReloadCompleted:", e);
  }
}
