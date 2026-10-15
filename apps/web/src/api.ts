import { api, ApiErrorSchema, type ApprovalDecision, type RequestDraft, type ReviewPlan, type Scenario, type Settings } from './types';
import * as mock from './mock';

const modeKey = 'zeus-llama.mode.v1';
function initialMode() {
  try { const saved = localStorage.getItem(modeKey); if (saved === 'simulator' || saved === 'live') return saved === 'simulator'; } catch { /* Use the environment default when storage is unavailable. */ }
  return import.meta.env.VITE_MOCK === 'true';
}
export let isMockMode = initialMode();
export const BACKEND_UNREACHABLE_MESSAGE = "Can't reach the Zeus backend. Check that it's running, or switch to Simulator in Settings.";
const apiBaseUrl = (import.meta.env.VITE_API_URL ?? '').trim().replace(/\/+$/, '');
const apiUrl = (path: string) => apiBaseUrl + path;
let loggedLiveBase = false;
function logLiveBase() {
  if (isMockMode || loggedLiveBase) return;
  loggedLiveBase = true;
  console.info('[Zeus API] Live API base:', apiBaseUrl || (typeof window === 'undefined' ? '' : window.location.origin) + '/api (same origin; Vite dev proxy → http://127.0.0.1:3000 in development)');
}
logLiveBase();
// Only Settings switches transports, with active and unresolved attempts locked by App.
export function setMockMode(value: boolean) {
  isMockMode = value; logLiveBase();
  try { localStorage.setItem(modeKey, value ? 'simulator' : 'live'); } catch { /* The selection still works for this session. */ }
}
type Schema<T> = { parse: (value: unknown) => T };
export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly details: { path: string; message: string }[] = []) { super(message); }
}
function logFailure(url: string, status: number | null) {
  console.error('[Zeus API] Request failed:', url, 'status:', status ?? 'unavailable (network error)');
}
const isJson = (response: Response) => response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json';
function parseBody(response: Response, text: string): unknown {
  if (response.status === 204 || !text.trim()) return null;
  if (!isJson(response)) throw new Error('Expected application/json');
  return JSON.parse(text);
}
async function httpError(response: Response, url: string): Promise<ApiError> {
  // Read even non-JSON error pages safely; never render an HTML proxy page or raw stack trace.
  const text = await response.text().catch(() => '');
  logFailure(url, response.status);
  let data: unknown = null;
  try { data = parseBody(response, text); } catch { /* A malformed error body must not hide its HTTP status. */ }
  const parsed = ApiErrorSchema.safeParse(data);
  if (parsed.success) return new ApiError(parsed.data.error.message + ` (HTTP ${response.status}).`, parsed.data.error.code, parsed.data.error.details);
  if (!isMockMode && ([502, 503, 504].includes(response.status) || (response.status === 500 && !text.trim()))) {
    return new ApiError(BACKEND_UNREACHABLE_MESSAGE + ` (HTTP ${response.status}).`, 'BACKEND_UNREACHABLE');
  }
  return new ApiError(`The Zeus backend couldn't complete this request (HTTP ${response.status}). Please try again.`, 'HTTP_ERROR');
}
async function checkedFetch(url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try { response = await fetch(url, init); }
  catch (error) {
    // Unsubscribing from SSE deliberately aborts its fetch; it is not a backend failure.
    if (init.signal?.aborted && init.signal.reason?.name === 'AbortError') throw error;
    logFailure(url, null);
    throw new ApiError(BACKEND_UNREACHABLE_MESSAGE, 'BACKEND_UNREACHABLE');
  }
  if (!response.ok) throw await httpError(response, url);
  return response;
}
async function request<T>(method: string, path: string, schema: Schema<T>, body?: unknown, commandKey?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (commandKey) headers['Idempotency-Key'] = commandKey;
  const url = apiUrl(path);
  const response = await checkedFetch(url, { method, headers, cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  let text: string;
  try { text = await response.text(); }
  catch {
    logFailure(url, response.status);
    throw new ApiError(BACKEND_UNREACHABLE_MESSAGE, 'BACKEND_UNREACHABLE');
  }
  let data: unknown;
  try { data = parseBody(response, text); }
  catch {
    logFailure(url, response.status);
    throw new ApiError(`The Zeus backend returned an invalid response (HTTP ${response.status}). Expected valid JSON. Check the API URL and try again.`, 'INVALID_RESPONSE');
  }
  try { return schema.parse(data); }
  catch {
    logFailure(url, response.status);
    // Required snapshots/settings still need the agreed schema. Empty bodies never become fake data.
    throw new ApiError(`The Zeus backend returned ${data === null ? 'an empty response' : 'unexpected data'} (HTTP ${response.status}). Please try again.`, 'INVALID_RESPONSE');
  }
}
const attemptPath = (path: string, id: string) => path.replace(':attemptId', encodeURIComponent(id));
export async function getReadiness() {
  return isMockMode ? mock.mockReadiness() : request(api.readiness.method, api.readiness.path, api.readiness.response);
}
export async function getSettings() {
  return isMockMode ? mock.mockSettings() : request(api.getSettings.method, api.getSettings.path, api.getSettings.response);
}
export async function updateSettings(value: Settings) {
  const body = api.updateSettings.request.parse(value);
  return isMockMode ? mock.mockSettings(body) : request(api.updateSettings.method, api.updateSettings.path, api.updateSettings.response, body);
}
export async function makePlan(draft: RequestDraft): Promise<ReviewPlan> {
  const body = api.createPlan.request.parse(draft);
  const result = isMockMode ? mock.mockPlan(body) : await request(api.createPlan.method, api.createPlan.path, api.createPlan.response, body);
  return api.createPlan.response.parse(result).plan;
}
export async function startCall(plan: ReviewPlan, mode: 'simulator' | 'live', commandKey: string, scenario: Scenario) {
  const body = api.startCall.request.parse({ planId: plan.id, planVersion: plan.version, mode });
  const result = isMockMode ? mock.mockStart(body, commandKey, scenario) : await request(api.startCall.method, api.startCall.path, api.startCall.response, body, commandKey);
  return api.startCall.response.parse(result).call;
}
export async function getCall(id: string) {
  const result = isMockMode ? mock.mockCall(id) : await request(api.getCall.method, attemptPath(api.getCall.path, id), api.getCall.response);
  return api.getCall.response.parse(result).call;
}
export async function stopCall(id: string) {
  const result = isMockMode ? mock.mockStop(id) : await request(api.stopCall.method, attemptPath(api.stopCall.path, id), api.stopCall.response, {});
  return api.stopCall.response.parse(result).call;
}
export async function decideApproval(id: string, decision: ApprovalDecision, commandKey: string) {
  const body = api.decideApproval.request.parse(decision);
  const result = isMockMode ? mock.mockDecision(id, body, commandKey) : await request(api.decideApproval.method, attemptPath(api.decideApproval.path, id), api.decideApproval.response, body, commandKey);
  return api.decideApproval.response.parse(result).call;
}
export async function getHistory() {
  if (isMockMode) return api.history.response.parse(mock.mockHistory());
  // The current personal history UI loads every page rather than hiding older calls.
  const items = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const page = await request(api.history.method, api.history.path + '?' + query, api.history.response);
    items.push(...page.items); cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('History pagination did not advance.');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return { items, nextCursor: null };
}
export async function deleteConversation(id: string) {
  return isMockMode ? mock.mockDelete(id) : request(api.deleteConversation.method, attemptPath(api.deleteConversation.path, id), { parse: value => value === null ? null : api.deleteConversation.response.parse(value) });
}

// SSE uses fetch so its initial cursor is sent as an actual Last-Event-ID header.
export function openCallEvents(id: string, cursor: number, signal: AbortSignal): Promise<Response> {
  return checkedFetch(apiUrl(attemptPath(api.events.path, id)), { headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(cursor) }, signal, cache: 'no-store' });
}

// Future LLM integration belongs here: replace this branch with one validated
// backend request after its endpoint is agreed. The form consumes suggestions only.
export async function parseGoal(goal: string, context: import('./types').GoalParseContext): Promise<import('./types').ParsedGoal> {
  if (!isMockMode) throw new Error('Automatic details are currently available in simulator mode only. Enter the details manually.');
  const { parseGoalRules } = await import('./goalParser');
  return parseGoalRules(goal, context);
}
