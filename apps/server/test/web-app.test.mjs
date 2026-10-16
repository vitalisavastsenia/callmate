import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { mountWebApp } from '../dist/web-app.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'zeus-llama-ui-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><head><title>Zeus Llama</title></head><body><script src="/assets/app-123.js"></script></body></html>');
  writeFileSync(join(root, 'assets', 'app-123.js'), 'console.log("Zeus Llama");');
  writeFileSync(join(root, 'assets', 'app-123.css'), 'body { color: gold; }');
  writeFileSync(join(root, 'assets', '.env'), 'PRIVATE_FIXTURE_VALUE');
  writeFileSync(join(root, 'private.txt'), 'PRIVATE_FIXTURE_VALUE');
  const app = Fastify();
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
  mountWebApp(app, root);
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  return app;
}

test('the same listener serves fresh HTML and cacheable bundled assets with correct content types', async t => {
  const app = fixture(t);
  const html = await app.inject('/');
  assert.equal(html.statusCode, 200); assert.match(html.headers['content-type'], /text\/html/);
  assert.equal(html.headers['cache-control'], 'no-store');
  assert.match(html.headers['content-security-policy'], /script-src 'self'/);
  assert.match(html.body, /Zeus Llama/);
  for (const [path, type] of [['/assets/app-123.js', /javascript/], ['/assets/app-123.css', /text\/css/]]) {
    const asset = await app.inject(path);
    assert.equal(asset.statusCode, 200); assert.match(asset.headers['content-type'], type);
    assert.match(asset.headers['cache-control'], /max-age=31536000, immutable/);
  }
  const head = await app.inject({ method: 'HEAD', url: '/assets/app-123.js' });
  assert.equal(head.statusCode, 200); assert.equal(head.body, '');
});

test('missing assets and API paths stay errors; private and traversal paths never return files', async t => {
  const app = fixture(t);
  for (const path of ['/assets/missing.js', '/api/v1/missing', '/src/main.tsx', '/node_modules/fastify/package.json',
    '/private.txt', '/assets/.env', '/assets/%2e%2e/private.txt']) {
    const response = await app.inject(path);
    assert.ok(response.statusCode >= 400, path);
    assert.ok(!response.body.includes('PRIVATE_FIXTURE_VALUE'), path);
    assert.ok(!response.body.includes('<!doctype html>'), path);
  }
});
