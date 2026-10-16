import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";

/** Local envelope encryption. The master key lives outside SQLite and is never an API value. */
export class LlmSecrets {
  constructor(private config: Config, private hasCredentials: () => boolean) {}
  private master(create: boolean): Buffer {
    const directory = this.config.llmSecretsDir ?? join(this.config.dataDir, ".llm-secrets");
    const path = this.config.llmMasterKeyFile ?? join(directory, "master.key");
    if (create && !this.config.llmMasterKeyFile && !this.hasCredentials()) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const info = statSync(directory);
      if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))
        throw new Error("Unsafe secret directory");
      let fd: number | undefined;
      try {
        fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        writeFileSync(fd, randomBytes(32));
        fsyncSync(fd); // Persist the master key before committing any ciphertext.
        const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw new Error("Secret storage unavailable");
      } finally { if (fd !== undefined) closeSync(fd); }
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size !== 32 || (info.mode & 0o077) !== 0
        || (process.getuid && info.uid !== process.getuid())) throw new Error("Unsafe master key");
      const key = readFileSync(fd);
      if (key.length !== 32) throw new Error("Invalid master key");
      return key;
    } finally { closeSync(fd); }
  }
  encrypt(provider: string, value: string): string {
    const key = this.master(true);
    try {
      const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(`zeus-llama:llm:v1:${provider}`));
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") });
    } finally { key.fill(0); }
  }
  decrypt(provider: string, encrypted: string): string {
    const key = this.master(false);
    try {
      const value = JSON.parse(encrypted);
      if (value.v !== 1 || typeof value.iv !== "string" || typeof value.tag !== "string" || typeof value.data !== "string") throw new Error("Invalid envelope");
      const iv = Buffer.from(value.iv, "base64"), tag = Buffer.from(value.tag, "base64");
      if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid envelope");
      const cipher = createDecipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(`zeus-llama:llm:v1:${provider}`)); cipher.setAuthTag(tag);
      return Buffer.concat([cipher.update(Buffer.from(value.data, "base64")), cipher.final()]).toString("utf8");
    } finally { key.fill(0); }
  }
}
