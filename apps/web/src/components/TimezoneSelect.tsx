const timeZones = ['UTC', ...Intl.supportedValuesOf('timeZone')];

export default function TimezoneSelect({ label, value, onChange }: {
  label: string; value: string; onChange: (value: string) => void;
}) {
  // Keep saved IANA aliases selectable even when Intl lists their canonical name.
  const options = [...new Set([...timeZones, value])].filter(Boolean).sort();
  return <label>{label}<select required aria-label={label} value={value} onChange={e => onChange(e.target.value)}>
    {options.map(zone => <option key={zone} value={zone}>{zone.replaceAll('_', ' ')}</option>)}
  </select></label>;
}
