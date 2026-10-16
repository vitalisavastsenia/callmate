import { browserStorage } from './browserStorage';
export const activeKey = 'zeus-llama.active-attempt.v1';
export const pendingKey = 'zeus-llama.pending-start.v1';
type Transport = 'browser' | 'backend';
export function readActiveAttempt(): { id: string; transport?: Transport } | null {
  const saved = browserStorage.getItem(activeKey);
  if (!saved) return null;
  // Earlier versions stored only an ID; retain it for recovery in the saved mode.
  if (!saved.startsWith('{')) return { id: saved };
  const value = JSON.parse(saved);
  if (typeof value.id !== 'string' || !['browser', 'backend'].includes(value.transport)) throw new Error('Invalid saved call. Keep this browser data and resolve the original attempt before starting again.');
  return value;
}
export function savedAttemptTransport(): Transport | undefined {
  const pending = browserStorage.getItem(pendingKey);
  if (pending) {
    const value = JSON.parse(pending);
    if (value.transport === 'browser' || value.transport === 'backend') return value.transport;
  }
  return readActiveAttempt()?.transport;
}
