import { useEffect, useState } from 'react';
import { TWILIO_NOT_IMPLEMENTED, type CallEngine, type CallEngineSettings as Settings } from '@callmate/contracts';
import { getCallEngine, updateCallEngine } from '../api';

export default function CallEngineSettings({ locked, onSaved }: { locked: boolean; onSaved: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [engine, setEngine] = useState<CallEngine>('mock');
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true; setLoading(true); setError(''); setSettings(null);
    void getCallEngine().then(value => {
      if (current) { setSettings(value); setEngine(value.engine); }
    }, () => { if (current) setError('Could not load the call engine. Check the backend and sign-in session, then retry.'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [reload]);
  useEffect(() => {
    if (locked || !settings || settings.editable) return;
    let current = true;
    void getCallEngine().then(value => { if (current) setSettings(previous => previous ? { ...previous, editable: value.editable } : previous); }, () => {});
    return () => { current = false; };
  }, [locked, settings?.editable]);
  const dirty = !!settings && engine !== settings.engine;
  return <section className="space-y-3" aria-labelledby="call-engine-title">
    <div className="settings-card-heading"><h3 id="call-engine-title" className="section-title">Call engine</h3>{settings && <span className="settings-save-state" role="status">{dirty ? 'Unsaved changes' : 'Up to date'}</span>}</div>
    <p className="text-base text-stone-300">Applies to Backend calls. The browser Simulator remains a separate scripted mode.</p>
    {loading && <p role="status">Loading call engine…</p>}
    {error && <p role="alert" className="notice error">{error}</p>}
    {message && <p role="status" className="notice">{message}</p>}
    {settings && <form onSubmit={async event => {
      event.preventDefault(); if (locked || loading || saving || !settings.editable || !dirty) return;
      setSaving(true); setError(''); setMessage('');
      try { const value = await updateCallEngine(engine); setSettings(value); setEngine(value.engine); setMessage('Call engine saved.'); onSaved(); }
      catch { setError('Could not save the call engine. Finish any active call and check the backend, then retry.'); }
      finally { setSaving(false); }
    }}><fieldset disabled={locked || loading || saving || !settings.editable} className="space-y-3">
      <label>Call engine<select aria-label="Call engine" aria-describedby="call-engine-description" value={engine} onChange={event => { setEngine(event.target.value as CallEngine); setMessage(''); }}>
        <option value="mock">Mock service</option><option value="twilio">Twilio · not implemented yet</option>
      </select></label>
      <p id="call-engine-description" role={engine === 'twilio' ? 'status' : undefined} className={engine === 'twilio' ? 'notice' : 'text-base text-stone-300'}>
        {engine === 'twilio' ? TWILIO_NOT_IMPLEMENTED : 'Mock service simulates calls. No real phone number is dialed.'}
      </p>
      <button type="submit" className="primary settings-save" disabled={!dirty}>{saving ? 'Saving call engine…' : 'Save call engine'}</button>
    </fieldset></form>}
    {(locked || settings && !settings.editable) && <p className="notice">Finish or resolve the current call attempt before changing the call engine.</p>}
    {!loading && (!settings || !settings.editable) && <button type="button" className="secondary" disabled={saving} onClick={() => setReload(value => value + 1)}>Refresh call engine</button>}
  </section>;
}
