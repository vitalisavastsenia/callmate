import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmedCallFixture, connectedCallFixture, reviewPlanFixture, transcriptEventFixture } from '@callmate/contracts/fixtures';
import { parseFrame } from '../src/ws';

beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); vi.resetModules(); });
describe('HTTP and SSE boundary', () => {
  it('recognizes manual mock history snapshots without treating them as booking plans', async () => {
    vi.stubEnv('VITE_MOCK', 'false');
    const manual = { ...connectedCallFixture, kind: 'manual_mock', mode: 'simulator', plan: null,
      language: 'ru-RU', activeOffer: null, pendingApproval: null, bookingState: 'pending',
      outcome: { status: 'pending' }, messages: [] };
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({ call: manual })));
    const api = await import('../src/api');
    await expect(api.getCall(manual.id)).rejects.toMatchObject({ code: 'UNSUPPORTED_CALL_KIND', message: expect.stringContaining('backend console') });
    await expect(api.stopCall(manual.id)).rejects.toMatchObject({ code: 'UNSUPPORTED_CALL_KIND' });
  });
  it('sends tone, notes, and an optional contact reference in the validated plan request', async () => {
    vi.stubEnv('VITE_MOCK', 'false');
    const draft = { ...reviewPlanFixture.request, tone: ['Very polite'], tone_notes: 'Be patient.', contact_id: crypto.randomUUID() };
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ plan: { ...reviewPlanFixture, request: draft } }));
    vi.stubGlobal('fetch', fetchMock);
    const api = await import('../src/api');
    expect((await api.makePlan(draft)).request).toEqual(draft);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual(draft);
  });
  it('uses shared endpoints and idempotency keys, validates snapshots, and parses structured errors', async () => {
    vi.stubEnv('VITE_MOCK', 'false');
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ plan: reviewPlanFixture }))
      .mockResolvedValueOnce(Response.json({ call: connectedCallFixture }))
      .mockResolvedValueOnce(Response.json({ call: { malformed: true } }))
      .mockResolvedValueOnce(Response.json({ error: { code: 'APPROVAL_STALE', message: 'Offer changed.', requestId: crypto.randomUUID(), details: [] } }, { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = await import('../src/api');
    expect(await api.makePlan(reviewPlanFixture.request)).toEqual(reviewPlanFixture);
    await api.startCall(reviewPlanFixture, 'simulator', 'command-key', 'within_plan');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/plans');
    expect(fetchMock.mock.calls[1]![1].headers['Idempotency-Key']).toBe('command-key');
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({ planId: reviewPlanFixture.id, planVersion: 1, mode: 'simulator' });
    await expect(api.getCall('bad')).rejects.toThrow();
    await expect(api.stopCall('attempt')).rejects.toMatchObject({ code: 'APPROVAL_STALE' });
  });
  it('parses comments, multiple data lines, and an initial zero cursor', async () => {
    expect(parseFrame(': heartbeat')).toEqual({ type: 'message', data: '', id: undefined });
    expect(parseFrame('event: callmate\nid: 1\ndata: first\ndata: second')).toEqual({ type: 'callmate', id: '1', data: 'first\nsecond' });
    vi.stubEnv('VITE_MOCK', 'false'); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('')));
    const api = await import('../src/api'); await api.openCallEvents('attempt', 0, new AbortController().signal);
    expect(vi.mocked(fetch).mock.calls[0]![1]?.headers).toMatchObject({ 'Last-Event-ID': '0' });
  });
  it('recovers a gap by snapshot without starting another call', async () => {
    vi.useFakeTimers(); vi.stubEnv('VITE_MOCK', 'false');
    const start = { ...connectedCallFixture, lastEventSequence: 0 };
    const event = { ...transcriptEventFixture, sequence: 2 };
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('event: callmate\nid: 2\ndata: ' + JSON.stringify(event) + '\n\n')); controller.close();
    } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ call: start }))
      .mockResolvedValueOnce(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }))
      .mockResolvedValueOnce(Response.json({ call: confirmedCallFixture }));
    vi.stubGlobal('fetch', fetchMock);
    const { subscribeToCall } = await import('../src/ws'); const onSnapshot = vi.fn(); const onError = vi.fn();
    const close = subscribeToCall(start.id, { onSnapshot, onError, onConnection: vi.fn() });
    await vi.advanceTimersByTimeAsync(1100);
    expect(onError).toHaveBeenCalled(); expect(onSnapshot).toHaveBeenLastCalledWith(confirmedCallFixture);
    expect(fetchMock.mock.calls.every(([, init]) => !init || init.method === 'GET' || init.method === undefined)).toBe(true);
    close(); expect(vi.getTimerCount()).toBe(0);
  });
});


describe('robust backend responses', () => {
  it.each([
    [204, null, {}], [200, '', { 'Content-Type': 'application/json' }], [200, '  \n ', {}],
  ] as const)('returns null for an empty deletion acknowledgement (%s) and validates required data', async (status, body, headers) => {
    vi.stubEnv('VITE_MOCK', 'false');
    const response = () => new Response(body, { status, headers });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response()));
    const api = await import('../src/api');
    expect(await api.deleteConversation('attempt')).toBeNull();
    await expect(api.getReadiness()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', message: expect.stringContaining(`empty response (HTTP ${status})`) });
  });
  it.each([
    ['text/html', '<html>Not an API</html>'], ['text/plain', '{"ready":true}'],
    ['application/json', '{"ready":'], ['application/json', 'null'],
  ])('rejects %s / %s without exposing JSON parser errors or treating it as readiness', async (contentType, body) => {
    vi.stubEnv('VITE_MOCK', 'false');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': contentType! } })));
    const api = await import('../src/api');
    await expect(api.getReadiness()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', message: expect.stringContaining('HTTP 200') });
    expect(console.error).toHaveBeenCalledWith('[Zeus API] Request failed:', '/api/v1/readiness', 'status:', 200);
  });
  it.each([
    [404, '<html>Not found</html>', 'text/html', 'HTTP_ERROR'],
    [400, '{broken', 'application/json', 'HTTP_ERROR'],
    [500, '', 'text/plain', 'BACKEND_UNREACHABLE'],
    [502, '<html>Bad gateway</html>', 'text/html', 'BACKEND_UNREACHABLE'],
    [503, 'Service unavailable', 'text/plain', 'BACKEND_UNREACHABLE'],
    [504, '', 'application/json', 'BACKEND_UNREACHABLE'],
  ])('reads errors as text and preserves HTTP %s with %s', async (status, body, contentType, code) => {
    vi.stubEnv('VITE_MOCK', 'false');
    const response = new Response(body, { status: Number(status), headers: { 'Content-Type': String(contentType) } });
    const text = vi.spyOn(response, 'text'); const json = vi.spyOn(response, 'json');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const api = await import('../src/api');
    await expect(api.getSettings()).rejects.toMatchObject({ code, message: expect.stringContaining(`HTTP ${status}`) });
    expect(text).toHaveBeenCalledOnce(); expect(json).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('[Zeus API] Request failed:', '/api/v1/settings', 'status:', status);
  });
  it('preserves a structured error code and details, with its status', async () => {
    vi.stubEnv('VITE_MOCK', 'false');
    const details = [{ path: 'offer', message: 'Review the newer offer.' }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { code: 'APPROVAL_STALE', message: 'Offer changed.', requestId: crypto.randomUUID(), details } }, { status: 409 })));
    const api = await import('../src/api');
    await expect(api.stopCall('attempt')).rejects.toMatchObject({ code: 'APPROVAL_STALE', details, message: 'Offer changed. (HTTP 409).' });
  });
  it('accepts application/json with charset and case variations', async () => {
    vi.stubEnv('VITE_MOCK', 'false');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ mode: 'live', ready: false, voiceEngine: null, capabilities: [], checks: [] }), { headers: { 'Content-Type': 'Application/JSON; charset=utf-8' } })));
    const api = await import('../src/api');
    expect(await api.getReadiness()).toMatchObject({ ready: false });
  });
  it.each([new TypeError('Failed to fetch'), new DOMException('Timed out', 'TimeoutError')])('normalizes network and timeout errors: %s', async error => {
    vi.stubEnv('VITE_MOCK', 'false'); vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
    const api = await import('../src/api');
    await expect(api.getReadiness()).rejects.toMatchObject({ code: 'BACKEND_UNREACHABLE', message: api.BACKEND_UNREACHABLE_MESSAGE });
    expect(console.error).toHaveBeenCalledWith('[Zeus API] Request failed:', '/api/v1/readiness', 'status:', 'unavailable (network error)');
  });
  it('handles a connection lost while reading a successful response', async () => {
    vi.stubEnv('VITE_MOCK', 'false');
    const stream = new ReadableStream({ start(controller) { controller.error(new TypeError('Connection lost')); } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { headers: { 'Content-Type': 'application/json' } })));
    const api = await import('../src/api');
    await expect(api.getReadiness()).rejects.toMatchObject({ code: 'BACKEND_UNREACHABLE', message: api.BACKEND_UNREACHABLE_MESSAGE });
    expect(console.error).toHaveBeenCalledWith('[Zeus API] Request failed:', '/api/v1/readiness', 'status:', 200);
  });
  it('uses VITE_API_URL for REST and SSE, keeps route paths, and logs the base only once', async () => {
    vi.stubEnv('VITE_MOCK', 'false'); vi.stubEnv('VITE_API_URL', 'https://backend.example/zeus/');
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ call: connectedCallFixture })).mockResolvedValueOnce(new Response(': heartbeat\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    const api = await import('../src/api');
    await api.getCall('attempt'); await api.openCallEvents('attempt', 12, new AbortController().signal);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://backend.example/zeus/api/v1/calls/attempt', 'https://backend.example/zeus/api/v1/calls/attempt/events']);
    expect(fetchMock.mock.calls[1]![1].headers['Last-Event-ID']).toBe('12');
    api.setMockMode(true); api.setMockMode(false);
    expect(console.info).toHaveBeenCalledOnce();
    expect(console.info).toHaveBeenCalledWith('[Zeus API] Live API base:', 'https://backend.example/zeus');
  });
  it('logs the proxy base on the first switch to Live, without requesting anything in Simulator', async () => {
    vi.stubEnv('VITE_MOCK', 'true'); vi.stubEnv('VITE_API_URL', '');
    vi.stubGlobal('fetch', vi.fn()); const api = await import('../src/api');
    expect(console.info).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    api.setMockMode(false); api.setMockMode(true); api.setMockMode(false);
    expect(console.info).toHaveBeenCalledOnce();
    expect(vi.mocked(console.info).mock.calls[0]![1]).toContain('Vite dev proxy');
  });
  it('handles SSE HTTP errors without parsing the successful event stream as JSON', async () => {
    vi.stubEnv('VITE_MOCK', 'false');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    const api = await import('../src/api');
    await expect(api.openCallEvents('attempt', 0, new AbortController().signal)).rejects.toMatchObject({ code: 'BACKEND_UNREACHABLE', message: expect.stringContaining('HTTP 503') });
    expect(console.error).toHaveBeenCalledWith('[Zeus API] Request failed:', '/api/v1/calls/attempt/events', 'status:', 503);
  });
  it('does not report an intentional SSE unsubscribe as an unreachable backend', async () => {
    vi.stubEnv('VITE_MOCK', 'false'); const controller = new AbortController(); controller.abort();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(controller.signal.reason));
    const api = await import('../src/api');
    await expect(api.openCallEvents('attempt', 0, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(console.error).not.toHaveBeenCalled();
  });
});
