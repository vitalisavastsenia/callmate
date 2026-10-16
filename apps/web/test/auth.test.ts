import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

it('uses the real auth endpoints with cookies even in browser simulator mode', async () => {
  vi.stubEnv('VITE_MOCK', 'true');
  const state = { authenticated: true, setupRequired: false, username: 'owner', expiresAt: new Date(Date.now() + 10000).toISOString() };
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(state)).mockResolvedValueOnce(Response.json(state)).mockResolvedValueOnce(Response.json({ loggedOut: true }));
  vi.stubGlobal('fetch', fetchMock);
  const api = await import('../src/api');
  expect(await api.getSession()).toEqual(state);
  await api.signIn('owner', 'test-only-password'); await api.signOut();
  expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['/api/auth/session', '/api/auth/login', '/api/auth/logout']);
  expect(fetchMock.mock.calls.every(call => call[1].credentials === 'same-origin')).toBe(true);
  expect(fetchMock.mock.calls[2]![1].body).toBe('{}');
});

it.each(['', '/callmate'])('locks private API 401 but preserves login errors with API base %s', async base => {
  vi.stubEnv('VITE_API_URL', base);
  vi.stubEnv('VITE_MOCK', 'false'); vi.spyOn(console, 'error').mockImplementation(() => {});
  const dispatchEvent = vi.fn(); vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' }, dispatchEvent });
  const failure = (code: string) => Response.json({ error: { code, message: 'Sign in required', requestId: crypto.randomUUID(), details: [] } }, { status: 401 });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(failure('UNAUTHENTICATED')).mockResolvedValueOnce(failure('INVALID_CREDENTIALS')));
  const api = await import('../src/api');
  await expect(api.getSettings()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  expect(dispatchEvent).toHaveBeenCalledOnce(); expect(dispatchEvent.mock.calls[0]![0].type).toBe('callmate:unauthorized');
  await expect(api.signIn('owner', 'wrong')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  expect(dispatchEvent).toHaveBeenCalledOnce();
});
