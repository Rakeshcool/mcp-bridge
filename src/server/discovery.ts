import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EventEmitter } from "node:events";
import { DATA_DIR, ensureDataDir } from "./paths.ts";
import { isSecretKey } from "./secrets.ts";
import type { DiscoverySettings, MCPServerConfig, ServerApplication } from "./types.ts";
import type { Registry } from "./registry.ts";

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_MANIFESTS = 200;
const MAX_ARG_LENGTH = 4096;
const ID_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/;
const TRANSPORTS = new Set(["stdio", "streamable_http"]);
const RESCAN_MS = 15000;
const DEBOUNCE_MS = 500;

/** Per-platform default for application-generated registration manifests. */
export function defaultRegistrationDir(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "MCPBridge", "servers");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "MCPBridge", "servers");
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "MCPBridge", "servers");
}

export interface RegistrationManifest {
  schemaVersion: number;
  id: string;
  name: string;
  description?: string;
  version?: string;
  application?: ServerApplication;
  connection: Record<string, unknown>;
  capabilities?: string[];
}

interface ValidatedManifest {
  manifest: RegistrationManifest;
  transport: "stdio" | "streamable_http";
  connection: Record<string, unknown>;
  hash: string;
}

export type ValidationResult = { ok: true; value: ValidatedManifest } | { ok: false; error: string };

function hasTraversal(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment === "..");
}

function isAbsolutePath(value: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

/**
 * The approval identity: transport plus everything that decides what gets executed.
 * Descriptions, capabilities and versions are metadata and deliberately excluded, so an
 * application can refresh them without forcing the user to approve the server again.
 */
function identityHash(input: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(canonical(input)).digest("hex");
}

function stringArray(value: unknown, label: string, max: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings`);
  if (value.length > max) throw new Error(`${label} has too many entries (max ${max})`);
  return value.map((entry) => {
    if (typeof entry !== "string") throw new Error(`${label} must contain only strings`);
    if (entry.length > MAX_ARG_LENGTH) throw new Error(`${label} contains an over-long entry`);
    return entry;
  });
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Validates a registration manifest. Deliberately hand-rolled: the shape is small, the
 * bridge has no runtime dependencies, and every rejection needs a message a user can act on.
 * A manifest is never trusted because it exists in the registration directory.
 */
export function validateManifest(
  raw: unknown,
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): ValidationResult {
  const fail = (error: string): ValidationResult => ({ ok: false, error });

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("manifest must be a JSON object");
  const body = raw as Record<string, unknown>;

  if (body.schemaVersion !== 1) return fail(`unsupported schemaVersion: ${JSON.stringify(body.schemaVersion)} (expected 1)`);

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!ID_PATTERN.test(id)) return fail("id must be lowercase letters, digits, dash or underscore (max 64)");

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return fail("name is required");
  if (name.length > 100) return fail("name must be 100 characters or fewer");

  const connection = body.connection;
  if (!connection || typeof connection !== "object" || Array.isArray(connection)) return fail("connection is required");
  const conn = connection as Record<string, unknown>;

  const transport = (typeof conn.transport === "string" ? conn.transport : body.transport) ?? "stdio";
  if (typeof transport !== "string" || !TRANSPORTS.has(transport)) {
    return fail(`unsupported transport: ${JSON.stringify(transport)} (allowed: stdio, streamable_http)`);
  }

  let secretNames: string[] = [];
  const identity: Record<string, unknown> = { transport };
  const normalized: Record<string, unknown> = {};

  if (transport === "stdio") {
    const command = typeof conn.command === "string" ? conn.command.trim() : "";
    if (!command) return fail("connection.command is required for a stdio server");
    if (hasTraversal(command)) return fail("connection.command must not contain '..' segments");
    if (!isAbsolutePath(command, platform)) {
      return fail("connection.command must be an absolute path so the server cannot resolve differently per launch");
    }
    if (!isFile(command)) return fail(`connection.command does not exist or is not a file: ${command}`);

    let args: string[];
    let cwd: string | undefined;
    try {
      args = stringArray(conn.args, "connection.args", 64);
      if (conn.cwd !== undefined && conn.cwd !== null) {
        if (typeof conn.cwd !== "string" || !conn.cwd.trim()) return fail("connection.cwd must be a non-empty string");
        cwd = conn.cwd.trim();
        if (hasTraversal(cwd)) return fail("connection.cwd must not contain '..' segments");
        if (!isAbsolutePath(cwd, platform)) return fail("connection.cwd must be an absolute path");
        if (!isDirectory(cwd)) return fail(`connection.cwd does not exist: ${cwd}`);
      }
    } catch (error) {
      return fail((error as Error).message);
    }

    const env: Record<string, string> = {};
    if (conn.env !== undefined && conn.env !== null) {
      if (typeof conn.env !== "object" || Array.isArray(conn.env)) return fail("connection.env must be an object");
      const entries = Object.entries(conn.env as Record<string, unknown>);
      if (entries.length > 64) return fail("connection.env has too many entries (max 64)");
      for (const [key, value] of entries) {
        if (!key.trim()) return fail("connection.env contains an empty key");
        if (typeof value !== "string") return fail(`connection.env.${key} must be a string`);
        if (value.length > 8192) return fail(`connection.env.${key} is too long`);
        // A manifest is world-readable plain text; credentials belong in secretEnv.
        if (isSecretKey(key)) {
          return fail(
            `connection.env.${key} looks like a secret; manifests must declare the name in connection.secretEnv and store the value in the bridge`,
          );
        }
        env[key] = value;
      }
    }

    try {
      secretNames = stringArray(conn.secretEnv, "connection.secretEnv", 32);
    } catch (error) {
      return fail((error as Error).message);
    }

    normalized.command = command;
    normalized.args = args;
    if (cwd) normalized.cwd = cwd;
    normalized.env = env;
    normalized.secretEnv = [...secretNames].sort();

    identity.command = command;
    identity.args = args;
    identity.cwd = cwd ?? null;
    identity.env = env;
    identity.secretEnv = [...secretNames].sort();
  } else {
    const url = typeof conn.url === "string" ? conn.url.trim() : "";
    if (!url) return fail("connection.url is required for a streamable_http server");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return fail("connection.url must be a valid absolute URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return fail("connection.url must use http or https");
    }
    // user:pass@host would put a credential in a plain-text file and in every log line.
    if (parsed.username || parsed.password) return fail("connection.url must not embed credentials; use connection.headers instead");

    const headers: Record<string, string> = {};
    if (conn.headers !== undefined && conn.headers !== null) {
      if (typeof conn.headers !== "object" || Array.isArray(conn.headers)) return fail("connection.headers must be an object");
      for (const [key, value] of Object.entries(conn.headers as Record<string, unknown>)) {
        if (typeof value !== "string") return fail(`connection.headers.${key} must be a string`);
        if (isSecretKey(key) || isSecretKey(value)) {
          return fail(
            `connection.headers.${key} looks like a secret; manifests must declare the name in connection.secretHeaders and store the value in the bridge`,
          );
        }
        headers[key] = value;
      }
    }
    try {
      secretNames = stringArray(conn.secretHeaders, "connection.secretHeaders", 32);
    } catch (error) {
      return fail((error as Error).message);
    }

    normalized.url = parsed.toString();
    normalized.headers = headers;
    normalized.secretHeaders = [...secretNames].sort();

    identity.url = parsed.toString();
    identity.headers = headers;
    identity.secretHeaders = [...secretNames].sort();
  }

  const capabilities = stringArray(body.capabilities, "capabilities", 32);
  for (const capability of capabilities) {
    if (capability.length > 64) return fail("capabilities must be 64 characters or fewer each");
  }

  let application: ServerApplication | undefined;
  if (body.application !== undefined && body.application !== null) {
    if (typeof body.application !== "object" || Array.isArray(body.application)) return fail("application must be an object");
    const app = body.application as Record<string, unknown>;
    if (typeof app.name !== "string" || !app.name.trim()) return fail("application.name is required");
    application = { name: app.name.trim() };
    if (typeof app.version === "string" && app.version.trim()) application.version = app.version.trim().slice(0, 64);
    if (typeof app.extensionType === "string" && app.extensionType.trim()) {
      application.extensionType = app.extensionType.trim().slice(0, 32);
    }
  }

  const manifest: RegistrationManifest = {
    schemaVersion: 1,
    id,
    name,
    connection: { ...conn, transport },
    ...(typeof body.description === "string" ? { description: body.description.slice(0, 500) } : {}),
    ...(typeof body.version === "string" ? { version: body.version.slice(0, 64) } : {}),
    ...(application ? { application } : {}),
    ...(capabilities.length ? { capabilities } : {}),
  };

  return {
    ok: true,
    value: {
      manifest,
      transport: transport as "stdio" | "streamable_http",
      connection: normalized,
      // Deliberately excludes the manifest path: renaming a registration file does not change
      // what will be executed, so it must not revoke an approval.
      hash: identityHash(identity),
    },
  };
}

function buildConfig(value: ValidatedManifest, manifestPath: string, approved: boolean): MCPServerConfig {
  const manifest = value.manifest;
  const now = new Date().toISOString();
  const base: MCPServerConfig = {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description ?? "",
    enabled: true,
    visibility: "normal",
    transport: value.transport,
    connection:
      value.transport === "stdio"
        ? ({
            command: String(value.connection.command),
            args: (value.connection.args as string[]) ?? [],
            ...(value.connection.cwd ? { cwd: String(value.connection.cwd) } : {}),
            ...(Object.keys((value.connection.env as Record<string, string>) ?? {}).length
              ? { env: value.connection.env as Record<string, string> }
              : {}),
            secretEnv: (value.connection.secretEnv as string[]) ?? [],
          } as MCPServerConfig["connection"])
        : ({
            url: String(value.connection.url),
            ...(Object.keys((value.connection.headers as Record<string, string>) ?? {}).length
              ? { headers: value.connection.headers as Record<string, string> }
              : {}),
            secretHeaders: (value.connection.secretHeaders as string[]) ?? [],
            auth: null,
            verifyTls: true,
          } as MCPServerConfig["connection"]),
    startupTimeoutMs: 30000,
    toolTimeoutMs: 60000,
    idleTimeoutMs: 300000,
    restartPolicy: "on_failure",
    tools: {},
    source: "manifest",
    approved,
    manifestPath,
    manifestHash: value.hash,
    createdAt: now,
    updatedAt: now,
  };
  if (manifest.application) base.application = manifest.application;
  if (manifest.capabilities) base.capabilities = manifest.capabilities;
  return base;
}

export type DiscoveryOutcome = "registered" | "pending_approval" | "unchanged" | "updated" | "conflict" | "ignored";

export interface DiscoveryEntry {
  id: string;
  name?: string;
  manifestPath: string;
  outcome: DiscoveryOutcome | "invalid";
  error?: string;
  hash?: string;
  application?: ServerApplication | null;
  capabilities?: string[];
}

export interface DiscoveryState {
  directory: string;
  directoryAvailable: boolean;
  enabled: boolean;
  watching: boolean;
  lastScanAt: string | null;
  entries: DiscoveryEntry[];
  /** Manifest-sourced servers that are registered but still waiting for approval. */
  pending: Array<{
    id: string;
    name: string;
    manifestPath: string | null;
    application: ServerApplication | null;
    capabilities: string[];
    hash: string | null;
  }>;
  ignored: Record<string, string>;
}

interface IgnoreFile {
  version: 1;
  ignored: Record<string, string>;
}

export class DiscoveryManager {
  private registry: Registry;
  private events: EventEmitter;
  private getSettings: () => DiscoverySettings;
  private stateFile: string;
  private entries: DiscoveryEntry[] = [];
  private lastScanAt: string | null = null;
  private ignored: Record<string, string> = {};
  private loadedIgnore = false;
  private watcher: fs.FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;
  private scanning: Promise<DiscoveryState> | null = null;

  constructor(options: {
    registry: Registry;
    events: EventEmitter;
    getSettings: () => DiscoverySettings;
    stateFile?: string;
  }) {
    this.registry = options.registry;
    this.events = options.events;
    this.getSettings = options.getSettings;
    this.stateFile = options.stateFile ?? path.join(DATA_DIR, "discovery.json");
  }

  directory(): string {
    const configured = this.getSettings().directory;
    return configured && configured.trim() ? configured.trim() : defaultRegistrationDir();
  }

  start(): void {
    if (!this.getSettings().enabled) return;
    void this.scan();
    if (this.getSettings().watchRegistrationDirectory) this.watch();
  }

  stop(): void {
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // already closed
      }
      this.watcher = null;
    }
    if (this.debounce) clearTimeout(this.debounce);
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.debounce = null;
    this.rescanTimer = null;
  }

  private watch(): void {
    this.stop();
    const dir = this.directory();
    try {
      // Non-persistent: the watcher must not keep the process (or a test run) alive.
      this.watcher = fs.watch(dir, { persistent: false }, () => this.schedule());
      this.watcher.on("error", () => {
        if (this.watcher) {
          try {
            this.watcher.close();
          } catch {
            // ignore
          }
          this.watcher = null;
        }
      });
    } catch {
      // A synced/network path may refuse watchers; the rescan timer below still covers it.
      this.watcher = null;
    }
    // fs.watch misses events on OneDrive/network shares and is dropped by some editors' saves.
    this.rescanTimer = setInterval(() => this.schedule(0), RESCAN_MS);
    this.rescanTimer.unref?.();
  }

  private schedule(delay = DEBOUNCE_MS): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.scan().catch(() => undefined);
    }, delay);
    this.debounce.unref?.();
  }

  scan(): Promise<DiscoveryState> {
    if (this.scanning) return this.scanning;
    this.scanning = this.doScan().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async doScan(): Promise<DiscoveryState> {
    const settings = this.getSettings();
    if (!settings.enabled) {
      this.entries = [];
      this.lastScanAt = new Date().toISOString();
      return this.state();
    }

    this.loadIgnored();
    const dir = this.directory();
    const entries: DiscoveryEntry[] = [];
    let available = true;
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      available = fs.statSync(dir).isDirectory();
    } catch {
      available = false;
    }

    if (!available) {
      this.entries = [];
      this.lastScanAt = new Date().toISOString();
      this.emit();
      return this.state();
    }

    let files: string[] = [];
    try {
      files = fs
        .readdirSync(dir)
        .filter((name) => name.toLowerCase().endsWith(".json") && !name.startsWith("."))
        .sort()
        .slice(0, MAX_MANIFESTS);
    } catch {
      files = [];
      available = false;
    }

    const seen = new Set<string>();
    for (const file of files) {
      const manifestPath = path.join(dir, file);
      let parsed: unknown;
      try {
        const stats = fs.statSync(manifestPath);
        if (!stats.isFile()) continue;
        if (stats.size > MAX_MANIFEST_BYTES) {
          entries.push({ id: file, manifestPath, outcome: "invalid", error: "manifest is larger than 256 KB" });
          continue;
        }
        parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      } catch (error) {
        entries.push({ id: file, manifestPath, outcome: "invalid", error: `could not read manifest: ${(error as Error).message}` });
        continue;
      }

      const result = validateManifest(parsed, manifestPath);
      if (!result.ok) {
        entries.push({ id: file, manifestPath, outcome: "invalid", error: result.error });
        continue;
      }

      const value = result.value;
      const manifest = value.manifest;
      if (this.ignored[manifest.id] === value.hash) {
        entries.push({ id: manifest.id, name: manifest.name, manifestPath, outcome: "ignored", hash: value.hash });
        continue;
      }
      if (this.ignored[manifest.id] && this.ignored[manifest.id] !== value.hash) {
        // A new manifest version is a new decision: stop ignoring it.
        delete this.ignored[manifest.id];
        this.persistIgnored();
      }

      seen.add(manifest.id);
      let outcome: DiscoveryOutcome;
      try {
        outcome = await this.registry.applyDiscovery({
          manifest,
          manifestPath,
          manifestHash: value.hash,
          config: buildConfig(value, manifestPath, false),
          approvedByDefault: settings.autoRegister || !settings.requireApproval,
        });
      } catch (error) {
        entries.push({
          id: manifest.id,
          name: manifest.name,
          manifestPath,
          outcome: "invalid",
          error: (error as Error).message,
          hash: value.hash,
        });
        continue;
      }
      entries.push({
        id: manifest.id,
        name: manifest.name,
        manifestPath,
        outcome,
        hash: value.hash,
        application: manifest.application ?? null,
        capabilities: manifest.capabilities ?? [],
        ...(outcome === "conflict"
          ? {
              error:
                "a hand-configured server already uses this id; the manifest is ignored. Delete that server to let the manifest manage it.",
            }
          : {}),
      });
    }

    // Manifest-sourced servers whose file vanished: keep the record (approval is not
    // silently lost) but stop trusting that the definition is current.
    if (available) {
      for (const server of this.registry.servers) {
        if (server.source !== "manifest" || seen.has(server.id)) continue;
        if (server.manifestMissing) continue;
        this.registry.markManifestMissing(server.id);
      }
    }

    this.entries = entries;
    this.lastScanAt = new Date().toISOString();
    this.emit();
    return this.state();
  }

  state(): DiscoveryState {
    const servers = this.registry.servers.filter((server) => server.source === "manifest");
    return {
      directory: this.directory(),
      directoryAvailable: (() => {
        try {
          return fs.statSync(this.directory()).isDirectory();
        } catch {
          return false;
        }
      })(),
      enabled: this.getSettings().enabled,
      watching: this.watcher !== null,
      lastScanAt: this.lastScanAt,
      entries: this.entries.slice(),
      pending: servers
        .filter((server) => server.approved === false)
        .map((server) => ({
          id: server.id,
          name: server.name,
          manifestPath: server.manifestPath ?? null,
          application: server.application ?? null,
          capabilities: server.capabilities ?? [],
          hash: server.manifestHash ?? null,
        })),
      ignored: { ...this.ignored },
    };
  }

  async approve(id: string, connect: boolean): Promise<{ ok: boolean; error?: string }> {
    const server = this.registry.find(id);
    if (!server) return { ok: false, error: `Unknown manifest server: ${id}` };
    if (server.source !== "manifest") return { ok: false, error: `${id} is not a discovered server` };
    this.registry.setApproval(id, true);
    if (!connect) return { ok: true };
    try {
      await this.registry.connect(id);
      return { ok: true };
    } catch (error) {
      // Approval succeeded; the connect failure is already in the server's status and logs.
      return { ok: true, error: (error as Error).message };
    }
  }

  reject(id: string): { ok: boolean; error?: string } {
    const server = this.registry.find(id);
    if (!server) return { ok: false, error: `Unknown manifest server: ${id}` };
    if (server.source !== "manifest") return { ok: false, error: `${id} is not a discovered server` };
    this.registry.setApproval(id, false);
    return { ok: true };
  }

  /** Removes the record and remembers this exact hash, so the same manifest stays dismissed. */
  async forget(id: string): Promise<{ ok: boolean; error?: string }> {
    const server = this.registry.find(id);
    if (!server) return { ok: false, error: `Unknown manifest server: ${id}` };
    if (server.source !== "manifest") return { ok: false, error: `${id} is not a discovered server; delete it as a normal server` };
    if (server.manifestHash) this.ignored[id] = server.manifestHash;
    this.persistIgnored();
    await this.registry.removeServer(id);
    this.entries = this.entries.filter((entry) => entry.id !== id);
    this.emit();
    return { ok: true };
  }

  private loadIgnored(): void {
    if (this.loadedIgnore) return;
    this.loadedIgnore = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as IgnoreFile;
      if (raw && typeof raw === "object" && raw.ignored && typeof raw.ignored === "object") {
        for (const [id, hash] of Object.entries(raw.ignored)) {
          if (typeof hash === "string") this.ignored[id] = hash;
        }
      }
    } catch {
      this.ignored = {};
    }
  }

  private persistIgnored(): void {
    try {
      ensureDataDir();
      const tmp = `${this.stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, ignored: this.ignored } satisfies IgnoreFile, null, 2), "utf8");
      fs.renameSync(tmp, this.stateFile);
    } catch {
      // A read-only data dir must not break discovery.
    }
  }

  private emit(): void {
    this.events.emit("event", {
      type: "discovery",
      data: {
        directory: this.directory(),
        lastScanAt: this.lastScanAt,
        entries: this.entries.length,
        pending: this.registry.servers.filter((server) => server.source === "manifest" && server.approved === false).length,
      },
    });
  }
}
