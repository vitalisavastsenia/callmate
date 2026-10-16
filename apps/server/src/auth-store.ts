import type Database from "better-sqlite3";

export type Owner = { username: string; password_hash: string; salt: string };
export function authStore(db: Database.Database) {
  return {
    owner: () => db.prepare("SELECT username, password_hash, salt FROM auth_owner WHERE id = 1").get() as Owner | undefined,
    createOwner(owner: Owner): boolean {
      return db.prepare("INSERT OR IGNORE INTO auth_owner (id, username, password_hash, salt) VALUES (1, ?, ?, ?)")
        .run(owner.username, owner.password_hash, owner.salt).changes === 1;
    },
    addSession(hash: string, expiresAt: number, owner: Owner): boolean {
      // A local account reset must invalidate logins already hashing in another request.
      return db.transaction(() => {
        if (!db.prepare("SELECT id FROM auth_owner WHERE id = 1 AND username = ? AND password_hash = ? AND salt = ?")
          .get(owner.username, owner.password_hash, owner.salt)) return false;
        db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(Date.now());
        db.prepare("INSERT INTO auth_sessions (token_hash, expires_at) VALUES (?, ?)").run(hash, expiresAt);
        return true;
      }).immediate();
    },
    session(hash: string): number | undefined {
      return (db.prepare("SELECT expires_at FROM auth_sessions WHERE token_hash = ?").get(hash) as { expires_at: number } | undefined)?.expires_at;
    },
    removeSession(hash: string) { db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(hash); },
    // One persistent limit for this single-owner app. IP headers are never trusted.
    consumeAttempt(now: number): boolean {
      return db.transaction(() => {
        const row = db.prepare("SELECT window_start, attempts FROM auth_rate_limit WHERE id = 1").get() as
          { window_start: number; attempts: number } | undefined;
        if (!row || now - row.window_start >= 300_000) {
          db.prepare("INSERT OR REPLACE INTO auth_rate_limit (id, window_start, attempts) VALUES (1, ?, 1)").run(now);
          return true;
        }
        if (row.attempts >= 10) return false;
        db.prepare("UPDATE auth_rate_limit SET attempts = attempts + 1 WHERE id = 1").run();
        return true;
      }).immediate();
    },
    resetOwner() {
      db.transaction(() => {
        db.prepare("DELETE FROM auth_sessions").run();
        db.prepare("DELETE FROM auth_owner").run();
        db.prepare("DELETE FROM auth_rate_limit").run();
      }).immediate();
    },
  };
}
