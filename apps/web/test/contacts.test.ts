import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contactsService, countryTimeZone, normalizePhone, parseContactFile } from '../src/contacts';

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
});
afterEach(() => vi.unstubAllGlobals());
const details = { name: 'Clinic Sol', phone: '+34612345678', timeZone: 'Europe/Madrid', tone: ['Very polite'], notes: 'Be patient.' };

describe('contacts service', () => {
  it('normalizes formatted, local, tel URI, and international-prefix numbers before deduplication', () => {
    expect(normalizePhone('tel:+34 (612) 345-678')).toBe(details.phone);
    expect(normalizePhone('0034 612 345 678')).toBe(details.phone);
    expect(normalizePhone('612345678')).toBe(details.phone);
    expect(() => normalizePhone('abc')).toThrow();
    contactsService.save(details);
    expect(() => contactsService.save({ ...details, phone: '0034 612 345 678' })).toThrow('already exists');
  });
  it('preserves tone and notes, updates by ID, prevents collisions, and deletes only the selected record', () => {
    const first = contactsService.save(details);
    const second = contactsService.save({ ...details, name: 'Barber', phone: '+34612345679' });
    contactsService.save({ ...details, notes: 'Updated notes.' }, first.id);
    expect(contactsService.list().find(c => c.id === first.id)?.notes).toBe('Updated notes.');
    expect(() => contactsService.save({ ...details, phone: second.phone }, first.id)).toThrow('already exists');
    contactsService.remove(first.id);
    expect(contactsService.list()).toEqual([second]);
    expect(() => contactsService.save(details, first.id)).toThrow('deleted');
  });
  it('imports mapped rows once, skips duplicate numbers within the file and store, and reports invalid rows', () => {
    contactsService.save(details);
    expect(contactsService.import([{ name: 'Duplicate', phone: '612345678' }, { name: 'New', phone: '612345679' },
      { name: 'Same new', phone: '+34 612-345-679' }, { name: '', phone: 'invalid' }], 'Europe/Madrid', '+34'))
      .toEqual({ imported: 1, duplicates: 2, skipped: 1 });
    expect(contactsService.list()).toHaveLength(2);
  });
  it('ignores corrupt records and reports persistence failures without claiming a save', () => {
    localStorage.setItem('zeus-llama.contacts.v1', JSON.stringify([null, { ...details, id: 'bad' }]));
    expect(contactsService.list()).toEqual([]);
    vi.stubGlobal('localStorage', { getItem: () => '[]', setItem: () => { throw new Error('quota'); } });
    expect(() => contactsService.save(details)).toThrow('Could not save contacts');
  });
  it('parses CSV quoting, escaped quotes, embedded newlines, BOM, and semicolon delimiters for explicit mapping', () => {
    expect(parseContactFile('\uFEFFCompany,Telephone\r\n"Clinic, Sol",+34612345678\r\n"A ""quoted""\nname",612345679', 'contacts.csv'))
      .toEqual({ columns: ['Company', 'Telephone'], rows: [['Clinic, Sol', '+34612345678'], ['A "quoted"\nname', '612345679']] });
    expect(parseContactFile('"Company, name";Telephone\nClinic;612345678', 'contacts.csv').rows).toEqual([['Clinic', '612345678']]);
    expect(() => parseContactFile('Name,Phone\n"broken,123', 'contacts.csv')).toThrow('unclosed');
  });
  it('unfolds vCards and handles escaped names and multiple telephone entries', () => {
    const result = parseContactFile('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Clinic\\, Sol\r\nTEL;TYPE=WORK:+34 612\r\n 345678\r\nitem1.TEL;VALUE=uri:tel:+34612345679\r\nEND:VCARD', 'contacts.vcf');
    expect(result.rows).toEqual([['Clinic, Sol', '+34 612345678'], ['Clinic, Sol', 'tel:+34612345679']]);
  });
  it('suggests country timezones while allowing unsupported countries to remain manual', () => {
    expect(countryTimeZone('+34612345678')).toBe('Europe/Madrid');
    expect(countryTimeZone('+442079460123')).toBe('Europe/London');
    expect(countryTimeZone('+819012345678')).toBeUndefined();
  });
});
