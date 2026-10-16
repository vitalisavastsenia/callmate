import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCodexModelClient, CodexModelClient, CodexModelError, createDialogue, DialogueError } from "../dist/index.js";
import { loadConversations } from "./support/conversations.mjs";

const turn = () => loadConversations().find(item => item.id === "dialogue-ambiguous-time").turns[0];
const signal = () => new AbortController().signal;
const failure = code => error => error instanceof CodexModelError && error.code === code;

async function mock(t, body = "await writeFile(output, JSON.stringify(proposal));") {
  const directory = await mkdtemp(join(tmpdir(), "callmate-cli-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "mock codex.mjs");
  const record = join(directory, "record.json");
  await writeFile(executable, `#!${process.execPath}\nimport { readFile, writeFile } from 'node:fs/promises';
const args = process.argv.slice(2);
const option = key => args[args.indexOf(key) + 1];
const output = option('--output-last-message');
let source = ''; for await (const chunk of process.stdin) source += chunk;
const proposal = ${JSON.stringify(turn().proposal)};
const schema = JSON.parse(await readFile(option('--output-schema'), 'utf8'));
const instructions = await readFile(JSON.parse(args.find(v => v.startsWith('model_instructions_file=')).split('=').slice(1).join('=')), 'utf8');
await writeFile(${JSON.stringify(record)}, JSON.stringify({args, cwd:process.cwd(), input:JSON.parse(source), env:{OPENAI_API_KEY:process.env.OPENAI_API_KEY, CODEX_API_KEY:process.env.CODEX_API_KEY, OPENAI_BASE_URL:process.env.OPENAI_BASE_URL}, schema, instructions, pid:process.pid}));
${body}\n`, { mode: 0o700 });
  return { executable, record, read: async () => JSON.parse(await readFile(record, "utf8")) };
}
async function waitForRecord(path) {
  for (let i = 0; i < 200; i++) {
    try { await access(path); return; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.fail("mock process did not start");
}

test("CLI sends validated context privately, forces ChatGPT and cleans its isolated files", async t => {
  const child = await mock(t);
  const old = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, CODEX_API_KEY: process.env.CODEX_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL };
  Object.assign(process.env, { OPENAI_API_KEY: "private-api-placeholder", CODEX_API_KEY: "private-codex-placeholder", OPENAI_BASE_URL: "https://invalid.test" });
  try {
    const { input, proposal } = turn();
    const client = createCodexModelClient({ executable: child.executable, model: "test-model" });
    assert.deepEqual(await createDialogue(client).propose(input, signal()), proposal);
    const record = await child.read();
    assert.deepEqual(record.input, input);
    assert.equal(record.env.OPENAI_API_KEY, undefined);
    assert.equal(record.env.CODEX_API_KEY, undefined);
    assert.equal(record.env.OPENAI_BASE_URL, undefined);
    for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral", 'forced_login_method="chatgpt"',
      'approval_policy="never"', 'web_search="disabled"', "shell_tool", "apps", "plugins", "hooks"]) {
      assert.ok(record.args.includes(flag), flag);
    }
    assert.equal(record.args[record.args.indexOf("--sandbox") + 1], "read-only");
    assert.equal(record.args[record.args.indexOf("--model") + 1], "test-model");
    assert.equal(record.schema.type, "object");
    assert.match(record.instructions, /Translate|translation/i);
    assert.ok(!record.args.includes(JSON.stringify(input)));
    await assert.rejects(access(record.cwd));
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("CLI rejects malformed, oversized, missing and schema-invalid answers", async t => {
  for (const body of ["await writeFile(output, '{');", "await writeFile(output, 'x'.repeat(262145));",
    "await writeFile(output, '{}');", "// no answer"]) {
    const child = await mock(t, body);
    await assert.rejects(createCodexModelClient({ executable: child.executable }).generate(turn().input, signal()), failure("invalid_response"));
    await assert.rejects(access((await child.read()).cwd));
  }
});

test("nonzero exit and missing executable expose fixed error codes without child diagnostics", async t => {
  const child = await mock(t, "console.error('private child diagnostics'); process.exit(7);");
  await assert.rejects(createCodexModelClient({ executable: child.executable }).generate(turn().input, signal()), error => {
    assert.ok(failure("cli_failed")(error));
    assert.doesNotMatch(String(error), /private child/);
    return true;
  });
  await assert.rejects(createCodexModelClient({ executable: join(tmpdir(), "callmate-missing-cli-executable") })
    .generate(turn().input, signal()), failure("cli_unavailable"));
});

test("Stop kills an uncooperative process, discards late answers and removes temporary context", async t => {
  const child = await mock(t, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
  const controller = new AbortController();
  const pending = createCodexModelClient({ executable: child.executable }).generate(turn().input, controller.signal);
  const rejected = assert.rejects(pending, failure("cancelled"));
  await waitForRecord(child.record);
  controller.abort("private abort reason");
  await rejected;
  const record = await child.read();
  await assert.rejects(access(record.cwd));
  assert.throws(() => process.kill(record.pid, 0), { code: "ESRCH" });
});

test("adapter deadline terminates pending CLI and planner keeps cancellation semantics", async t => {
  const child = await mock(t, "setInterval(() => {}, 1000);");
  await assert.rejects(createCodexModelClient({ executable: child.executable, timeoutMs: 150 })
    .generate(turn().input, signal()), failure("timeout"));
  const controller = new AbortController();
  const pending = createDialogue(createCodexModelClient({ executable: child.executable }))
    .propose(turn().input, controller.signal);
  const rejected = assert.rejects(pending, error => error instanceof DialogueError && error.code === "cancelled");
  controller.abort();
  await rejected;
});

for (const reason of ["Stop", "timeout"]) {
  test(`${reason} kills a SIGTERM-resistant descendant after the CLI parent exits`, {
    skip: process.platform === "win32",
  }, async t => {
    const child = await mock(t, `
const { spawn } = await import('node:child_process');
process.on('SIGTERM', () => process.exit(0));
spawn(process.execPath, ['--input-type=module', '-e', \`
  import { writeFileSync } from 'node:fs';
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
  writeFileSync(process.argv[1], String(process.pid));
\`, process.argv[1] + '.descendant'], { stdio: 'ignore' });
setInterval(() => {}, 1000);
`);
    const controller = new AbortController();
    const pending = createCodexModelClient({
      executable: child.executable, timeoutMs: reason === "timeout" ? 1500 : 60_000,
    }).generate(turn().input, controller.signal);
    const rejected = assert.rejects(pending, failure(reason === "Stop" ? "cancelled" : "timeout"));
    await waitForRecord(child.record);
    const record = await child.read();
    t.after(() => {
      try { process.kill(-record.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    });
    const descendantRecord = child.executable + ".descendant";
    await waitForRecord(descendantRecord);
    const descendantPid = Number(await readFile(descendantRecord, "utf8"));
    if (reason === "Stop") controller.abort();
    await rejected;
    assert.throws(() => process.kill(record.pid, 0), { code: "ESRCH" });
    await assert.rejects(access(record.cwd));
    for (let i = 0; i < 200; i++) {
      try { process.kill(descendantPid, 0); }
      catch (error) { assert.equal(error.code, "ESRCH"); return; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("descendant survived forced process group termination");
  });
}

test("concurrent turns have separate working directories and output files", async t => {
  const first = await mock(t), second = await mock(t);
  await Promise.all([first, second].map(child => createCodexModelClient({ executable: child.executable })
    .generate(turn().input, signal())));
  assert.notEqual((await first.read()).cwd, (await second.read()).cwd);
});

test("schema-valid stale answers still fail planner context validation", async t => {
  const child = await mock(t, "proposal.turnVersion++; await writeFile(output, JSON.stringify(proposal));");
  await assert.rejects(createDialogue(createCodexModelClient({ executable: child.executable }))
    .propose(turn().input, signal()), error => error instanceof DialogueError && error.code === "invalid_model_output");
});

test("construction is inert; invalid and pre-cancelled input never launches CLI", async t => {
  const child = await mock(t);
  const client = new CodexModelClient({ executable: child.executable });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.generate(turn().input, controller.signal), failure("cancelled"));
  await assert.rejects(client.generate({}, signal()));
  await assert.rejects(access(child.record));
  for (const timeoutMs of [0, 60_001, NaN]) assert.throws(() => new CodexModelClient({ timeoutMs }), RangeError);
  assert.throws(() => new CodexModelClient({ model: " " }), TypeError);
});

test("default text-only example uses CLI with no API key", async t => {
  const child = await mock(t);
  const result = await new Promise((resolve, reject) => {
    const process = execFile(globalThis.process.execPath, [new URL("../examples/codex-turn.mjs", import.meta.url).pathname],
      { env: { ...globalThis.process.env, CODEX_PATH: child.executable, OPENAI_API_KEY: "ignored-placeholder" } },
      (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
    process.stdin.end(JSON.stringify(turn().input));
  });
  assert.deepEqual(JSON.parse(result.stdout), turn().proposal);
  assert.equal(result.stderr, "");
});
