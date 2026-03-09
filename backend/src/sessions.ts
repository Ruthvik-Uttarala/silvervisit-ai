import crypto from "node:crypto";
import { SessionEvent, SessionRecord } from "./types";

const MAX_SESSIONS = 500;
const MAX_HISTORY_EVENTS = 30;
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  startCleanup(): void {
    if (this.cleanupTimer) {
      return;
    }
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 10 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  createSession(userGoal: string, sessionId?: string): SessionRecord {
    const id = sessionId ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const record: SessionRecord = {
      sessionId: id,
      userGoal,
      createdAt: now,
      lastSeenAt: now,
      history: [],
    };

    if (this.sessions.size >= MAX_SESSIONS) {
      this.evictOldestSession();
    }

    this.sessions.set(id, record);
    return record;
  }

  get(sessionId: string): SessionRecord | undefined {
    const record = this.sessions.get(sessionId);
    if (record) {
      record.lastSeenAt = new Date().toISOString();
    }
    return record;
  }

  upsertSession(sessionId: string, userGoal: string): SessionRecord {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastSeenAt = new Date().toISOString();
      if (!existing.userGoal && userGoal) {
        existing.userGoal = userGoal;
      }
      return existing;
    }
    return this.createSession(userGoal, sessionId);
  }

  appendHistory(sessionId: string, event: SessionEvent): void {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return;
    }
    record.lastSeenAt = new Date().toISOString();
    record.history.push(event);
    if (record.history.length > MAX_HISTORY_EVENTS) {
      record.history.splice(0, record.history.length - MAX_HISTORY_EVENTS);
    }
  }

  listRecentHistory(sessionId: string, limit = 5): SessionEvent[] {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return [];
    }
    return record.history.slice(Math.max(0, record.history.length - limit));
  }

  size(): number {
    return this.sessions.size;
  }

  private evictOldestSession(): void {
    let oldestId: string | null = null;
    let oldestTime = Number.POSITIVE_INFINITY;

    for (const [id, session] of this.sessions.entries()) {
      const timestamp = Date.parse(session.lastSeenAt);
      if (timestamp < oldestTime) {
        oldestTime = timestamp;
        oldestId = id;
      }
    }

    if (oldestId) {
      this.sessions.delete(oldestId);
    }
  }

  private cleanupExpired(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, session] of this.sessions.entries()) {
      const lastSeen = Date.parse(session.lastSeenAt);
      if (Number.isFinite(lastSeen) && lastSeen < cutoff) {
        this.sessions.delete(id);
      }
    }
  }
}

export const sessionStore = new SessionStore();
