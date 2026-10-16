import { api, ContactDetailsSchema, ContactSchema, TimeZoneSchema, type Contact, type ContactDetails } from './types';
import { ApiError, request as backendRequest } from './api';
export type { Contact, ContactDetails } from './types';

export const toneOptions = ['Very polite', 'Formal "usted"', 'Friendly', 'Firm', 'Speak slowly'];
const storageKey = 'zeus-llama.contacts.v1';

async function request<T>(method: string, path: string, schema: { parse: (value: unknown) => T }, body?: unknown): Promise<T> {
  try { return await backendRequest(method, path, schema, body); }
  catch (error) {
    if (error instanceof ApiError && error.code === 'BACKEND_UNREACHABLE') {
      throw new ApiError("Can't reach the Zeus backend. Start the backend and retry; contacts need it in both call modes.", error.code, error.details);
    }
    throw error;
  }
}

export function normalizePhone(input: string, countryCode = '+34'): string {
  let phone = input.trim().replace(/^tel:/i, '').replace(/[\s().-]/g, '');
  if (phone.startsWith('00')) phone = '+' + phone.slice(2);
  else if (!phone.startsWith('+')) phone = countryCode + phone;
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error('Use a valid phone number with a country code.');
  return phone;
}
export function countryTimeZone(phone: string): string | undefined {
  // Country defaults are suggestions; countries with several zones need review.
  return [['+34', 'Europe/Madrid'], ['+44', 'Europe/London'], ['+33', 'Europe/Paris'], ['+49', 'Europe/Berlin'],
    ['+39', 'Europe/Rome'], ['+351', 'Europe/Lisbon'], ['+31', 'Europe/Amsterdam'], ['+380', 'Europe/Kyiv'], ['+1', 'America/New_York']]
    .find(([code]) => phone.startsWith(code!))?.[1];
}
export function validateContact(value: ContactDetails): ContactDetails {
  const name = value.name.trim();
  if (!name || name.length > 200) throw new Error('Enter a contact name (up to 200 characters).');
  if (!TimeZoneSchema.safeParse(value.timeZone).success) throw new Error('Enter a valid IANA timezone.');
  if (value.notes.length > 2000 || value.tone.length > 10 || value.tone.some(t => !t.trim() || t.length > 100)) throw new Error('Shorten the contact notes or tone preferences.');
  return ContactDetailsSchema.parse({ name, phone: normalizePhone(value.phone), timeZone: value.timeZone,
    tone: [...new Set(value.tone.map(t => t.trim()))], notes: value.notes.trim() });
}
let cached: Contact[] = [];
let revision = 0;
let loadSequence = 0;
const listeners = new Set<() => void>();
function publish(contacts: Contact[]) {
  cached = contacts; revision++;
  for (const notify of listeners) notify();
}
// Both call modes use the same backend address book. Cache only acknowledged records.
export const contactsService = {
  list(): Contact[] { return structuredClone(cached); },
  subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
  async load(): Promise<Contact[]> {
    const version = revision; const sequence = ++loadSequence;
    const result = await request(api.listContacts.method, api.listContacts.path, api.listContacts.response);
    if (version === revision && sequence === loadSequence) publish(result.items);
    return this.list();
  },
  async save(value: ContactDetails, id?: string): Promise<Contact> {
    const details = validateContact(value);
    const route = id ? api.updateContact : api.createContact;
    const result = await request(route.method, route.path.replace(':contactId', encodeURIComponent(id ?? '')), route.response, details);
    publish([...cached.filter(c => c.id !== result.contact.id), result.contact]);
    return result.contact;
  },
  async remove(id: string) {
    await request(api.deleteContact.method, api.deleteContact.path.replace(':contactId', encodeURIComponent(id)), api.deleteContact.response);
    publish(cached.filter(c => c.id !== id));
  },
  async importDetails(contacts: ContactDetails[]) {
    let imported = 0; let duplicates = 0;
    try {
      const batches: ContactDetails[][] = []; let batch: ContactDetails[] = [];
      for (const contact of contacts) {
        const value = validateContact(contact);
        if (batch.length && (batch.length >= 100 || new TextEncoder().encode(JSON.stringify({ contacts: [...batch, value] })).length > 60_000)) {
          batches.push(batch); batch = [];
        }
        batch.push(value);
      }
      if (batch.length) batches.push(batch);
      for (const batch of batches) {
        const body = api.importContacts.request.parse({ contacts: batch });
        const result = await request(api.importContacts.method, api.importContacts.path, api.importContacts.response, body);
        imported += result.imported; duplicates += result.duplicates;
      }
    } catch {
      await this.load().catch(() => {});
      throw new Error('Import was interrupted. Refresh contacts before retrying; already saved phone numbers will be skipped.');
    }
    await this.load();
    return { imported, duplicates };
  },
  async import(rows: { name: string; phone: string }[], timeZone: string, countryCode: string) {
    if (!TimeZoneSchema.safeParse(timeZone).success) throw new Error('Choose a valid default timezone for imported contacts.');
    const contacts: ContactDetails[] = []; let skipped = 0;
    for (const row of rows) {
      try { contacts.push(validateContact({ ...row, phone: normalizePhone(row.phone, countryCode), timeZone, tone: [], notes: '' })); }
      catch { skipped++; }
    }
    return { ...await this.importDetails(contacts), skipped };
  },
  legacy(): ContactDetails[] {
    try {
      const data: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      if (!Array.isArray(data)) return [];
      return data.flatMap(value => {
        const parsed = ContactSchema.safeParse(value);
        return parsed.success ? [validateContact(parsed.data)] : [];
      });
    } catch { return []; }
  },
};

export interface ContactTable { columns: string[]; rows: string[][] }
export function parseContactFile(text: string, filename: string): ContactTable {
  if (text.length > 2_000_000) throw new Error('Choose a contacts file smaller than 2 MB.');
  if (/\.vcf$/i.test(filename)) {
    const unfold = text.replace(/\r?\n[ \t]/g, '');
    const unescape = (v: string) => v.replace(/\\[nN]/g, '\n').replace(/\\([,;\\])/g, '$1');
    const rows: string[][] = [];
    for (const card of unfold.split(/BEGIN:VCARD/i).slice(1)) {
      if (!/END:VCARD/i.test(card)) continue;
      const name = card.match(/^(?:item\d+\.)?FN(?:;[^:\r\n]*)?:(.*)$/im)?.[1]
        ?? card.match(/^N(?:;[^:\r\n]*)?:(.*)$/im)?.[1]?.split(';').filter(Boolean).reverse().join(' ');
      if (!name) continue;
      for (const match of card.matchAll(/^(?:item\d+\.)?TEL(?:;[^:\r\n]*)?:(.*)$/gim)) rows.push([unescape(name).trim(), match[1]!.trim()]);
    }
    if (!rows.length) throw new Error('No contacts with a name and phone were found in this vCard file.');
    return { columns: ['Name', 'Phone'], rows };
  }
  if (!/\.csv$/i.test(filename)) throw new Error('Choose a .vcf or .csv contacts file.');
  const source = text.replace(/^\uFEFF/, '');
  const firstLine = source.split(/\r?\n/)[0] ?? '';
  let inQuotes = false; const counts = new Map([[',', 0], [';', 0], ['\t', 0]]);
  for (const ch of firstLine) { if (ch === '"') inQuotes = !inQuotes; else if (!inQuotes && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1); }
  const delimiter = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = []; let row: string[] = []; let value = ''; let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '"') {
      if (quoted && source[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && (ch === delimiter || ch === '\n' || ch === '\r')) {
      row.push(value.trim()); value = '';
      if (ch !== delimiter) {
        if (row.some(Boolean)) rows.push(row); row = [];
        if (ch === '\r' && source[i + 1] === '\n') i++;
      }
    } else value += ch;
  }
  if (quoted) throw new Error('This CSV has an unclosed quoted field. Fix the file and import it again.');
  row.push(value.trim()); if (row.some(Boolean)) rows.push(row);
  const columns = rows.shift();
  if (!columns || columns.length < 2 || !rows.length) throw new Error('Use a CSV with a header row and name and phone columns.');
  return { columns, rows };
}
