import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { contactsService, normalizePhone, parseContactFile, toneOptions, type Contact, type ContactDetails, type ContactTable } from '../contacts';
import PhoneField from './PhoneField';

export function ToneFields({ tone, notes, onChange, hideHeading = false }: { tone: string[]; notes: string; onChange: (tone: string[], notes: string) => void; hideHeading?: boolean }) {
  return <fieldset className="tone-fields"><legend className={hideHeading ? 'sr-only' : 'section-title'}>Tone &amp; manner</legend>
    <div className="mb-4 flex flex-wrap gap-2">{[...new Set([...toneOptions, ...tone])].map(option => <button key={option} type="button" className="secondary template-chip" aria-pressed={tone.includes(option)} onClick={() => onChange(tone.includes(option) ? tone.filter(t => t !== option) : [...tone, option], notes)}>{option === 'Formal "usted"' ? 'Formal' : option}</button>)}</div>
    <label>Notes for Zeus<textarea data-gramm="false" aria-label="Notes for Zeus" value={notes} onChange={e => onChange(tone, e.target.value)} maxLength={2000} rows={2} placeholder="Grumpy guy, be extra polite and patient" /></label>
  </fieldset>;
}
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null); const titleId = useId();
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return createPortal(<dialog ref={ref} className="contact-dialog" aria-labelledby={titleId} onCancel={e => { e.preventDefault(); onClose(); }}>
    <div className="mb-5 flex items-start justify-between gap-3"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}>×</button></div>{children}
  </dialog>, document.body);
}
function ContactEditor({ contact, onClose, onSaved, onDeleted }: { contact: Contact; onClose: () => void; onSaved: (contact: Contact) => void; onDeleted: () => void }) {
  const [value, setValue] = useState<ContactDetails>(contact); const [error, setError] = useState(''); const [deleting, setDeleting] = useState(false);
  return <Modal title="Edit contact" onClose={onClose}>
    <form noValidate className="space-y-4" onSubmit={e => { e.preventDefault(); e.stopPropagation(); try { onSaved(contactsService.save(value, contact.id)); } catch (e) { setError((e as Error).message); } }}>
      <label>Name<input value={value.name} maxLength={200} onChange={e => setValue({ ...value, name: e.target.value })} /></label>
      <label>Contact phone<input type="tel" value={value.phone} onChange={e => setValue({ ...value, phone: e.target.value })} /></label>
      <label>Contact timezone<input value={value.timeZone} onChange={e => setValue({ ...value, timeZone: e.target.value })} /></label>
      <ToneFields tone={value.tone} notes={value.notes} onChange={(tone, notes) => setValue({ ...value, tone, notes })} />
      {error && <p role="alert" className="notice error">{error}</p>}
      <div className="flex flex-wrap gap-3"><button type="submit" className="primary">Save contact</button><button type="button" className="text-add" onClick={() => setDeleting(true)}>Delete contact</button></div>
      {deleting && <div className="notice"><p>Delete this saved contact? Your current request will keep its details.</p><button type="button" className="secondary mt-3" onClick={() => { try { contactsService.remove(contact.id); onDeleted(); } catch (e) { setError((e as Error).message); } }}>Confirm delete</button></div>}
    </form>
  </Modal>;
}
function ContactImport({ table, onClose, onImported, defaultZone }: { table: ContactTable; onClose: () => void; onImported: (message: string) => void; defaultZone: string }) {
  const [nameColumn, setNameColumn] = useState(Math.max(0, table.columns.findIndex(c => /^(?:full[ -]?)?name$|display.?name/i.test(c))));
  const [phoneColumn, setPhoneColumn] = useState(Math.max(0, table.columns.findIndex(c => /phone|mobile|tel/i.test(c))));
  const [zone, setZone] = useState(defaultZone); const [code, setCode] = useState('+34'); const [error, setError] = useState('');
  return <Modal title="Import contacts" onClose={onClose}><form className="space-y-4" noValidate onSubmit={e => {
    e.preventDefault(); e.stopPropagation();
    if (nameColumn === phoneColumn) { setError('Map name and phone to different columns.'); return; }
    try {
      const result = contactsService.import(table.rows.map(row => ({ name: row[nameColumn] ?? '', phone: row[phoneColumn] ?? '' })), zone, code);
      onImported(`${result.imported} imported · ${result.duplicates} duplicate phone numbers skipped · ${result.skipped} invalid rows skipped.`);
    } catch (e) { setError((e as Error).message); }
  }}>
    <p className="text-base">Map the columns below. Contacts with the same phone number are skipped.</p>
    <div className="form-grid">{([['Name column', nameColumn, setNameColumn], ['Phone column', phoneColumn, setPhoneColumn]] as const).map(([label, value, set]) => <label key={label}>{label}<select aria-label={label} value={value} onChange={e => set(Number(e.target.value))}>{table.columns.map((column, i) => <option key={i} value={i}>{column || `Column ${i + 1}`}</option>)}</select></label>)}</div>
    <p className="text-base text-stone-300">First contact: {table.rows[0]?.[nameColumn] || 'No name'} · {table.rows[0]?.[phoneColumn] || 'No phone'}</p>
    <label>Country code for local numbers<select value={code} onChange={e => setCode(e.target.value)}><option value="+34">Spain (+34)</option><option value="+44">UK (+44)</option><option value="+1">US / Canada (+1)</option><option value="+33">France (+33)</option><option value="+49">Germany (+49)</option><option value="+39">Italy (+39)</option><option value="+351">Portugal (+351)</option><option value="+31">Netherlands (+31)</option><option value="+380">Ukraine (+380)</option></select></label>
    <label>Default timezone<input value={zone} onChange={e => setZone(e.target.value)} /></label>
    {error && <p role="alert" className="notice error">{error}</p>}
    <button type="submit" className="primary">Import contacts</button>
  </form></Modal>;
}

interface Props {
  compact?: boolean; showErrors?: boolean; deferErrors?: boolean; hideHeading?: boolean;
  value: ContactDetails; contacts: Contact[]; selectedId: string | null; saveChecked: boolean;
  onChange: (value: ContactDetails) => void; onSelect: (contact: Contact | null) => void;
  onContactsChange: (contacts: Contact[]) => void; onSaveChecked: (checked: boolean) => void;
}
export default function ContactPicker({ value, contacts, selectedId, saveChecked, onChange, onSelect, onContactsChange, onSaveChecked, compact = false, showErrors = false, deferErrors = false, hideHeading = false }: Props) {
  const [nameTouched, setNameTouched] = useState(false);
  const nameInvalid = (showErrors || (deferErrors && nameTouched)) && !value.name.trim();
  const selected = contacts.find(c => c.id === selectedId);
  let knownNumber = false;
  try { knownNumber = contacts.some(c => c.phone === normalizePhone(value.phone, '')); } catch { /* Incomplete destination. */ }
  const showSave = !knownNumber;
  const [query, setQuery] = useState(''); const [open, setOpen] = useState(false); const [active, setActive] = useState(-1);
  const [editing, setEditing] = useState(false); const [table, setTable] = useState<ContactTable | null>(null); const [message, setMessage] = useState(''); const [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null); const listId = useId();
  const filtered = contacts.filter(c => (c.name + ' ' + c.phone).toLowerCase().includes(query.toLowerCase()) || (!!query.replace(/\D/g, '') && c.phone.includes(query.replace(/\D/g, ''))));
  const index = Math.max(0, Math.min(active, filtered.length));
  function choose(i: number) {
    setOpen(false); setQuery('');
    const contact = filtered[i]; if (contact) onSelect(contact); else file.current?.click();
  }
  return <fieldset className="compact-destination space-y-3"><legend className={hideHeading ? 'sr-only' : 'section-title'}>{compact ? 'Who should Zeus call?' : 'Who to call'}</legend>
    <div className="destination-row"><div className="contact-picker" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
      <div className="contact-name-row flex items-end gap-2"><label className="min-w-0 flex-1">Name<input aria-label="Name" required maxLength={200} aria-invalid={nameInvalid || undefined} aria-describedby={nameInvalid ? `${listId}-name-error` : undefined} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={listId} aria-activedescendant={open ? `${listId}-${index}` : undefined} value={value.name} placeholder="Name or saved contact" autoComplete="off" onBlur={() => setNameTouched(true)} onFocus={() => { setOpen(true); setActive(-1); }} onClick={() => setOpen(true)} onChange={e => { setQuery(e.target.value); onChange({ ...value, name: e.target.value }); setOpen(true); setActive(-1); }} onKeyDown={e => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); setActive(n => e.key === 'ArrowDown' ? Math.min(n + 1, filtered.length) : Math.max(n - 1, 0)); }
        else if (e.key === 'Enter' && open) { e.preventDefault(); if (filtered.length || active >= 0) choose(index); else setOpen(false); }
        else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
      }} /></label>
      {selected && <button type="button" className="icon-button" aria-label="Edit selected contact" title="Edit selected contact" onClick={() => setEditing(true)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6Z M13 6l5 5" /></svg></button>}</div>
      {nameInvalid && <small id={`${listId}-name-error`} className="field-error">Enter a name</small>}
      {open && <ul id={listId} role="listbox" aria-label="Contacts" className="contact-options">{filtered.map((c, i) => <li key={c.id} id={`${listId}-${i}`} role="option" aria-selected={index === i} onMouseDown={e => e.preventDefault()} onClick={() => choose(i)}>{c.name}<small>{c.phone}</small></li>)}<li id={`${listId}-${filtered.length}`} role="option" aria-selected={index === filtered.length} onMouseDown={e => e.preventDefault()} onClick={() => choose(filtered.length)}>Import contacts (.vcf / .csv)</li></ul>}
    </div>
    <PhoneField compact deferErrors={deferErrors} showErrors={showErrors} value={value.phone} onChange={phone => onChange({ ...value, phone })} /></div>
    <input ref={file} type="file" aria-label="Contacts file" accept=".vcf,.csv,text/vcard,text/csv" hidden onChange={async e => {
      const chosen = e.target.files?.[0]; e.target.value = ''; if (!chosen) return;
      setError(''); setMessage('');
      try { if (chosen.size > 2_000_000) throw new Error('Choose a contacts file smaller than 2 MB.'); setTable(parseContactFile(await chosen.text(), chosen.name)); }
      catch (e) { setError((e as Error).message); }
    }} />
    {selected && <p className="text-base text-stone-300">Selected: {selected.name} <button type="button" className="text-add" onClick={() => onSelect(null)}>Clear selection</button></p>}
    {showSave && <label className="check-label contact-save"><input type="checkbox" checked={saveChecked} onChange={e => onSaveChecked(e.target.checked)} />Save to contacts</label>}
    {message && <p role="status" className="notice">{message}</p>}{error && <p role="alert" className="notice error">{error}</p>}
    {editing && selected && <ContactEditor contact={selected} onClose={() => setEditing(false)} onSaved={contact => { onContactsChange(contactsService.list()); onSelect(contact); setEditing(false); setMessage('Contact updated.'); }} onDeleted={() => { onContactsChange(contactsService.list()); onSelect(null); setEditing(false); setMessage('Contact deleted.'); }} />}
    {table && <ContactImport table={table} defaultZone={value.timeZone} onClose={() => setTable(null)} onImported={message => { onContactsChange(contactsService.list()); setMessage(message); setTable(null); }} />}
  </fieldset>;
}
