import { useEffect, useRef, useState } from 'react';
import type { CallSnapshot } from '../types';
import { Modal } from './ContactFields';

export default function DeleteConversationDialog({ call, onDelete, onClose }: {
  call: CallSnapshot; onDelete: () => Promise<void>; onClose: () => void;
}) {
  const pending = useRef(false);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancel.current?.focus(); }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const close = () => { if (!pending.current) onClose(); };
  return <Modal title="Delete conversation text?" onClose={close}>
    <p>Delete the conversation text and replay data for {call.plan.request.business.name}? This cannot be undone. Structured request details and agreements remain; provider logs and backups are separate.</p>
    {error && <p role="alert" className="notice error mt-4">{error}</p>}
    <div className="mt-5 flex flex-wrap gap-3">
      <button type="button" className="secondary" disabled={busy} ref={cancel} onClick={close}>Cancel</button>
      <button type="button" className="primary" disabled={busy} onClick={async () => {
        if (pending.current) return;
        pending.current = true; setBusy(true); setError('');
        try { await onDelete(); onClose(); }
        catch (error) { setError(error instanceof Error ? error.message : 'Could not delete the conversation. Try again.'); }
        finally { pending.current = false; setBusy(false); }
      }}>{busy ? 'Deleting…' : 'Permanently delete conversation text'}</button>
    </div>
  </Modal>;
}
