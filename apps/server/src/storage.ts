import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { SettingsSchema } from "@callmate/contracts";
import type { z } from "zod";
import { callStore } from "./call-store.js";
import { contactStore } from "./contacts.js";
import { authStore } from "./auth-store.js";

type Settings = z.infer<typeof SettingsSchema>;
const defaultMigrations = fileURLToPath(new URL("../migrations/", import.meta.url));

export function migrate(db: Database.Database, directory = defaultMigrations): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
  )`);
  const migrations = readdirSync(directory).filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort()
    .map((name) => {
      const sql = readFileSync(join(directory, name), "utf8");
      return { version: Number(name.slice(0, 3)), name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    });
  if (!migrations.length || new Set(migrations.map((item) => item.version)).size !== migrations.length) {
    throw new Error("Missing or duplicate database migrations");
  }
  db.transaction(() => {
    const applied = db.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all() as
      { version: number; name: string; checksum: string }[];
    for (const item of applied) {
      const source = migrations.find((migration) => migration.version === item.version);
      if (!source || source.name !== item.name || source.checksum !== item.checksum) {
        throw new Error("Database migration history does not match this application version");
      }
    }
    const latest = applied.at(-1)?.version ?? 0;
    for (const migration of migrations) {
      if (applied.some((item) => item.version === migration.version)) continue;
      if (migration.version <= latest) throw new Error("Database migration order is invalid");
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)")
        .run(migration.version, migration.name, migration.checksum, new Date().toISOString());
    }
  }).immediate();
}

export function openStore(dataDir: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const path = join(dataDir, "callmate.sqlite");
  const db = new Database(path);
  try {
    chmodSync(path, 0o600);
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    migrate(db);
    const getSettings = (): Settings => {
      const row = db.prepare("SELECT value FROM app_settings WHERE id = 1").get() as { value: string } | undefined;
      if (!row) throw new Error("Stored settings are missing");
      return SettingsSchema.parse(JSON.parse(row.value));
    };
    getSettings(); // Fail startup on corrupt/incompatible storage, not on the first UI request.
    return {
      calls: callStore(db),
      contacts: contactStore(db),
      auth: authStore(db),
      getSettings,
      setSettings(input: unknown): Settings {
        const settings = SettingsSchema.parse(input);
        db.prepare("UPDATE app_settings SET value = ?, updated_at = ? WHERE id = 1")
          .run(JSON.stringify(settings), new Date().toISOString());
        return settings;
      },
      check() {
        db.prepare("SELECT id FROM app_settings WHERE id = 1").get();
        db.prepare("SELECT id FROM call_attempts LIMIT 1").get();
        db.prepare("SELECT id FROM contacts LIMIT 1").get();
      },
      close() { if (db.open) db.close(); },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export type Store = ReturnType<typeof openStore>;
