import { useRef, useState } from 'react';
import { SettingsSchema, TimeZoneSchema, scenarios, type Readiness, type Scenario, type Settings } from '../types';
import type { RequestDefaults } from '../preferences';
import LlmAgentSettings from './LlmAgentSettings';
import CallEngineSettings from './CallEngineSettings';

interface Props {
  readiness: Readiness | null; settings: Settings; defaults: RequestDefaults; busy: boolean;
  simulator: boolean; modeLocked: boolean; scenario: Scenario;
  onModeChange: (simulator: boolean) => void; onScenarioChange: (scenario: Scenario) => void;
  onRefresh: () => void; onSave: (settings: Settings, defaults: RequestDefaults) => Promise<void>;
}
type DefaultsProps = Pick<Props, 'settings' | 'defaults' | 'busy' | 'onSave'>;

function PersonalDefaults({ settings, defaults, busy, onSave }: DefaultsProps) {
  const [value, setValue] = useState({ name: defaults.name, phone: defaults.phone, email: defaults.email });
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const pending = useRef(false);
  const dirty = (Object.keys(value) as (keyof typeof value)[]).some(key => value[key] !== defaults[key]);
  return <section id="settings-personal" className="settings-card" aria-labelledby="personal-title">
    <div className="settings-card-heading"><h3 id="personal-title">Personal details</h3><span className="settings-save-state" role="status">{dirty ? 'Unsaved changes' : 'Up to date'}</span></div>
    <p className="settings-description">Default details Zeus may share. Remembered on this device; edit or withhold them for each request.</p>
    {error && <p role="alert" className="notice error">{error}</p>}{message && <p role="status" className="notice">{message}</p>}
    <form noValidate onSubmit={async event => {
      event.preventDefault(); if (busy || pending.current || !dirty) return;
      const next = { ...defaults, name: value.name.trim(), phone: value.phone.trim(), email: value.email.trim() };
      if (next.name.length > 200 || next.phone && !/^\+[1-9]\d{7,14}$/.test(next.phone) || next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) {
        setError('Check the name, international callback number and email.'); return;
      }
      pending.current = true; setError(''); setMessage('');
      try { await onSave(settings, next); setValue({ name: next.name, phone: next.phone, email: next.email }); setMessage('Settings saved. Personal details apply to new requests and untouched fields.'); }
      catch { setError('Could not save personal details. Your edits are still here; please retry.'); }
      finally { pending.current = false; }
    }}><fieldset disabled={busy}>
      <div className="form-grid share-grid">{(['name', 'phone', 'email'] as const).map(key => <label key={key}>{key === 'name' ? 'Default name' : key === 'phone' ? 'Default callback number' : 'Default email'}<input name={key} type={key === 'phone' ? 'tel' : key === 'email' ? 'email' : 'text'} maxLength={key === 'name' ? 200 : key === 'email' ? 320 : 32} value={value[key]} placeholder={key === 'phone' ? '+34…' : undefined} onChange={event => { setValue(previous => ({ ...previous, [key]: event.target.value })); setMessage(''); }} /></label>)}</div>
      <button className="primary settings-save" type="submit" disabled={!dirty || busy}>{pending.current ? 'Saving…' : 'Save personal details'}</button>
    </fieldset></form>
  </section>;
}

function LimitsDefaults({ settings, defaults, busy, onSave }: DefaultsProps) {
  const [value, setValue] = useState({ zone: defaults.timeZone, duration: String(settings.defaultCallLimits.maxDurationSeconds / 60), cost: String(settings.defaultCallLimits.maxEstimatedCost.amountMinor / 100), retention: String(settings.transcriptRetentionDays) });
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const pending = useRef(false);
  const currency = settings.defaultCallLimits.maxEstimatedCost.currency;
  const dirty = value.zone !== defaults.timeZone || value.duration !== String(settings.defaultCallLimits.maxDurationSeconds / 60) || value.cost !== String(settings.defaultCallLimits.maxEstimatedCost.amountMinor / 100) || value.retention !== String(settings.transcriptRetentionDays);
  const update = (key: keyof typeof value, next: string) => { setValue(previous => ({ ...previous, [key]: next })); setMessage(''); };
  return <section id="settings-storage" className="settings-card" aria-labelledby="limits-title">
    <div className="settings-card-heading"><h3 id="limits-title">Call limits &amp; storage</h3><span className="settings-save-state" role="status">{dirty ? 'Unsaved changes' : 'Up to date'}</span></div>
    <p className="settings-description">Defaults for new requests. Existing reviewed plans keep their approved limits.</p>
    {error && <p role="alert" className="notice error">{error}</p>}{message && <p role="status" className="notice">{message}</p>}
    <form noValidate onSubmit={async event => {
      event.preventDefault(); if (busy || pending.current || !dirty) return;
      const result = SettingsSchema.safeParse({ defaultCallLimits: { maxDurationSeconds: Number(value.duration) * 60, maxEstimatedCost: { amountMinor: Math.round(Number(value.cost) * 100), currency } }, transcriptRetentionDays: Number(value.retention) });
      if (!result.success || !TimeZoneSchema.safeParse(value.zone.trim()).success || !value.duration.trim() || !/^\d+(?:\.\d{1,2})?$/.test(value.cost)) {
        setError(`Check the timezone, duration (0.5–10 minutes), ${currency} cost (up to two decimal places), and retention (1–365 days).`); return;
      }
      pending.current = true; setError(''); setMessage('');
      try {
        await onSave(result.data, { ...defaults, timeZone: value.zone.trim() });
        setValue({ zone: value.zone.trim(), duration: String(result.data.defaultCallLimits.maxDurationSeconds / 60), cost: String(result.data.defaultCallLimits.maxEstimatedCost.amountMinor / 100), retention: String(result.data.transcriptRetentionDays) });
        setMessage('Settings saved. Limits apply to new requests and untouched fields.');
      } catch { setError('Could not save call limits. Your edits are still here; please retry.'); }
      finally { pending.current = false; }
    }}><fieldset disabled={busy}><div className="form-grid">
      <label>Default timezone<input name="zone" value={value.zone} onChange={e => update('zone', e.target.value)} required /></label>
      <label>Default maximum call duration (minutes)<input name="duration" type="number" min="0.5" max="10" step="0.5" value={value.duration} onChange={e => update('duration', e.target.value)} required /></label>
      <label>Default maximum call cost ({currency})<input name="cost" type="number" min="0" step="0.01" value={value.cost} onChange={e => update('cost', e.target.value)} required /></label>
      <label>Conversation retention (days)<input name="retention" type="number" min="1" max="365" value={value.retention} onChange={e => update('retention', e.target.value)} required /><small>Conversation text expires; structured results remain.</small></label>
    </div><button className="primary settings-save" type="submit" disabled={!dirty || busy}>{pending.current ? 'Saving…' : 'Save settings'}</button></fieldset></form>
  </section>;
}

export default function SettingsView(props: Props) {
  const { readiness, busy, simulator, modeLocked, scenario, onModeChange, onScenarioChange, onRefresh } = props;
  return <section className="settings-view" aria-labelledby="settings-title">
    <div className="page-heading"><p className="eyebrow">Make Zeus your own</p><h2 id="settings-title">Settings</h2><p className="settings-description">Manage calling, your agent and defaults. Each section saves separately.</p></div>
    <div className="settings-layout"><nav className="settings-nav" aria-label="Settings sections">
      <a href="#settings-calls">Calling</a><a href="#settings-agent">LLM agent</a><a href="#settings-personal">Personal details</a><a href="#settings-storage">Limits &amp; storage</a><a href="#settings-readiness">Provider readiness</a>
    </nav><div className="settings-sections">
      <section id="settings-calls" className="settings-card" aria-labelledby="calling-title"><h3 id="calling-title" className="settings-group-title">Calling</h3>
        <fieldset className="mb-6" disabled={modeLocked || busy}><legend className="section-title">Call mode</legend><div className="segmented-control">
          <button type="button" className="secondary template-chip" aria-pressed={simulator} onClick={() => onModeChange(true)}>Simulator</button><button type="button" className="secondary template-chip" aria-pressed={!simulator} onClick={() => onModeChange(false)}>Backend</button>
        </div><p className="mt-3 text-base text-stone-300">{modeLocked ? 'Finish or resolve the current call attempt before switching modes.' : simulator ? 'Scripted calls on this device. No number is dialed.' : readiness?.capabilities.some(c => c.name === 'mock_relay' && c.enabled) ? readiness.capabilities.some(c => c.name === 'dialogue_integration' && c.ready) ? 'Local mock conversations use the configured dialogue engine. Answer at localhost:8080. No real number is dialed.' : 'Reviewed mock calls need a ready dialogue engine. Check Provider readiness below.' : 'Backend scripted simulation. No number is dialed and results are synthetic.'}</p></fieldset>
        {simulator && <label className="mb-6">Simulated outcome<select aria-label="Simulated outcome" disabled={modeLocked || busy} value={scenario} onChange={e => onScenarioChange(e.target.value as Scenario)}>{Object.entries(scenarios).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
        <CallEngineSettings locked={modeLocked || busy} onSaved={onRefresh} />
      </section>
      <div id="settings-agent" className="settings-card"><LlmAgentSettings locked={modeLocked || busy} onSaved={onRefresh} /></div>
      <PersonalDefaults {...props} /><LimitsDefaults {...props} />
      <details id="settings-readiness" className="settings-card"><summary className="section-title cursor-pointer">Provider readiness</summary>
        <p>{readiness ? (readiness.mode === 'simulator' ? 'Simulator' : 'Real-call backend') + ' · ' + (readiness.ready ? 'Ready' : 'Not ready') : 'Backend readiness unavailable'}</p>
        <p className="my-3 text-base">Voice engine: {readiness?.voiceEngine?.replaceAll('_', ' ') ?? 'Not active'}</p>
        <ul className="readiness-checks">{readiness?.checks.map(check => <li key={check.name}><strong className="capitalize">{check.name}</strong><span className="status-badge">{check.status.replaceAll('_', ' ')}</span><p>{check.message}</p></li>)}</ul>
        <button type="button" className="secondary mt-4" disabled={busy} onClick={onRefresh}>Check readiness again</button>
        <p className="mt-4 text-base text-stone-300">Readiness does not run a paid model request. Credentials stay on the server.</p>
      </details>
    </div></div>
  </section>;
}
