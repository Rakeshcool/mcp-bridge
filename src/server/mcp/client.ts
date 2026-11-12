import type { ToolDef, ToolResult } from "../types.ts";

export interface MCPClient {
  readonly pid: number | null;
  connect(): Promise<void>;
  listTools(): Promise<ToolDef[]>;
  callTool(name: string, args: unknown, timeoutMs: number): Promise<ToolResult>;
  close(): Promise<void>;
  onExit(cb: (info: { code: number | null; signal: string | null; expected: boolean }) => void): void;
  onToolsChanged(cb: () => void): void;
}

export interface MCPClientOptions {
  serverId: string;
  log: (level: string, message: string) => void;
  env: Record<string, string>;
  startupTimeoutMs: number;
  onExit: (info: { code: number | null; signal: string | null; expected: boolean }) => void;
  onToolsChanged: () => void;
}

export const PROTOCOL_VERSION = "2025-06-18";
export const CLIENT_INFO = { name: "llama-mcp-bridge", version: "0.1.0" };

export function initializeParams(): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  };
}

export function normalizeToolResult(result: unknown): ToolResult {
  const payload = (result ?? {}) as Record<string, unknown>;
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const entry = block as Record<string, unknown>;
    if (entry.type === "text" && typeof entry.text === "string") parts.push(entry.text);
    else if (entry.type === "image") parts.push("[image content omitted]");
    else if (entry.type === "resource") parts.push("[resource content omitted]");
    else if (typeof entry.text === "string") parts.push(entry.text);
  }
  if (!parts.length && typeof payload.result === "string") parts.push(payload.result);
  let text = parts.join("\n").trim();
  if (!text) {
    try {
      text = JSON.stringify(result ?? null);
    } catch {
      text = "(empty result)";
    }
  }
  return { text, isError: payload.isError === true };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
