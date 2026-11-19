import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";

export interface StoredImage {
  mimeType: string;
  /** The data URL the panel renders and saves; already base64 with its prefix. */
  dataUrl: string;
}

export interface ToolCallRecord {
  name: string;
  serverId: string;
  toolName: string;
  args: string;
  permission: string;
  status: "ok" | "error" | "denied" | "skipped";
  durationMs: number;
  result: string;
  images?: StoredImage[];
}

export interface RoundRecord {
  index: number;
  finishReason: string;
  toolCalls: ToolCallRecord[];
  assistantChars: number;
}

export interface ActivityRecord {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  model: string;
  stream: boolean;
  rounds: RoundRecord[];
  injectedTools: number;
  finalChars: number;
  error: string | null;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export class ActivityStore {
  private events: EventEmitter;
  private limit: number;
  private items: ActivityRecord[] = [];

  constructor(events: EventEmitter, limit = 100) {
    this.events = events;
    this.limit = limit;
  }

  create(options: { model: string; stream: boolean; injectedTools: number }): ActivityRecord {
    const record: ActivityRecord = {
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: 0,
      model: options.model,
      stream: options.stream,
      rounds: [],
      injectedTools: options.injectedTools,
      finalChars: 0,
      error: null,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    this.items.unshift(record);
    if (this.items.length > this.limit) this.items.length = this.limit;
    // Tool images are megabytes of base64, so only the newest record keeps them. The
    // panel copies them into its own message list as soon as its run finishes, which is
    // the only reader; older runs stay readable as text.
    for (const item of this.items.slice(1)) {
      for (const round of item.rounds) {
        for (const call of round.toolCalls) call.images = undefined;
      }
    }
    return record;
  }

  finish(record: ActivityRecord, error?: string): void {
    record.finishedAt = new Date().toISOString();
    record.durationMs = Date.now() - new Date(record.startedAt).getTime();
    record.error = error ?? null;
    this.events.emit("event", { type: "activity", data: record });
  }

  list(): ActivityRecord[] {
    return this.items.slice();
  }

  get(id: string): ActivityRecord | undefined {
    return this.items.find((item) => item.id === id);
  }
}
