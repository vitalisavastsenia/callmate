import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contactsService, countryTimeZone, normalizePhone, parseContactFile, type Contact } from '../src/contacts';

const details = { name: 'Clinic Sol', phone: '+34612345678', timeZone: 'Europe/Madrid', tone: ['Very polite'], notes: 'Be patient.' };
const contact: Contact = { ...details, id: '10000000-0000-4000-8000-000000000001' };
const response = (value: unknown, status = 200) => Response.json(value, { status });
beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('VITE_MOCK', 'true');
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ items: [] })));
  await contactsService.load(); vi.mocked(fetch).mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('backend contacts service', () => {
  it('normalizes formatted numbers and saves to the backend even when call mode is simulator', async () => {
    expect(normalizePhone('tel:+34 (612) 345-678')).toBe(details.phone);
    expect(normalizePhone('0034 612 345 678')).toBe(details.phone);
    expect(normalizePhone('612345678')).toBe(details.phone);
    expect(() => normalizePhone('abc')).toThrow();
    vi.mocked(fetch).mockResolvedValueOnce(response({ contact }));
    expect(await contactsService.save({ ...details, phone: '0034 612 345 678' })).toEqual(contact);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/v1/contacts'); expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(details);
    expect(localStorage.getItem('zeus-llama.contacts.v1')).toBeNull();
  });
  it('updates and deletes by server ID and publishes only acknowledged records', async () => {
    const changed = { ...contact, notes: 'Updated notes.' };
    const notify = vi.fn(); const unsubscribe = contactsService.subscribe(notify);
    vi.mocked(fetch).mockResolvedValueOnce(response({ contact })).mockResolvedValueOnce(response({ contact: changed }))
      .mockResolvedValueOnce(response({ contactId: contact.id, deleted: true }));
    await contactsService.save(details);
    await contactsService.save({ ...details, notes: changed.notes }, contact.id);
    expect(contactsService.list()).toEqual([changed]);
    expect(vi.mocked(fetch).mock.calls[1]![1]?.method).toBe('PUT');
    await contactsService.remove(contact.id); expect(contactsService.list()).toEqual([]);
    expect(vi.mocked(fetch).mock.calls[2]![1]?.headers).not.toHaveProperty('Content-Type');
    expect(notify).toHaveBeenCalledTimes(3); unsubscribe();
  });
  it('imports normalized rows through the bulk API and reports invalid rows separately', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ imported: 1, duplicates: 2 }))
      .mockResolvedValueOnce(response({ items: [contact] }));
    expect(await contactsService.import([{ name: 'Duplicate', phone: '612345678' }, { name: 'New', phone: '612345679' },
      { name: 'Same new', phone: '+34 612-345-679' }, { name: '', phone: 'invalid' }], 'Europe/Madrid', '+34'))
      .toEqual({ imported: 1, duplicates: 2, skipped: 1 });
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('/api/v1/contacts/import');
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string).contacts).toHaveLength(3);
    expect(contactsService.list()).toEqual([contact]);
  });
  it('keeps acknowledged data on server errors and preserves old browser records for explicit import', async () => {
    localStorage.setItem('zeus-llama.contacts.v1', JSON.stringify([null, { ...details, id: 'bad' }, contact]));
    expect(contactsService.legacy()).toEqual([details]);
    vi.mocked(fetch).mockResolvedValueOnce(response({ contact })); await contactsService.save(details);
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('network'));
    await expect(contactsService.remove(contact.id)).rejects.toThrow('reach the Zeus backend');
    expect(contactsService.list()).toEqual([contact]);
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: { code: 'CONTACT_ALREADY_EXISTS', message: 'Duplicate phone', requestId: contact.id, details: [] } }, 409));
    await expect(contactsService.save(details)).rejects.toMatchObject({ code: 'CONTACT_ALREADY_EXISTS' });
    expect(contactsService.list()).toEqual([contact]);
    expect(localStorage.getItem('zeus-llama.contacts.v1')).toContain(contact.id);
  });
  it('a delayed list response cannot resurrect a deleted contact or overwrite a successful save', async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = contactsService.load();
    vi.mocked(fetch).mockResolvedValueOnce(response({ contact })); await contactsService.save(details);
    resolve(response({ items: [] })); await pending;
    expect(contactsService.list()).toEqual([contact]);
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const old = contactsService.load();
    vi.mocked(fetch).mockResolvedValueOnce(response({ contactId: contact.id, deleted: true })); await contactsService.remove(contact.id);
    resolve(response({ items: [contact] })); await old;
    expect(contactsService.list()).toEqual([]);
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
