import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDir } from "./paths.ts";

const FILE = path.join(DATA_DIR, "secrets.json");
let cache: Record<string, string> | null = null;

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

export function redact(input: string): string {
  const values = Object.values(load()).filter((value) => typeof value === "string" && value.length >= 4);
  let out = input;
  for (const value of values) {
    if (out.includes(value)) out = out.split(value).join("••••");
  }
  return out;
}
