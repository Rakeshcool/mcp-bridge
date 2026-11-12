import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { MCPServerConfig, StdioConnection, ToolDef, ToolResult } from "../types.ts";
import { initializeParams, normalizeToolResult } from "./client.ts";
import type { MCPClient, MCPClientOptions } from "./client.ts";

const isWindows = process.platform === "win32";

/**
 * Only Windows shell scripts need cmd.exe. `.exe` and PATH-resolved commands are always
 * launched directly with an argument array so no user value is ever concatenated into a
 * shell command string.
 */
function resolveSpawn(command: string, args: string[]): { file: string; args: string[] } {
  if (isWindows && /\.(cmd|bat)$/i.test(command)) {
    return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command, ...args] };
  }
  return { file: command, args };
}

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class StdioClient implements MCPClient {
  pid: number | null = null;
  private config: MCPServerConfig;
  private opts: MCPClientOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private expectedExit = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private stderrBuffer = "";
  private startTimeout: number;

  constructor(config: MCPServerConfig, opts: MCPClientOptions) {
    this.config = config;
    this.opts = opts;
    this.startTimeout = opts.startupTimeoutMs;
  }

  onExit(cb: (info: { code: number | null; signal: string | null; expected: boolean }) => void): void {
    this.opts.onExit = cb;
  }

  onToolsChanged(cb: () => void): void {
    this.opts.onToolsChanged = cb;
  }

  async connect(): Promise<void> {
    const conn = this.config.connection as StdioConnection;
    const command = conn.command;
    if (!command) throw new Error("MCP_INVALID_CONFIG: command is required");

    const { file, args } = resolveSpawn(command, conn.args ?? []);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") env[key] = value;
    }
    for (const [key, value] of Object.entries(this.opts.env)) env[key] = value;

    this.opts.log("info", `launching: ${file} ${args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ")}`);
    if (conn.cwd) this.opts.log("info", `cwd: ${conn.cwd}`);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(file, args, {
        cwd: conn.cwd || undefined,
        env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new Error(`MCP_PROCESS_START_FAILED: ${(error as Error).message}`);
    }
    this.child = child;
    this.pid = child.pid ?? null;
    this.expectedExit = false;

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(new Error(`MCP_PROCESS_START_FAILED: ${error.message}`));
      };
      const cleanup = () => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    child.on("error", (error) => {
      this.opts.log("error", `process error: ${error.message}`);
      this.rejectAll(new Error(`MCP_PROCESS_START_FAILED: ${error.message}`));
    });
    child.on("exit", (code, signal) => {
      const expected = this.expectedExit;
      this.pid = null;
      this.child = null;
      this.clearIdle();
      this.rejectAll(new Error(`MCP_PROCESS_EXITED: process exited (code=${code ?? "null"})`));
      if (!expected) {
        this.opts.log("error", `process exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "none"})`);
      } else {
        this.opts.log("info", `process exited (code=${code ?? "null"})`);
      }
      this.opts.onExit({ code, signal, expected });
    });
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));

    await this.request("initialize", initializeParams(), this.startTimeout);
    this.notify("notifications/initialized");
    this.touchIdle();
  }

  async listTools(): Promise<ToolDef[]> {
    const result = await this.request("tools/list", {}, this.startTimeout);
    const rawTools = Array.isArray((result as any)?.tools) ? (result as any).tools : [];
    return rawTools.map((tool: any) => ({
      name: String(tool?.name ?? ""),
      description: String(tool?.description ?? ""),
      inputSchema: tool?.inputSchema ?? { type: "object", properties: {} },
    }));
  }

  async callTool(name: string, args: unknown, timeoutMs: number): Promise<ToolResult> {
    const result = await this.request("tools/call", { name, arguments: args ?? {} }, timeoutMs);
    return normalizeToolResult(result);
  }

  async close(): Promise<void> {
    this.expectedExit = true;
    this.clearIdle();
    const child = this.child;
    if (!child) return;
    const pid = child.pid ?? null;
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 1500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited) {
      try {
        child.kill();
      } catch {
        // ignore
      }
      if (isWindows && pid) {
        try {
          spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } catch {
          // ignore
        }
      } else if (!isWindows) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    this.child = null;
    this.pid = null;
  }

  private touchIdle(): void {
    this.clearIdle();
    const idle = this.config.idleTimeoutMs ?? 0;
    if (!idle || idle < 1000) return;
    this.idleTimer = setTimeout(() => {
      this.opts.log("info", `idle for ${Math.round(idle / 1000)}s, stopping process`);
      void this.close().then(() => this.opts.onExit({ code: null, signal: null, expected: true }));
    }, idle);
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private onStderr(chunk: Buffer): void {
    this.stderrBuffer += chunk.toString("utf8");
    const lines = this.stderrBuffer.split("\n");
    this.stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const text = line.trim();
      if (text) this.opts.log("stderr", text);
    }
    if (this.stderrBuffer.length > 8000) this.stderrBuffer = this.stderrBuffer.slice(-4000);
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const child = this.child;
      if (!child || !child.stdin.writable) {
        reject(new Error("MCP_CONNECTION_CLOSED: process is not running"));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP_CONNECTION_TIMEOUT: no response to ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`MCP_PROCESS_START_FAILED: ${(error as Error).message}`));
      }
      this.touchIdle();
    });
  }

  private notify(method: string, params?: unknown): void {
    const payload: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) payload.params = params;
    try {
      this.child?.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // ignore
    }
  }

  private reply(id: unknown, result: unknown): void {
    try {
      this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    } catch {
      // ignore
    }
  }

  private replyError(id: unknown, code: number, message: string): void {
    try {
      this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
    } catch {
      // ignore
    }
  }

  private rejectAll(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  /** Handles both newline-delimited JSON (what MCP stdio servers use) and Content-Length framing. */
  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    for (;;) {
      if (!this.buffer.trim()) {
        this.buffer = "";
        return;
      }
      if (/^content-length:/i.test(this.buffer)) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const header = this.buffer.slice(0, headerEnd);
        const match = /content-length:\s*(\d+)/i.exec(header);
        if (!match) {
          this.buffer = this.buffer.slice(headerEnd + 4);
          continue;
        }
        const length = Number(match[1]);
        const start = headerEnd + 4;
        if (this.buffer.length < start + length) return;
        const body = this.buffer.slice(start, start + length);
        this.buffer = this.buffer.slice(start + length);
        this.handleMessage(body);
        continue;
      }
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        if (this.buffer.length > 8_000_000) this.buffer = "";
        return;
      }
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      this.handleMessage(line);
    }
  }

  private handleMessage(raw: string): void {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      this.opts.log("stdout", raw.slice(0, 2000));
      return;
    }
    if (!message || typeof message !== "object") return;

    const hasId = message.id !== undefined && message.id !== null;
    const isResponse = hasId && (message.result !== undefined || message.error !== undefined);
    if (isResponse) {
      const numericId = Number(message.id);
      const entry = this.pending.get(numericId);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(numericId);
        if (message.error) {
          entry.reject(new Error(`MCP_PROTOCOL_ERROR: ${message.error?.message ?? JSON.stringify(message.error)}`));
        } else {
          entry.resolve(message.result);
        }
        // Long-running tool calls must not count as idleness and get the server stopped
        // out from under a request that is still in flight.
        this.touchIdle();
      }
      return;
    }

    if (hasId && typeof message.method === "string") {
      if (message.method === "ping") this.reply(message.id, {});
      else this.replyError(message.id, -32601, `Unsupported request: ${message.method}`);
      return;
    }

    if (typeof message.method === "string") {
      if (message.method === "notifications/tools/list_changed") {
        this.opts.onToolsChanged();
      } else if (message.method === "notifications/message") {
        const level = String(message.params?.level ?? "info");
        const data = message.params?.data;
        this.opts.log(level, typeof data === "string" ? data : JSON.stringify(data));
      }
    }
  }
}
