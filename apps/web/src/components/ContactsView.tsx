import { useState } from 'react';
import { contactsService, type Contact } from '../contacts';
import { useContacts } from '../useContacts';
import ContactEditor from './ContactEditor';

export default function ContactsView() {
  const { contacts, loading, error, reload } = useContacts();
  const [query, setQuery] = useState(''); const [editor, setEditor] = useState<Contact | 'new' | null>(null);
  const [message, setMessage] = useState(''); const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const legacy = contactsService.legacy();
  const filtered = contacts.filter(contact => (contact.name + ' ' + contact.phone).toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  return <section className="panel space-y-5" aria-labelledby="contacts-title">
    <div className="contacts-heading"><div><h2 id="contacts-title">Contacts</h2><p className="text-base text-stone-300">Save the people and businesses you call. Select them by name on Home or Request.</p></div>
      <button type="button" className="primary" onClick={() => { setMessage(''); setEditor('new'); }}>Create contact</button>
    </div>
    {loading && <p role="status">Loading contacts…</p>}
    {error && <div role="alert" className="notice error"><p>{error}</p><button type="button" className="secondary mt-3" disabled={loading} onClick={() => void reload()}>Retry contacts</button></div>}
    {message && <p role="status" className="notice">{message}</p>}
    {!!legacy.length && <div className="notice"><p>You have {legacy.length} contacts saved by the previous browser-only version.</p>
      <button type="button" disabled={importing} className="secondary mt-3" onClick={async () => {
        setImporting(true); setImportError('');
        try { const result = await contactsService.importDetails(legacy); setMessage(`${result.imported} contacts imported; ${result.duplicates} duplicate phone numbers skipped. Your browser copy is preserved.`); }
        catch (error) { setImportError(error instanceof Error ? error.message : 'Could not import previous contacts.'); }
        finally { setImporting(false); }
      }}>{importing ? 'Importing…' : 'Import previous browser contacts'}</button>
      {importError && <p role="alert" className="mt-3">{importError}</p>}
    </div>}
    <label>Search contacts<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Name or phone number" /></label>
    {!loading && !error && !contacts.length && <p>No contacts yet. Create your first contact to get started.</p>}
    {!!contacts.length && !filtered.length && <p>No matching contacts.</p>}
    <ul className="space-y-3" aria-label="Saved contacts">{filtered.map(contact => <li className="history-card" key={contact.id}>
      <div className="history-card-copy"><h3 className="font-semibold">{contact.name}</h3><p>{contact.phone}</p><p className="text-base text-stone-300">{contact.timeZone}</p>
        {!!contact.tone.length && <p className="text-base">{contact.tone.join(', ')}</p>}{contact.notes && <p className="contact-notes text-base">{contact.notes}</p>}
      </div>
      <button type="button" className="secondary" aria-label={`Edit ${contact.name}`} onClick={() => { setMessage(''); setEditor(contact); }}>Edit contact</button>
    </li>)}</ul>
    {editor && <ContactEditor {...(editor === 'new' ? {} : { contact: editor })} onClose={() => setEditor(null)}
      onSaved={() => { setEditor(null); setMessage('Contact saved.'); }} onDeleted={() => { setEditor(null); setMessage('Contact deleted.'); }} />}
  </section>;
}
