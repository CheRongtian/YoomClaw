import fs from "node:fs";
import path from "node:path";
import type { Session } from "@yoomclaw/protocol";
import { ensureAgentLayout } from "./config.js";

export interface SessionRepository {
  load(): Session[];
  save(session: Session): void;
  delete(id: string): boolean;
}

/** File-per-session persistence with a one-time legacy sessions.json import. */
export class FileSessionRepository implements SessionRepository {
  private readonly sessionsDir: string;
  private readonly legacyFile: string;
  private migrated = false;

  constructor(
    dataDir: string,
    private readonly legacyWorkspace?: string,
  ) {
    this.sessionsDir = ensureAgentLayout(dataDir).sessionsDir;
    this.legacyFile = path.join(
      legacyWorkspace ?? dataDir,
      ".claw-data",
      "sessions.json",
    );
  }

  load(): Session[] {
    const sessions: Session[] = [];
    for (const entry of fs.readdirSync(this.sessionsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.sessionsDir, entry.name), "utf8"));
        const session = normalizeSession(raw as Session);
        if (session) sessions.push(session);
      } catch {
        // A single corrupt session must not prevent the Gateway from starting.
      }
    }

    if (!this.migrated) {
      this.migrated = true;
      const existing = new Set(sessions.map((session) => session.id));
      for (const legacy of this.readLegacy()) {
        if (existing.has(legacy.id)) continue;
        sessions.push(legacy);
        this.save(legacy);
      }
    }
    return sessions;
  }

  save(session: Session): void {
    const file = path.join(this.sessionsDir, `${safeId(session.id)}.json`);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(normalizeSession(session), null, 2), "utf8");
    fs.renameSync(temp, file);
  }

  delete(id: string): boolean {
    const file = path.join(this.sessionsDir, `${safeId(id)}.json`);
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    return true;
  }

  private readLegacy(): Session[] {
    if (!fs.existsSync(this.legacyFile)) return [];
    try {
      const raw = JSON.parse(fs.readFileSync(this.legacyFile, "utf8"));
      return Array.isArray(raw)
        ? raw.map((value) => normalizeSession(value as Session)).filter(Boolean) as Session[]
        : [];
    } catch (error) {
      console.error("[SessionRepository] legacy session migration failed:", error);
      return [];
    }
  }
}

function normalizeSession(input: Session): Session | null {
  if (!input || typeof input.id !== "string" || !input.id) return null;
  const messages = Array.isArray(input.messages) ? input.messages : [];
  return {
    ...input,
    schemaVersion: 2,
    providerSessionId: input.providerSessionId ?? input.id,
    messages,
    runs: Array.isArray(input.runs) ? input.runs : [],
  };
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}
