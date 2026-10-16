import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

it('call engine settings always use the authenticated backend even in browser Simulator mode', async () => {
  vi.stubEnv('VITE_MOCK', 'true');
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ engine: 'mock', editable: true }))
    .mockResolvedValueOnce(Response.json({ engine: 'twilio', editable: true }));
  vi.stubGlobal('fetch', fetchMock);
  const api = await import('../src/api');
  expect(await api.getCallEngine()).toEqual({ engine: 'mock', editable: true });
  expect(await api.updateCallEngine('twilio')).toEqual({ engine: 'twilio', editable: true });
  expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['/api/v1/settings/call-engine', '/api/v1/settings/call-engine']);
  expect(fetchMock.mock.calls.every(call => call[1].credentials === 'same-origin' && call[1].cache === 'no-store')).toBe(true);
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({ engine: 'twilio' });
});
