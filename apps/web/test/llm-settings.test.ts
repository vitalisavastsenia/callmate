import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

it('LLM settings always use authenticated backend endpoints in browser simulator mode without browser persistence', async () => {
  vi.stubEnv('VITE_MOCK', 'true');
  const status = { provider: 'openai', model: 'gpt-6.1-sol', effort: 'medium', editable: true,
    credentials: { openai: { configured: true, usable: true, source: 'stored' }, anthropic: { configured: false, usable: false, source: null } } };
  const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
  vi.stubGlobal('localStorage', storage); vi.stubGlobal('sessionStorage', storage);
  const fetchMock = vi.fn().mockImplementation(async () => Response.json(status)); vi.stubGlobal('fetch', fetchMock);
  const api = await import('../src/api');
  const update = { provider: 'openai' as const, model: status.model, effort: 'medium' as const, apiKeys: { openai: 'test-placeholder-private-key' } };
  expect(await api.getLlmSettings()).toEqual(status); expect(await api.updateLlmSettings(update)).toEqual(status);
  expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['/api/v1/settings/llm', '/api/v1/settings/llm']);
  expect(fetchMock.mock.calls.every(call => call[1].credentials === 'same-origin' && call[1].cache === 'no-store')).toBe(true);
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual(update);
  expect(storage.setItem).not.toHaveBeenCalled();
});
