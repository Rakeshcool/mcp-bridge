import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
  payload: Record<string, unknown>;
  createdAt: string;
}

export class ApprovalService {
  private events: EventEmitter;
  private timeoutMs: number;
  private pending = new Map<string, PendingApproval>();

  constructor(events: EventEmitter, timeoutMs = 60000) {
    this.events = events;
    this.timeoutMs = timeoutMs;
  }

  request(payload: Record<string, unknown>): Promise<boolean> {
    const id = randomUUID();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.events.emit("event", { type: "approval_resolved", data: { id, approved: false, reason: "timeout" } });
        resolve(false);
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer, payload, createdAt: new Date().toISOString() });
      this.events.emit("event", { type: "approval_requested", data: { id, timeoutMs: this.timeoutMs, ...payload } });
    });
  }

  resolve(id: string, approved: boolean): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    this.events.emit("event", { type: "approval_resolved", data: { id, approved } });
    entry.resolve(approved);
    return true;
  }

  list(): Array<Record<string, unknown>> {
    return [...this.pending.entries()].map(([id, entry]) => ({ id, createdAt: entry.createdAt, ...entry.payload }));
  }
}
