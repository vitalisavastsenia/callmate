export interface ContactMemory { name: string; phone: string; email: string }
const key = 'zeus-llama.last-contact.v1';
const empty: ContactMemory = { name: '', phone: '', email: '' };
export function readContactMemory(): ContactMemory {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!value || typeof value !== 'object') return { ...empty };
    const data = value as Record<string, unknown>;
    return { name: typeof data.name === 'string' ? data.name.slice(0, 200) : '', phone: typeof data.phone === 'string' ? data.phone.slice(0, 30) : '', email: typeof data.email === 'string' ? data.email.slice(0, 320) : '' };
  } catch { return { ...empty }; }
}
export function saveContactMemory(value: ContactMemory) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Keep the editable form usable when browser storage is unavailable. */ }
}
