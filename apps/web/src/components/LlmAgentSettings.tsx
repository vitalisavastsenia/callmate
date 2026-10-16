import { useEffect, useState } from 'react';
import { llmModels, llmEfforts, UpdateLlmSettingsSchema, type LlmProvider, type LlmEffort, type LlmSettings } from '@callmate/contracts';
import { getLlmSettings, updateLlmSettings } from '../api';

type KeyAction = 'keep' | 'replace' | 'remove';
export default function LlmAgentSettings({ locked, onSaved }: { locked: boolean; onSaved: () => void }) {
  const [saved, setSaved] = useState<LlmSettings | null>(null);
  const [provider, setProvider] = useState<LlmProvider>('disabled');
  const [model, setModel] = useState(''); const [effort, setEffort] = useState<LlmEffort>('default');
  const [actions, setActions] = useState<Record<'openai' | 'anthropic', KeyAction>>({ openai: 'keep', anthropic: 'keep' });
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true; setLoading(true); setError(''); setSaved(null);
    void getLlmSettings().then(value => {
      if (!current) return;
      setSaved(value); setProvider(value.provider); setModel(value.model ?? ''); setEffort(value.effort);
      setActions({ openai: 'keep', anthropic: 'keep' });
    }, () => { if (current) setError('Could not load LLM agent settings. Check the backend and sign-in session, then retry.'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [reload]);
  useEffect(() => {
    if (locked || !saved || saved.editable) return;
    let current = true;
    void getLlmSettings().then(value => { if (current) setSaved(previous => previous ? { ...previous, editable: value.editable } : previous); }, () => {});
    return () => { current = false; };
  }, [locked, saved?.editable]);
  const disabled = locked || loading || saving || !saved || !saved.editable;
  const updateModel = (next: string, nextProvider = provider) => {
    setModel(next); if (!llmEfforts(nextProvider, next || null).includes(effort)) setEffort('default');
  };
  const dirty = !!saved && (provider !== saved.provider || (model.trim() || null) !== saved.model || effort !== saved.effort || Object.values(actions).some(action => action !== 'keep'));
  return <section className="space-y-4" aria-labelledby="llm-agent-title">
    <div className="settings-card-heading"><h3 id="llm-agent-title" className="section-title">LLM agent</h3>{saved && <span className="settings-save-state" role="status">{dirty ? 'Unsaved changes' : 'Up to date'}</span>}</div>
    <p className="text-base text-stone-300">Used for Backend conversations in every supported language. API providers bill your account separately. Saving settings does not send a model request.</p>
    {loading && <p role="status">Loading LLM settings…</p>}
    {error && <p role="alert" className="notice error">{error}</p>}
    {message && <p role="status" className="notice">{message}</p>}
    {(locked || saved && !saved.editable) && <p className="notice">Finish the active call before changing the agent or API keys.</p>}
    {!loading && !saved && <button type="button" className="secondary" onClick={() => setReload(value => value + 1)}>Retry LLM settings</button>}
    {saved && <form autoComplete="off" onSubmit={async event => {
      event.preventDefault(); if (disabled || !dirty) return;
      const form = event.currentTarget, data = new FormData(form);
      const apiKeys: Partial<Record<'openai' | 'anthropic', string | null>> = {};
      for (const key of ['openai', 'anthropic'] as const) {
        if (actions[key] === 'replace') apiKeys[key] = String(data.get(`${key}-key`) ?? '');
        if (actions[key] === 'remove') apiKeys[key] = null;
      }
      const result = UpdateLlmSettingsSchema.safeParse({ provider, model: model.trim() || null, effort, apiKeys });
      if (!result.success) { setError('Check the model, supported effort and replacement API keys.'); return; }
      setSaving(true); setError(''); setMessage('');
      try {
        const value = await updateLlmSettings(result.data); setSaved(value); setActions({ openai: 'keep', anthropic: 'keep' });
        setMessage('LLM agent saved. Settings apply to the next Backend call.'); onSaved();
      } catch { setError('Could not save LLM settings. Check the backend, active calls and secret storage, then retry. Re-enter replacement keys.'); }
      finally {
        // Keep plaintext only in the password input for the duration of this command.
        form.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach(input => { input.value = ''; });
        setSaving(false);
      }
    }}><fieldset disabled={disabled} className="space-y-4">
      <div className="form-grid share-grid">
        <label>LLM provider<select value={provider} onChange={event => {
          const next = event.target.value as LlmProvider; setProvider(next); setEffort('default');
          updateModel(next === 'codex' || next === 'disabled' ? '' : llmModels[next][0] ?? '', next);
        }}><option value="disabled">Disabled</option><option value="codex">Codex CLI · ChatGPT login</option><option value="openai">Codex / OpenAI API</option><option value="anthropic">Claude API</option></select></label>
        {provider !== 'disabled' && <>
          <label>Agent model<input aria-label="Agent model" aria-describedby="llm-model-help" list="llm-model-options" value={model} maxLength={200} required={provider !== 'codex'} onChange={event => updateModel(event.target.value)} placeholder={provider === 'codex' ? 'CLI default (optional)' : 'Select or enter a model ID'} />
            <datalist id="llm-model-options">{llmModels[provider].map(id => <option key={id} value={id} />)}</datalist>
            <small id="llm-model-help">Suggestions depend on your account access. Custom model IDs use provider-default effort.</small></label>
          <label>Reasoning effort<select aria-label="Reasoning effort" aria-describedby="llm-effort-help" value={effort} onChange={event => setEffort(event.target.value as LlmEffort)}>{llmEfforts(provider, model || null).map(value => <option key={value} value={value}>{value === 'default' ? 'Provider default' : value}</option>)}</select><small id="llm-effort-help">Higher effort can increase response time and API cost.</small></label>
        </>}
      </div>
      {provider === 'disabled' && <p className="notice">LLM agent is disabled. Reviewed Backend mock calls need a configured agent. Select an API provider and add your key, or use Codex CLI with its Docker image and your login.</p>}
      {(provider === 'openai' || provider === 'anthropic') && !saved.credentials[provider].configured && <p className="notice">Add your {provider === 'openai' ? 'OpenAI' : 'Claude'} API key below, choose a model available to your account, and save the LLM agent.</p>}
      {provider === 'codex' && <p className="text-base">Uses the server’s saved ChatGPT login. The default Docker image does not include Codex CLI: use compose.codex.yaml and initialize your login using scripts/setup-codex-login.sh. Select Codex CLI here and save; choosing it does not install the CLI or sign you in. See docs/docker-development.md, section 17, for setup and device login.</p>}
      <fieldset className="space-y-4"><legend className="section-title">API keys</legend>
        <p className="text-base text-stone-300">Keys are encrypted on the server and never returned here or saved in browser storage.</p>
        {(['openai', 'anthropic'] as const).map(key => {
          const credential = saved.credentials[key], label = key === 'openai' ? 'OpenAI' : 'Claude';
          const fields = <div className="space-y-2">
            <label>{label} API key<select aria-label={`${label} API key action`} value={actions[key]} onChange={event => setActions(previous => ({ ...previous, [key]: event.target.value as KeyAction }))}>
              <option value="keep">Keep current key</option><option value="replace">{credential.configured ? 'Replace' : 'Add'} key</option>{credential.source === 'stored' && <option value="remove">Delete stored key</option>}
            </select></label>
            <p className="text-base">{credential.configured ? `${credential.source === 'stored' ? 'Encrypted key saved' : 'Provided by server environment'}${credential.usable ? '' : ' · unavailable: check secret storage'}` : 'No key configured'}</p>
            {actions[key] === 'replace' && <label>New {label} API key<input name={`${key}-key`} type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none" maxLength={512} required /></label>}
            {actions[key] === 'remove' && <p className="text-base">The stored key will be deleted when you save. Any key supplied by the server environment remains available.</p>}
          </div>;
          return provider === key ? <div key={key}>{fields}</div> : <details className="other-provider-key" key={key}><summary>{label} key · {credential.configured ? 'Configured' : 'Not configured'}{actions[key] !== 'keep' ? ' · Unsaved changes' : ''}</summary>{fields}</details>;
        })}
      </fieldset>
      <button type="submit" className="primary settings-save" disabled={!dirty}>{saving ? 'Saving LLM agent…' : 'Save LLM agent'}</button>
    </fieldset></form>}
  </section>;
}
