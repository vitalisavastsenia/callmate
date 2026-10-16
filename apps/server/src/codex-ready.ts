import { execFile } from "node:child_process";

/** Local credential/executable check only. Never return CLI output or start a model request. */
export function codexLoginReady(): Promise<boolean> {
  return new Promise(resolve => {
    execFile("codex", ["login", "status"], { timeout: 2500, maxBuffer: 8192, env: {
      PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME,
    } }, (error, stdout, stderr) => resolve(!error && /ChatGPT/i.test(stdout + stderr)));
  });
}
