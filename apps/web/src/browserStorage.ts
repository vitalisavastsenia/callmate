// Cache only this tab's known values. A read failure never authorizes a new call:
// App locks Start and transport changes until storage is available after reload.
const cache = new Map<string, string | null>();
const listeners = new Set<() => void>();
let available = true;
function unavailable() {
  if (!available) return;
  available = false;
  queueMicrotask(() => listeners.forEach(listener => listener()));
}
export const browserStorage = {
  getItem(key: string): string | null {
    try { const value = localStorage.getItem(key); cache.set(key, value); return value; }
    catch { unavailable(); return cache.get(key) ?? null; }
  },
  setItem(key: string, value: string): boolean {
    cache.set(key, value);
    try { localStorage.setItem(key, value); return true; }
    catch { unavailable(); return false; }
  },
  removeItem(key: string): boolean {
    cache.set(key, null);
    try { localStorage.removeItem(key); return true; }
    catch { unavailable(); return false; }
  },
  available: () => available,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
