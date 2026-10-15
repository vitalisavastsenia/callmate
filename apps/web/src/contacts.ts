import { IdSchema, TimeZoneSchema } from './types';

export const toneOptions = ['Very polite', 'Formal "usted"', 'Friendly', 'Firm', 'Speak slowly'];
export interface ContactDetails { name: string; phone: string; timeZone: string; tone: string[]; notes: string }
export interface Contact extends ContactDetails { id: string }
const storageKey = 'zeus-llama.contacts.v1';

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
function validate(value: ContactDetails): ContactDetails {
  const name = value.name.trim();
  if (!name || name.length > 200) throw new Error('Enter a contact name (up to 200 characters).');
  if (!TimeZoneSchema.safeParse(value.timeZone).success) throw new Error('Enter a valid IANA timezone.');
  if (value.notes.length > 2000 || value.tone.length > 10 || value.tone.some(t => !t.trim() || t.length > 100)) throw new Error('Shorten the contact notes or tone preferences.');
  return { name, phone: normalizePhone(value.phone), timeZone: value.timeZone, tone: [...new Set(value.tone.map(t => t.trim()))], notes: value.notes.trim() };
}
function write(contacts: Contact[]) {
  try { localStorage.setItem(storageKey, JSON.stringify(contacts)); }
  catch { throw new Error('Could not save contacts on this device. Check browser storage and try again.'); }
}
// All contact persistence is isolated here so the UI can later use a backend service.
export const contactsService = {
  list(): Contact[] {
    try {
      const data: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      if (!Array.isArray(data)) return [];
      const result: Contact[] = [];
      const phones = new Set<string>(); const ids = new Set<string>();
      for (const item of data) {
        try {
          if (!item || !IdSchema.safeParse(item.id).success) continue;
          const contact = { ...validate(item as ContactDetails), id: item.id };
          if (!phones.has(contact.phone) && !ids.has(contact.id)) { result.push(contact); phones.add(contact.phone); ids.add(contact.id); }
        } catch { /* Ignore malformed saved records, preserving valid contacts. */ }
      }
      return result;
    } catch { return []; }
  },
  save(value: ContactDetails, id?: string): Contact {
    const details = validate(value);
    const contacts = this.list();
    if (id && !contacts.some(c => c.id === id)) throw new Error('This contact was deleted. Save it as a new contact.');
    if (contacts.some(c => c.phone === details.phone && c.id !== id)) throw new Error('A contact with this phone number already exists. Pick it from contacts.');
    const contact = { ...details, id: id ?? crypto.randomUUID() };
    write(id ? contacts.map(c => c.id === id ? contact : c) : [...contacts, contact]);
    return contact;
  },
  remove(id: string) { write(this.list().filter(c => c.id !== id)); },
  import(rows: { name: string; phone: string }[], timeZone: string, countryCode: string) {
    if (!TimeZoneSchema.safeParse(timeZone).success) throw new Error('Choose a valid default timezone for imported contacts.');
    const contacts = this.list(); const phones = new Set(contacts.map(c => c.phone));
    let imported = 0; let duplicates = 0; let skipped = 0;
    for (const row of rows) {
      try {
        const details = validate({ ...row, phone: normalizePhone(row.phone, countryCode), timeZone, tone: [], notes: '' });
        if (phones.has(details.phone)) { duplicates++; continue; }
        contacts.push({ ...details, id: crypto.randomUUID() }); phones.add(details.phone); imported++;
      } catch { skipped++; }
    }
    if (imported) write(contacts);
    return { imported, duplicates, skipped };
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
