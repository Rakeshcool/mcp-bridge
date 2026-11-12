export interface LogEntry {
  ts: string;
  level: string;
  message: string;
}

let redactor: (input: string) => string = (input) => input;

export function setLogRedactor(fn: (input: string) => string): void {
  redactor = fn;
}

const MAX_MESSAGE = 4000;

export class LogBuffer {
  limit: number;
  private items: LogEntry[];

  constructor(limit = 200) {
    this.limit = limit;
    this.items = [];
  }

  push(level: string, message: string): void {
    let text: string;
    try {
      text = redactor(String(message ?? ""));
    } catch {
      text = String(message ?? "");
    }
    if (text.length > MAX_MESSAGE) text = text.slice(0, MAX_MESSAGE) + "…";
    this.items.push({ ts: new Date().toISOString(), level, message: text });
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
  }

  list(): LogEntry[] {
    return this.items.slice();
  }

  clear(): void {
    this.items = [];
  }
}
