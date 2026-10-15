import { useState } from 'react';
import { SettingsSchema, TimeZoneSchema, scenarios, type Readiness, type Scenario, type Settings } from '../types';
import type { RequestDefaults } from '../preferences';

interface Props {
  readiness: Readiness | null; settings: Settings; defaults: RequestDefaults; busy: boolean;
  simulator: boolean; modeLocked: boolean; scenario: Scenario;
  onModeChange: (simulator: boolean) => void; onScenarioChange: (scenario: Scenario) => void;
  onRefresh: () => void; onSave: (settings: Settings, defaults: RequestDefaults) => void;
}
export default function SettingsView({ readiness, settings, defaults, busy, simulator, modeLocked, scenario, onModeChange, onScenarioChange, onRefresh, onSave }: Props) {
  const [error, setError] = useState('');
  return <section className="panel settings-view"><h2>Settings</h2>
    <fieldset className="mb-6" disabled={modeLocked || busy}><legend className="section-title">Call mode</legend><div className="flex flex-wrap gap-2">
      <button type="button" className="secondary template-chip" aria-pressed={simulator} onClick={() => onModeChange(true)}>Simulator</button>
      <button type="button" className="secondary template-chip" aria-pressed={!simulator} onClick={() => onModeChange(false)}>Live</button>
    </div><p className="mt-3 text-base text-stone-300">{modeLocked ? 'Finish or resolve the current call attempt before switching modes.' : simulator ? 'Scripted calls on this device. No number is dialed.' : 'Real calls require a ready backend and your approval of the plan.'}</p></fieldset>
    {simulator && <label className="mb-6">Simulated outcome<select aria-label="Simulated outcome" disabled={modeLocked || busy} value={scenario} onChange={e => onScenarioChange(e.target.value as Scenario)}>{Object.entries(scenarios).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
    {error && <p role="alert" className="notice error">{error}</p>}
    <form noValidate onSubmit={e => {
      e.preventDefault(); const data = new FormData(e.currentTarget);
      const result = SettingsSchema.safeParse({ defaultCallLimits: { maxDurationSeconds: Number(data.get('duration')) * 60, maxEstimatedCost: { amountMinor: Math.round(Number(data.get('cost')) * 100), currency: 'EUR' } }, transcriptRetentionDays: Number(data.get('retention')) });
      const next: RequestDefaults = { name: String(data.get('name')).trim(), phone: String(data.get('phone')).trim(), email: String(data.get('email')).trim(), timeZone: String(data.get('zone')).trim() };
      if (!result.success || !TimeZoneSchema.safeParse(next.timeZone).success || !String(data.get('duration')).trim() || !/^\d+(?:\.\d{1,2})?$/.test(String(data.get('cost'))) || next.name.length > 200 || (next.phone && !/^\+[1-9]\d{7,14}$/.test(next.phone)) || (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email))) {
        setError('Check the timezone, contact details, duration (0.5–10 minutes), EUR cost (up to two decimal places), and retention (1–365 days).'); return;
      }
      setError(''); onSave(result.data, next);
    }}><fieldset disabled={busy} className="space-y-6">
      <fieldset><legend className="section-title">Default details Zeus may share</legend><p className="mb-3 text-base text-stone-300">Remembered on this device. You can edit or withhold each detail in a request.</p><div className="form-grid share-grid">
        <label>Default name<input name="name" maxLength={200} defaultValue={defaults.name} /></label>
        <label>Default callback number<input name="phone" type="tel" defaultValue={defaults.phone} placeholder="+34…" /></label>
        <label>Default email<input name="email" type="email" maxLength={320} defaultValue={defaults.email} /></label>
      </div></fieldset>
      <fieldset><legend className="section-title">Default advanced settings</legend><div className="form-grid share-grid">
        <label>Default timezone<input name="zone" defaultValue={defaults.timeZone} required /></label>
        <label>Default maximum call duration (minutes)<input name="duration" type="number" min="0.5" max="10" step="0.5" defaultValue={settings.defaultCallLimits.maxDurationSeconds / 60} required /></label>
        <label>Default maximum call cost (EUR)<input name="cost" type="number" min="0" step="0.01" defaultValue={settings.defaultCallLimits.maxEstimatedCost.currency === 'EUR' ? settings.defaultCallLimits.maxEstimatedCost.amountMinor / 100 : ''} required /></label>
        <label>Conversation retention (days)<input name="retention" type="number" min="1" max="365" defaultValue={settings.transcriptRetentionDays} required /></label>
      </div></fieldset><button className="primary" type="submit">{busy ? 'Saving…' : 'Save settings'}</button>
    </fieldset></form>
    <details className="mt-6"><summary className="section-title cursor-pointer">Provider readiness</summary>
      <p>{readiness ? (readiness.mode === 'simulator' ? 'Simulator' : 'Real-call backend') + ' · ' + (readiness.ready ? 'Ready' : 'Not ready') : 'Backend readiness unavailable'}</p>
      <p className="my-3 text-base">Voice engine: {readiness?.voiceEngine?.replaceAll('_', ' ') ?? 'Not active'}</p>
      <ul className="space-y-2">{readiness?.checks.map(check => <li key={check.name}><strong className="capitalize">{check.name}</strong>: {check.status.replaceAll('_', ' ')} · {check.message}</li>)}</ul>
      <button type="button" className="secondary mt-4" disabled={busy} onClick={onRefresh}>Check readiness again</button>
      <p className="mt-4 text-base text-stone-300">The backend enforces real-call limits and retention. Credentials stay in the backend environment. Structured request details remain after conversation text expires.</p>
    </details>
  </section>;
}
