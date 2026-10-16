import { readContactMemory, saveContactMemory, type ContactMemory } from './contactMemory';
import { TimeZoneSchema } from './types';
export interface RequestDefaults extends ContactMemory { timeZone: string }
const zoneKey = 'zeus-llama.default-timezone.v1';
export function readRequestDefaults(): RequestDefaults {
  let timeZone = 'Europe/Madrid';
  try { const saved = localStorage.getItem(zoneKey); if (TimeZoneSchema.safeParse(saved).success) timeZone = saved!; } catch { /* Storage is optional. */ }
  return { ...readContactMemory(), timeZone };
}
export function saveRequestDefaults(value: RequestDefaults) {
  saveContactMemory(value);
  try { localStorage.setItem(zoneKey, value.timeZone); } catch { /* Keep settings usable without storage. */ }
}
