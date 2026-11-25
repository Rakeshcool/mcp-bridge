import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDir } from "./paths.ts";
import type { HttpConnection, MCPServerConfig, StdioConnection } from "./types.ts";

const FILE = path.join(DATA_DIR, "secrets.json");
let cache: Record<string, string> | null = null;

/** Names that belong in `data/secrets.json`, never in a server entry or a manifest. */
const SECRET_KEY = /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH)/i;

export function isSecretKey(name: string): boolean {
  return SECRET_KEY.test(name);
}

function load(): Record<string, string> {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    cache = parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function persist(): void {
  ensureDataDir();
  const tmp = `${FILE}.${process.pid}.tmp`;
  // 0600: the file holds bearer tokens and bot credentials in the clear, so it
  // must not be group/world readable even on a shared machine.
  fs.writeFileSync(tmp, JSON.stringify(load(), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

export function envRef(serverId: string, key: string): string {
  return `${serverId}::env::${key}`;
}

export function headerRef(serverId: string, key: string): string {
  return `${serverId}::header::${key}`;
}

export function authRef(serverId: string): string {
  return `${serverId}::auth::token`;
}

export function getSecret(ref: string): string | undefined {
  const value = load()[ref];
  return typeof value === "string" ? value : undefined;
}

export function setSecret(ref: string, value: string): void {
  load()[ref] = value;
  persist();
}

export function deleteSecret(ref: string): void {
  const map = load();
  if (ref in map) {
    delete map[ref];
    persist();
  }
}

export function deleteServerSecrets(serverId: string): void {
  const map = load();
  const prefix = `${serverId}::`;
  let changed = false;
  for (const key of Object.keys(map)) {
    if (key.startsWith(prefix)) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) persist();
}

/**
 * Moves credentials that were hand-pasted into `data/servers.json` into
 * `data/secrets.json`. Older configs stored a bot token inline in
 * `connection.env`; the panel promises that secrets never live there, so those
 * values are relocated on load and the server keeps working through `secretEnv`.
 * Returns the number of values moved.
 */
export function migrateInlineSecrets(servers: MCPServerConfig[]): number {
  let moved = 0;
  for (const server of servers) {
    if (server.transport === "stdio") {
      const conn = server.connection as StdioConnection;
      const env = conn.env ?? {};
      const secretEnv = new Set(conn.secretEnv ?? []);
      for (const [key, value] of Object.entries({ ...env })) {
        if (!isSecretKey(key) || !value) continue;
        setSecret(envRef(server.id, key), value);
        delete env[key];
        secretEnv.add(key);
        moved += 1;
      }
      conn.env = env;
      conn.secretEnv = [...secretEnv];
    } else {
      const conn = server.connection as HttpConnection;
      const headers = conn.headers ?? {};
      const secretHeaders = new Set(conn.secretHeaders ?? []);
      for (const [key, value] of Object.entries({ ...headers })) {
        if (!isSecretKey(key) || !value) continue;
        setSecret(headerRef(server.id, key), value);
        delete headers[key];
        secretHeaders.add(key);
        moved += 1;
      }
      conn.headers = headers;
      conn.secretHeaders = [...secretHeaders];
    }
  }
  return moved;
}

export function redact(input: string): string {
  const values = Object.values(load()).filter((value) => typeof value === "string" && value.length >= 4);
  let out = input;
  for (const value of values) {
    if (out.includes(value)) out = out.split(value).join("••••");
  }
  return out;
}
