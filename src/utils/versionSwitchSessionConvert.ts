#!/usr/bin/env node
/**
 * Session conversion for version switch (teleproto ↔ mtcute).
 *
 * Replaces the old re-login path: auth keys are converted offline via
 * @mtcute/convert (GramJS/teleproto StringSession ↔ mtcute storage).
 *
 * Always run from the mtcute repo (needs @mtcute/* + @mtcute/convert).
 *
 * Usage:
 *   SWITCH_SOURCE=teleproto SWITCH_TARGET=mtcute node scripts/run-tsx.cjs src/utils/versionSwitchSessionConvert.ts
 *   SWITCH_SOURCE=mtcute SWITCH_TARGET=teleproto node scripts/run-tsx.cjs src/utils/versionSwitchSessionConvert.ts
 *
 * Env:
 *   SWITCH_SOURCE / SWITCH_TARGET — required
 *   SWITCH_HOME — optional, default ~/.telebox-switch
 */
import fs from "fs";
import path from "path";
import os from "os";
import { TelegramClient } from "@mtcute/node";
import { convertFromGramjsSession, convertToGramjsSession } from "@mtcute/convert";
import {
  loadSwitchState,
  saveSwitchState,
  DEFAULT_SWITCH_HOME,
} from "./versionSwitchState";
import type { TeleBoxVersion } from "./versionSwitchState";
import { resolveRepoRoots } from "./versionSwitchPaths";

// Prefer env TELEBOX_TELEPROTO_ROOT / TELEBOX_MTCUTE_ROOT; else sibling dirs of cwd.
const REPO_ROOTS: Record<TeleBoxVersion, string> = resolveRepoRoots();

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function atomicWrite(file: string, content: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, mode);
}

function resolveTeleprotoStringSession(repo: string): string {
  const configPath = path.join(repo, "config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`teleproto config.json missing: ${configPath}`);
  }
  const config = readJson(configPath);
  const session = typeof config.session === "string" ? config.session.trim() : "";
  if (!session || session[0] !== "1") {
    throw new Error(
      "teleproto config.json.session is empty or not a GramJS/teleproto StringSession",
    );
  }
  return session;
}

function resolveMtcuteSessionDb(repo: string): string {
  const configPath = path.join(repo, "config.json");
  if (fs.existsSync(configPath)) {
    try {
      const config = readJson(configPath);
      const switchPath = config._switchSessionPath;
      if (typeof switchPath === "string" && switchPath && fs.existsSync(switchPath)) {
        return switchPath;
      }
    } catch {
      /* fall through */
    }
  }
  const native = path.join(repo, "session.db");
  if (!fs.existsSync(native)) {
    throw new Error(`mtcute session.db missing: ${native}`);
  }
  return native;
}

function readApiCredentials(repo: string): { apiId: number; apiHash: string } {
  const config = readJson(path.join(repo, "config.json"));
  const apiId = Number(config.api_id);
  const apiHash = String(config.api_hash || "");
  if (!apiId || !apiHash) {
    throw new Error(`api_id/api_hash missing in ${repo}/config.json`);
  }
  return { apiId, apiHash };
}

/**
 * teleproto StringSession → mtcute SQLite session file.
 * Uses @mtcute/convert.convertFromGramjsSession + client.importSession(force).
 */
async function convertTeleprotoToMtcute(
  gramjsSession: string,
  outDb: string,
  api: { apiId: number; apiHash: string },
): Promise<{ userId: string }> {
  // Fresh DB for conversion target
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(`${outDb}${suffix}`, { force: true });
    } catch {
      /* ok */
    }
  }
  fs.mkdirSync(path.dirname(outDb), { recursive: true, mode: 0o700 });

  const sessionData = convertFromGramjsSession(gramjsSession);
  const client = new TelegramClient({
    apiId: api.apiId,
    apiHash: api.apiHash,
    storage: outDb,
  });

  try {
    await client.importSession(sessionData, true);
    // self may be missing from GramJS string — leave empty; runtime will fill after connect
    let userId = "converted";
    try {
      const self = await client.storage.self.fetch();
      if (self?.userId != null) userId = String(self.userId);
    } catch {
      /* optional */
    }
    return { userId };
  } finally {
    try {
      await client.destroy();
    } catch {
      /* ok */
    }
  }
}

/**
 * mtcute SQLite session → teleproto/GramJS StringSession string.
 */
async function convertMtcuteToTeleproto(
  sessionDb: string,
  api: { apiId: number; apiHash: string },
): Promise<{ session: string; userId: string }> {
  if (!fs.existsSync(sessionDb)) {
    throw new Error(`mtcute session db not found: ${sessionDb}`);
  }

  // Work on a copy so a running mtcute process (if any) is less likely to lock us out.
  // SQLite may still be locked if PM2 holds the file — caller should stop source first
  // when needed; for convert-before-stop we copy via fs.copyFile when possible.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-sess-"));
  const tmpDb = path.join(tmpDir, "session.db");
  try {
    fs.copyFileSync(sessionDb, tmpDb);
    for (const suffix of ["-wal", "-shm"]) {
      const side = `${sessionDb}${suffix}`;
      if (fs.existsSync(side)) {
        try {
          fs.copyFileSync(side, `${tmpDb}${suffix}`);
        } catch {
          /* ignore */
        }
      }
    }

    const client = new TelegramClient({
      apiId: api.apiId,
      apiHash: api.apiHash,
      storage: tmpDb,
    });

    try {
      const mtcuteString = await client.exportSession();
      const gramjs = convertToGramjsSession(mtcuteString);
      let userId = "converted";
      try {
        const self = await client.storage.self.fetch();
        if (self?.userId != null) userId = String(self.userId);
      } catch {
        /* optional */
      }
      return { session: gramjs, userId };
    } finally {
      try {
        await client.destroy();
      } catch {
        /* ok */
      }
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  }
}

export async function convertSessionForSwitch(
  source: TeleBoxVersion,
  target: TeleBoxVersion,
  home = DEFAULT_SWITCH_HOME,
): Promise<{ path: string; userId: string }> {
  if (source === target) {
    throw new Error(`source and target are the same: ${source}`);
  }

  const sessionDir = path.join(home, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

  if (source === "teleproto" && target === "mtcute") {
    const gramjs = resolveTeleprotoStringSession(REPO_ROOTS.teleproto);
    const api = readApiCredentials(REPO_ROOTS.teleproto);
    const outDb = path.join(sessionDir, "mtcute.db");
    console.error(`[session-convert] teleproto StringSession → ${outDb}`);
    const { userId } = await convertTeleprotoToMtcute(gramjs, outDb, api);
    console.error(`[session-convert] ✅ mtcute session written (userId=${userId})`);
    return { path: outDb, userId };
  }

  if (source === "mtcute" && target === "teleproto") {
    const sessionDb = resolveMtcuteSessionDb(REPO_ROOTS.mtcute);
    const api = readApiCredentials(REPO_ROOTS.mtcute);
    const outFile = path.join(sessionDir, "teleproto.session");
    console.error(`[session-convert] mtcute ${sessionDb} → ${outFile}`);
    const { session, userId } = await convertMtcuteToTeleproto(sessionDb, api);
    atomicWrite(outFile, session, 0o600);
    console.error(`[session-convert] ✅ teleproto StringSession written (userId=${userId})`);
    return { path: outFile, userId };
  }

  throw new Error(`Unsupported conversion ${source} → ${target}`);
}

async function main(): Promise<void> {
  const source = process.env.SWITCH_SOURCE as TeleBoxVersion | undefined;
  const target = process.env.SWITCH_TARGET as TeleBoxVersion | undefined;
  const home = process.env.SWITCH_HOME || DEFAULT_SWITCH_HOME;

  if (!source || !target) {
    throw new Error("SWITCH_SOURCE and SWITCH_TARGET are required");
  }
  if (source !== "teleproto" && source !== "mtcute") {
    throw new Error(`Invalid SWITCH_SOURCE: ${source}`);
  }
  if (target !== "teleproto" && target !== "mtcute") {
    throw new Error(`Invalid SWITCH_TARGET: ${target}`);
  }

  const result = await convertSessionForSwitch(source, target, home);

  const state = loadSwitchState(home);
  state.sessions[target] = {
    kind: "external",
    path: result.path,
    userId: result.userId,
  };
  state.pendingLogin = null;
  state.stagedSecrets = {};
  saveSwitchState(state, home);
  console.error(
    `[session-convert] state.sessions.${target} = external (${result.path})`,
  );
}

if (require.main === module) {
  main().catch((err: Error) => {
    console.error("[session-convert] Fatal:", err.message);
    process.exit(1);
  });
}
