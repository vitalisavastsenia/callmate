import { useCallback, useEffect, useState } from 'react';
import { contactsService } from './contacts';

export function useContacts() {
  const [contacts, setContacts] = useState(() => contactsService.list());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try { await contactsService.load(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not load contacts.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    const unsubscribe = contactsService.subscribe(() => setContacts(contactsService.list()));
    void reload();
    window.addEventListener('focus', reload);
    return () => { unsubscribe(); window.removeEventListener('focus', reload); };
  }, [reload]);
  return { contacts, loading, error, reload };
}
