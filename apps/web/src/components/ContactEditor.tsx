import { useState } from 'react';
import { contactsService, countryTimeZone, type Contact, type ContactDetails } from '../contacts';
import { Modal, ToneFields } from './ContactFields';
import PhoneField from './PhoneField';
import TimezoneSelect from './TimezoneSelect';

export default function ContactEditor({ contact, onClose, onSaved, onDeleted }: {
  contact?: Contact; onClose: () => void; onSaved: (contact: Contact) => void; onDeleted?: () => void;
}) {
  const [value, setValue] = useState<ContactDetails>(contact ?? { name: '', phone: '+34', timeZone: 'Europe/Madrid', tone: [], notes: '' });
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false); const [zoneEdited, setZoneEdited] = useState(!!contact);
  return <Modal title={contact ? 'Edit contact' : 'Create contact'} onClose={() => { if (!busy) onClose(); }}>
    <form noValidate className="space-y-4" onSubmit={async e => {
      e.preventDefault(); e.stopPropagation(); if (busy) return;
      setBusy(true); setError('');
      try { onSaved(await contactsService.save(value, contact?.id)); }
      catch (error) { setError(error instanceof Error ? error.message : 'Could not save contact.'); }
      finally { setBusy(false); }
    }}>
      <p className="text-base text-stone-300">Name, phone number, and timezone are required.</p>
      <fieldset disabled={busy} className="space-y-4">
        <label>Name<input required autoFocus value={value.name} maxLength={200} onChange={e => setValue({ ...value, name: e.target.value })} /></label>
        <PhoneField phoneLabel="Contact phone" deferErrors value={value.phone} onChange={phone => {
          setValue({ ...value, phone, timeZone: zoneEdited ? value.timeZone : countryTimeZone(phone) ?? value.timeZone });
        }} />
        <TimezoneSelect label="Contact timezone" value={value.timeZone} onChange={timeZone => { setZoneEdited(true); setValue({ ...value, timeZone }); }} />
        <ToneFields tone={value.tone} notes={value.notes} onChange={(tone, notes) => setValue({ ...value, tone, notes })} />
      </fieldset>
      {error && <p role="alert" className="notice error">{error}</p>}
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={busy} className="primary">{busy ? 'Saving…' : 'Save contact'}</button>
        <button type="button" disabled={busy} className="secondary" onClick={onClose}>Cancel</button>
        {contact && onDeleted && <button type="button" disabled={busy} className="text-add" onClick={() => setDeleting(true)}>Delete contact</button>}
      </div>
      {deleting && contact && <div className="notice"><p>Delete this saved contact? Existing requests and call history will keep their recorded details.</p>
        <button type="button" disabled={busy} className="secondary mt-3" onClick={async () => {
          if (busy) return; setBusy(true); setError('');
          try { await contactsService.remove(contact.id); onDeleted?.(); }
          catch (error) { setError(error instanceof Error ? error.message : 'Could not delete contact.'); }
          finally { setBusy(false); }
        }}>Confirm delete</button>
      </div>}
    </form>
  </Modal>;
}
