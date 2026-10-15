import { useId, useState } from 'react';
import { normalizePhone } from '../contacts';

const codes = [['+34', 'ES'], ['+1', 'US/CA'], ['+44', 'GB'], ['+33', 'FR'], ['+49', 'DE'], ['+39', 'IT'], ['+351', 'PT'], ['+31', 'NL'], ['+380', 'UA'], ['+48', 'PL'], ['+7', 'RU/KZ']] as const;
export default function PhoneField({ value, onChange, compact = false, showErrors = false, deferErrors = false, phoneLabel = 'Phone number' }: { value: string; onChange: (value: string) => void; compact?: boolean; showErrors?: boolean; deferErrors?: boolean; phoneLabel?: string }) {
  const helpId = useId();
  const [touched, setTouched] = useState(false);
  const code = codes.find(([prefix]) => value.startsWith(prefix))?.[0] ?? '';
  const local = code ? value.slice(code.length) : value;
  let invalid = false;
  try { normalizePhone(value, ''); } catch { invalid = deferErrors ? touched || showErrors : !!local || showErrors; }
  return <div className={'phone-field' + (compact ? ' phone-field-compact' : '')}>
    <label>Country code<select aria-label="Country code" value={code} onChange={e => onChange(e.target.value + (code ? value.slice(code.length) : ''))}>
      {codes.map(([prefix, name]) => <option key={prefix} value={prefix}>{name} {prefix}</option>)}<option value="">Other (full number)</option>
    </select></label>
    <label>{phoneLabel}<input aria-label={phoneLabel} placeholder="985 12 34 56" type="tel" autoComplete="tel-national" value={local} onBlur={() => setTouched(true)} onChange={e => {
      const text = e.target.value.replace(/[\s().-]/g, '');
      onChange(text.startsWith('00') ? '+' + text.slice(2) : text.startsWith('+') ? text : code + text);
    }} required aria-invalid={invalid || undefined} aria-describedby={invalid ? helpId : undefined} />{invalid && <small id={helpId} className="field-error">{!local ? 'Enter a phone number' : 'Enter a valid phone number'}</small>}</label>
  </div>;
}
