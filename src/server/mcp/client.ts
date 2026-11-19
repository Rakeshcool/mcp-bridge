import type { ToolDef, ToolResult } from "../types.ts";

export interface MCPClient {
  readonly pid: number | null;
  /** Absolute executable actually launched for a stdio server (after PATH resolution). */
  readonly resolvedCommand?: string | null;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Keeps the metadata a server publishes so /mcp can offer the same contract as a direct connection. */
export function normalizeTool(tool: any): ToolDef {
  const def: ToolDef = {
    name: String(tool?.name ?? ""),
    description: String(tool?.description ?? ""),
    inputSchema: tool?.inputSchema ?? { type: "object", properties: {} },
  };
  if (typeof tool?.title === "string" && tool.title) def.title = tool.title;
  if (isPlainObject(tool?.outputSchema)) def.outputSchema = tool.outputSchema;
  if (isPlainObject(tool?.annotations)) def.annotations = tool.annotations;
  return def;
}

export function normalizeToolResult(result: unknown): ToolResult {
  const payload = (result ?? {}) as Record<string, unknown>;
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  const parts: string[] = [];
  const images: { mimeType: string; data: string }[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const entry = block as Record<string, unknown>;
    if (entry.type === "text" && typeof entry.text === "string") parts.push(entry.text);
    else if (entry.type === "image" && typeof entry.data === "string") {
      const mimeType = typeof entry.mimeType === "string" ? entry.mimeType : "image/png";
      images.push({ mimeType, data: entry.data });
      const kb = Math.round((entry.data.length * 3) / 4 / 1024);
      parts.push(`[image ${mimeType}, ${kb} KB]`);
    } else if (entry.type === "image") parts.push("[image content omitted]");
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
  return {
    text,
    isError: payload.isError === true,
    ...(images.length ? { images } : {}),
    ...(isPlainObject(payload.structuredContent) ? { structuredContent: payload.structuredContent } : {}),
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
