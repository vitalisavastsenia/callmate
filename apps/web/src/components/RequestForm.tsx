import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { RequestDraftSchema, TimeZoneSchema, requestLabels, type RequestDraft, type RequestPrefill, type Scenario, type Settings } from '../types';
import { localDateInZone, nextTuesday, resolveTime } from '../time';
import { isMockMode, parseGoal } from '../api';
import { readRequestDefaults, type RequestDefaults } from '../preferences';
import ContactPicker, { ToneFields } from './ContactPicker';
import { contactsService, countryTimeZone, normalizePhone, type Contact, type ContactDetails } from '../contacts';
import { RequestDetails } from './CallViews';

interface Props { initial?: RequestDraft | undefined; prefill?: RequestPrefill; view: 'home' | 'request'; onRequest: (message?: string) => void; settings: Settings; defaults: RequestDefaults; approvalPending?: boolean; busy: boolean; locked: boolean; initialPrepared?: boolean; callDisabled: boolean; callHelp: ReactNode; flow?: ReactNode; scenario: Scenario; onScenarioChange: (scenario: Scenario) => void; onCall: (request: RequestDraft) => void }
type Kind = NonNullable<RequestDraft['requestType']>;
type WindowInput = { date: string; start: string; end: string; occurrence: string };
const emptyWindow = (): WindowInput => ({ date: '', start: '', end: '', occurrence: '' });
const approvalRules = ['Different day or time', 'Price above my limit', 'Any deposit or prepayment', 'Sharing extra personal data', 'Anything not in my request'];
interface FormValues {
  kind: Kind | ''; business: string; phone: string; zone: string; goal: string;
  service: string; name: string; maximum: string; authority: string; unknown: boolean;
  questions: string[]; canDecide: string[]; mustAsk: string[]; change: string; reference: string;
  sharePhone: string; shareEmail: string; duration: string; cost: string; windows: WindowInput[];
  tone: string[]; toneNotes: string;
}
function emptyForm(settings: Settings): FormValues {
  const contact = readRequestDefaults();
  return { kind: '', business: '', phone: '+34', zone: contact.timeZone, goal: '', service: '', name: contact.name, maximum: '',
    authority: 'ask_before_accepting', unknown: false, questions: [], canDecide: [], mustAsk: [], change: '', reference: '',
    sharePhone: contact.phone, shareEmail: contact.email, tone: [], toneNotes: '', duration: String(settings.defaultCallLimits.maxDurationSeconds / 60),
    cost: settings.defaultCallLimits.maxEstimatedCost.currency === 'EUR' ? String(settings.defaultCallLimits.maxEstimatedCost.amountMinor / 100) : '2', windows: [emptyWindow()] };
}
function fromRequest(r: RequestDraft, settings: Settings): FormValues {
  return { ...emptyForm(settings), kind: r.requestType ?? 'book', business: r.business.name, phone: r.business.phone,
    zone: r.timeZone ?? r.availability[0]?.start.timeZone ?? 'Europe/Madrid', goal: r.goal ?? 'Book ' + r.service + ' within my approved availability and price policy.',
    service: r.service, name: r.bookingName, maximum: r.pricePolicy.maximum ? String(r.pricePolicy.maximum.amountMinor / 100) : '',
    authority: r.bookingAuthority, unknown: r.pricePolicy.allowUnknownPrice, questions: r.questions ?? [],
    canDecide: r.boundaries?.canDecideAlone ?? [], mustAsk: r.boundaries?.mustAskMe ?? [],
    change: r.changeRequest?.description ?? '', reference: r.changeRequest?.bookingReference ?? '',
    sharePhone: r.shareableContact.phone ?? '', shareEmail: r.shareableContact.email ?? '', tone: r.tone ?? [], toneNotes: r.tone_notes ?? '', duration: String(r.callLimits.maxDurationSeconds / 60),
    cost: r.callLimits.maxEstimatedCost.currency === 'EUR' ? String(r.callLimits.maxEstimatedCost.amountMinor / 100) : '',
    windows: r.availability.length ? r.availability.map(w => ({ date: w.start.localDate, start: w.start.localTime, end: w.end.localTime,
      occurrence: Date.parse(resolveTime(w.start.localDate, w.start.localTime, w.start.timeZone, 'earlier').instant) === Date.parse(w.start.instant) ? 'earlier' : 'later' })) : [emptyWindow()] };
}
function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" className="icon-button" aria-label={label} title={label} onClick={onClick}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
  </button>;
}
function SectionCard({ step, title, children }: { step: number; title: string; children: ReactNode }) {
  const id = useId();
  return <section className="request-card" aria-labelledby={id}><h3 id={id} className="request-card-title"><span className="request-step" aria-hidden="true">{step}</span>{title}</h3><div className="request-card-body">{children}</div></section>;
}
function ListEditor({ title, singular, items, onChange, autoFilled = false, showErrors = false }: { title: string; singular: string; items: string[]; onChange: (items: string[]) => void; autoFilled?: boolean; showErrors?: boolean }) {
  const [touched, setTouched] = useState<Set<number>>(new Set());
  return <fieldset data-auto-filled={autoFilled || undefined} aria-describedby={autoFilled ? 'auto-fill-help' : undefined}><legend className="section-title">{title}{autoFilled && <span className="auto-fill-badge">Auto-filled</span>}</legend>
    {items.map((item, i) => <div key={i} className="mb-3 flex items-end gap-2">
      <label className="min-w-0 flex-1">{singular} {i + 1}<input value={item} maxLength={4000} required aria-invalid={(showErrors || touched.has(i)) && !item.trim() || undefined} onBlur={() => setTouched(old => new Set(old).add(i))} onChange={e => onChange(items.map((v, n) => n === i ? e.target.value : v))} /></label>
      <RemoveButton label={'Remove ' + singular.toLowerCase() + ' ' + (i + 1)} onClick={() => { setTouched(old => new Set([...old].filter(n => n !== i).map(n => n > i ? n - 1 : n))); onChange(items.filter((_, n) => n !== i)); }} />
    </div>)}
    <button type="button" className="text-add" disabled={items.length >= 30} onClick={() => onChange([...items, ''])}>+ Add {singular.toLowerCase()}</button>
  </fieldset>;
}
function BoundaryTags({ title, singular, items, suggestions, autoFilled, onChange, showErrors }: { title: string; singular: string; items: string[]; suggestions: string[]; autoFilled: boolean; onChange: (items: string[]) => void; showErrors: boolean }) {
  const [touched, setTouched] = useState<Set<number>>(new Set());
  return <fieldset data-auto-filled={autoFilled || undefined}><legend className="boundary-title">{title}</legend>
    <div className="boundary-tags">{items.map((text, i) => <div className="boundary-tag" key={i}>
      <input aria-label={`${singular} ${i + 1}`} value={text} maxLength={4000} required placeholder="Your rule…" aria-invalid={(showErrors || touched.has(i)) && !text.trim() || undefined} onBlur={() => setTouched(old => new Set(old).add(i))} style={{ width: `${Math.min(38, Math.max(12, text.length + 1))}ch` }} onChange={e => onChange(items.map((value, n) => n === i ? e.target.value : value))} />
      <RemoveButton label={`Remove ${singular.toLowerCase()} ${i + 1}`} onClick={() => { setTouched(old => new Set([...old].filter(n => n !== i).map(n => n > i ? n - 1 : n))); onChange(items.filter((_, n) => n !== i)); }} />
    </div>)}</div>
    <div className="boundary-suggestions" aria-label={singular === 'Allowed decision' ? 'Quick allowed decisions' : 'Quick approval boundaries'}>{suggestions.filter(text => !items.some(item => item.trim().toLowerCase() === text.toLowerCase())).map(text => <button key={text} type="button" className="suggestion-chip" disabled={items.length >= 30} onClick={() => onChange([...items, text])}>+ {text}</button>)}
      <button type="button" className="text-add" disabled={items.length >= 30} onClick={() => onChange([...items, ''])}>+ Add custom…</button>
    </div>
  </fieldset>;
}
export default function RequestForm({ initial, prefill, view, onRequest, settings, defaults, approvalPending, busy, locked, initialPrepared = false, callDisabled, callHelp, flow, onCall }: Props) {
  const validationId = useId();
  const [v, setValues] = useState<FormValues>(() => initial ? fromRequest(initial, settings) : { ...emptyForm(settings), goal: prefill?.goal ?? '', kind: prefill?.requestType ?? '' });
  const [reviewedRequest, setReviewedRequest] = useState<RequestDraft | null>(initialPrepared && initial ? initial : null);
  const [prepareCheck, setPrepareCheck] = useState<{ failed: boolean } | null>(null);
  const [contacts, setContacts] = useState(() => contactsService.list());
  const [selectedId, setSelectedId] = useState<string | null>(initial?.contact_id ?? null);
  const [saveContact, setSaveContact] = useState(false);
  const [zoneEdited, setZoneEdited] = useState(!!initial);
  const selectedContact = contacts.find(c => c.id === selectedId);
  const planSection = useRef<HTMLElement>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const touch = (path: string) => setTouched(old => new Set(old).add(path));
  const reviewBar = useRef<HTMLDivElement>(null);
  const [reviewBarHeight, setReviewBarHeight] = useState(0);
  useEffect(() => {
    const bar = reviewBar.current;
    if (!bar) return;
    const observer = new ResizeObserver(() => setReviewBarHeight(bar.getBoundingClientRect().height));
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);
  const previousDefaults = useRef({ ...defaults, duration: String(settings.defaultCallLimits.maxDurationSeconds / 60), cost: String(settings.defaultCallLimits.maxEstimatedCost.amountMinor / 100) });
  useEffect(() => {
    const next = { ...defaults, duration: String(settings.defaultCallLimits.maxDurationSeconds / 60), cost: settings.defaultCallLimits.maxEstimatedCost.currency === 'EUR' ? String(settings.defaultCallLimits.maxEstimatedCost.amountMinor / 100) : '2' };
    const old = previousDefaults.current;
    if (!initial) setValues(v => ({ ...v,
      name: v.name === old.name ? next.name : v.name, sharePhone: v.sharePhone === old.phone ? next.phone : v.sharePhone,
      shareEmail: v.shareEmail === old.email ? next.email : v.shareEmail, zone: !zoneEdited && v.zone === old.timeZone ? next.timeZone : v.zone,
      duration: v.duration === old.duration ? next.duration : v.duration, cost: v.cost === old.cost ? next.cost : v.cost }));
    previousDefaults.current = next;
  }, [defaults, settings]);
  useEffect(() => { if (reviewedRequest && !flow) { planSection.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }); planSection.current?.focus({ preventScroll: true }); } }, [reviewedRequest]);
  const [autoFields, setAutoFields] = useState<Set<string>>(new Set());
  const [parsing, setParsing] = useState(false);
  const [parseNotes, setParseNotes] = useState<string[]>([]);
  const [parsedSource, setParsedSource] = useState('');
  const auto = (field: string) => ({ 'data-auto-filled': autoFields.has(field) || undefined, 'aria-describedby': autoFields.has(field) ? 'auto-fill-help' : undefined });
  const badge = (field: string) => autoFields.has(field) ? <span className="auto-fill-badge">Auto-filled</span> : null;
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues(old => ({ ...old, [key]: value }));
    setReviewedRequest(null);
    if (key === 'zone') setZoneEdited(true);
    setAutoFields(old => { const next = new Set(old); next.delete(key); if (key === 'windows') for (const k of ['date', 'start', 'end']) next.delete(k); return next; });
  };
  const contactDetails: ContactDetails = { name: v.business, phone: v.phone, timeZone: v.zone, tone: v.tone, notes: v.toneNotes };
  let normalizedPhone = '';
  try { normalizedPhone = normalizePhone(v.phone, ''); } catch { /* Keep incomplete input editable. */ }
  const homeMissing = [!v.goal.trim() && 'a goal', !v.business.trim() && 'a name', !normalizedPhone && 'a valid phone number'].filter(Boolean);
  function chooseContact(contact: Contact | null) {
    setSelectedId(contact?.id ?? null); setSaveContact(false); setReviewedRequest(null);
    if (contact) {
      setValues(old => ({ ...old, business: contact.name, phone: contact.phone, zone: contact.timeZone, tone: contact.tone, toneNotes: contact.notes }));
      setZoneEdited(true);
    }
  }
  function changeContact(value: ContactDetails) {
    setReviewedRequest(null);
    if (value.phone !== v.phone && contacts.some(c => c.phone === value.phone)) setSaveContact(false);
    setValues(old => ({ ...old, business: value.name, phone: value.phone, tone: value.tone, toneNotes: value.notes,
      zone: value.phone !== old.phone && !zoneEdited ? countryTimeZone(value.phone) ?? old.zone : old.zone }));
  }
  function reviewedWithContact(request: RequestDraft): RequestDraft {
    if (!saveContact) return request;
    if (contacts.some(c => c.phone === request.business.phone)) return request;
    const contact = contactsService.save(contactDetails, selectedContact?.phone === v.phone ? selectedContact.id : undefined);
    setContacts(contactsService.list()); setSelectedId(contact.id); setSaveContact(false);
    return { ...request, contact_id: contact.id };
  }
  async function fillDetails() {
    setParsing(true); setErrors([]); setParseNotes([]);
    try {
      const phones = [...v.goal.matchAll(/\+\d[\d ().-]{6,}\d/g)];
      const statedPhone = phones.length === 1 ? phones[0]![0].replace(/[\s().-]/g, '') : undefined;
      const matched = contacts.filter(c => {
        const index = v.goal.toLocaleLowerCase().indexOf(c.name.toLocaleLowerCase());
        const named = c.name.length > 1 && index >= 0 && /\b(?:call|contact|phone|at)\s+["“]?$/i.test(v.goal.slice(0, index))
          && /^(?:["”])?(?:\s+(?:and|to|on|at)\b|[,.!?;]|$)/i.test(v.goal.slice(index + c.name.length));
        return named || c.phone === statedPhone;
      });
      const contact = matched.length === 1 && !v.business.trim() ? matched[0] : undefined;
      const inferredZone = !zoneEdited && !normalizedPhone && phones.length === 1 ? countryTimeZone(phones[0]![0]) : undefined;
      const result = await parseGoal(v.goal, { timeZone: contact?.timeZone ?? inferredZone ?? v.zone, ...(view === 'request' && v.kind ? { requestType: v.kind } : {}) });
      const next = { ...v, windows: v.windows.map(w => ({ ...w })) };
      if (contact) { next.business = contact.name; next.phone = contact.phone; next.zone = contact.timeZone; next.tone = contact.tone; next.toneNotes = contact.notes; setSelectedId(contact.id); setZoneEdited(true); }
      if (result.businessName && !next.business.trim()) {
        next.business = result.businessName;
      }
      if (result.businessPhone && (!next.phone || next.phone === '+34')) {
        next.phone = result.businessPhone; if (!zoneEdited) next.zone = countryTimeZone(next.phone) ?? next.zone;
      }
      if (!next.tone.length && result.tone) next.tone = result.tone;
      // Regeneration replaces previous suggestions, but preserves every manual edit.
      for (const key of ['service', 'maximum', 'change', 'reference'] as const) if (autoFields.has(key)) next[key] = '';
      for (const key of ['questions', 'canDecide', 'mustAsk'] as const) if (autoFields.has(key)) next[key] = [];
      if (!next.windows.length) next.windows = [emptyWindow()];
      for (const key of ['date', 'start', 'end'] as const) if (autoFields.has(key)) next.windows[0]![key] = '';
      const filled = new Set<string>();
      const kept: string[] = [];
      next.kind = result.requestType; filled.add('kind');
      function text(key: 'service' | 'maximum' | 'change' | 'reference', value: string | undefined, label: string) {
        if (!value) return;
        if (next[key]) { if (next[key] !== value) kept.push(label); return; }
        next[key] = value; filled.add(key);
      }
      if (next.kind === 'book') { text('service', result.service, 'service'); text('maximum', result.maximumPriceEur, 'price limit'); }
      if (next.kind === 'change') { text('change', result.changeDescription, 'change instructions'); text('reference', result.bookingReference, 'booking reference'); }
      for (const [key, items] of [['questions', next.kind === 'ask' ? result.questions : undefined], ['canDecide', result.canDecideAlone], ['mustAsk', result.mustAskMe]] as const) {
        if (!items?.length) continue;
        if (next[key].some(item => item.trim())) { kept.push(key === 'questions' ? 'questions' : key === 'canDecide' ? 'allowed decisions' : 'approval boundaries'); continue; }
        next[key] = [...items]; filled.add(key);
      }
      if (result.availability && (next.kind === 'book' || next.kind === 'change')) {
        for (const key of ['date', 'start', 'end'] as const) {
          const value = result.availability[key];
          if (!value) continue;
          if (next.windows[0]![key]) { if (next.windows[0]![key] !== value) kept.push('availability ' + key); continue; }
          next.windows[0]![key] = value; filled.add(key);
        }
      }
      setValues(next); setAutoFields(filled); setParsedSource(v.goal);
      setParseNotes([...result.notes, ...(kept.length ? ['Kept your existing ' + kept.join(', ') + '. Check these against the goal.'] : [])]);
      return true;
    } catch (error) { setErrors([error instanceof Error ? error.message : 'Could not fill details. You can enter them manually.']); return false; }
    finally { setParsing(false); }
  }
  function template(kind: 'book' | 'ask' | 'change') {
    setSelectedId(null); setSaveContact(false); setReviewedRequest(null); setZoneEdited(false);
    const base = emptyForm(settings);
    const common = { ...base, kind, phone: '+12025550123', name: v.name, sharePhone: v.sharePhone, shareEmail: v.shareEmail,
      mustAsk: ['Ask me before accepting fees, commitments, or anything outside this request.'] };
    const windows = [{ date: nextTuesday(base.zone), start: '17:00', end: '19:00', occurrence: '' }];
    setValues(kind === 'book' ? { ...common, business: 'Example barbershop', goal: 'Book a haircut next Tuesday between 5 and 7 pm, for no more than 30 euros. Do not accept a deposit.', service: 'Haircut', maximum: '30', authority: 'within_constraints', windows,
      canDecide: ['Choose a slot within my availability and maximum price.'], mustAsk: [] }
      : kind === 'ask' ? { ...common, business: 'Example clinic', goal: 'Find out which documents I need for my first visit. Do not book an appointment.',
        questions: ['Which documents should I bring to my first visit?', 'Do I need a referral?'], canDecide: ['Ask follow-up questions to clarify the document requirements.'] }
      : { ...common, business: 'Example vet clinic', goal: 'Ask to reschedule my dog’s existing vet appointment to next Tuesday after 5 pm. Ask me before confirming a change.',
        change: 'Reschedule my dog’s existing vet visit to one of the new availability windows.', reference: 'VET-123', windows,
        canDecide: ['Ask about alternative times without changing the existing booking.'] });
    setErrors([]); setTouched(new Set()); setSubmitted(false); setAutoFields(new Set()); setParseNotes([]); setParsedSource('');
  }
  function updateWindow(index: number, field: keyof WindowInput, value: string) {
    setReviewedRequest(null);
    setValues(old => ({ ...old, windows: old.windows.map((w, i) => i === index ? { ...w, [field]: value } : w) }));
    if (index === 0) setAutoFields(old => { const next = new Set(old); next.delete(field); return next; });
  }
  const resolved = useMemo(() => {
    const availability: RequestDraft['availability'] = [];
    const issues: string[] = [];
    if (v.kind !== 'book' && v.kind !== 'change') return { availability, issues };
    if (!TimeZoneSchema.safeParse(v.zone).success) return { availability, issues };
    v.windows.forEach((w, i) => {
      if (v.kind === 'change' && !w.date && !w.start && !w.end) return;
      const missing = [!w.date && 'date', !w.start && 'start time', !w.end && 'end time'].filter(Boolean);
      if (missing.length) { issues.push(`Availability ${i + 1}: add ${missing.join(', ')}.`); return; }
      try {
        availability.push({ start: resolveTime(w.date, w.start, v.zone, w.occurrence), end: resolveTime(w.date, w.end, v.zone, w.occurrence) });
      } catch (error) { issues.push(`Availability ${i + 1}: ${error instanceof Error ? error.message : 'Check date and time.'}`); }
    });
    return { availability, issues };
  }, [v.kind, v.windows, v.zone]);
  const validation = useMemo(() => {
    const issues = [...resolved.issues];
    const fields: Record<string, string> = {};
    if (resolved.availability.some(w => Date.parse(w.start.instant) <= Date.now())) issues.push('Availability must start in the future in the destination timezone.');
    if (!v.duration.trim()) issues.push('Enter a maximum call duration in Advanced.');
    if (!v.cost.trim()) issues.push('Enter a maximum call cost in Advanced.');
    if (v.cost && !/^\d+(?:\.\d{1,2})?$/.test(v.cost)) issues.push('Call cost must be a non-negative EUR amount with at most two decimal places.');
    if (v.kind === 'book' && v.maximum && !/^\d+(?:\.\d{1,2})?$/.test(v.maximum)) issues.push('Service price must be a non-negative EUR amount with at most two decimal places.');
    const result = RequestDraftSchema.safeParse({
      requestType: v.kind, business: { name: v.business.trim(), phone: normalizedPhone }, timeZone: v.zone, goal: v.goal,
      tone: v.tone, tone_notes: v.toneNotes, ...(selectedContact?.phone === v.phone ? { contact_id: selectedContact.id } : {}),
      boundaries: { canDecideAlone: v.canDecide, mustAskMe: v.mustAsk }, questions: v.kind === 'ask' ? v.questions : [],
      changeRequest: v.kind === 'change' ? { description: v.change, bookingReference: v.reference } : null,
      service: v.kind === 'book' ? v.service : '', bookingName: v.name, availability: resolved.availability,
      pricePolicy: { maximum: v.kind === 'book' && v.maximum !== '' ? { amountMinor: Math.round(Number(v.maximum) * 100), currency: 'EUR' } : null, allowUnknownPrice: v.kind === 'book' && v.unknown },
      bookingAuthority: v.kind === 'book' ? v.authority : 'ask_before_accepting', shareableContact: { phone: v.sharePhone.trim() || null, email: v.shareEmail.trim() || null },
      callLimits: { maxDurationSeconds: Math.round(Number(v.duration) * 60), maxEstimatedCost: { amountMinor: Math.round(Number(v.cost) * 100), currency: 'EUR' } },
    });
    const labels: Record<string, string> = { requestType: 'Choose a request type.', 'business.name': 'Enter a business name.', 'business.phone': 'Enter a phone number',
      timeZone: 'Enter a valid IANA timezone.', goal: 'Describe your goal in English.', service: 'Enter the service to book.', questions: 'Add at least one question and complete every question.',
      'boundaries.canDecideAlone': 'Complete or remove empty allowed decisions.', 'boundaries.mustAskMe': 'Complete or remove empty approval boundaries.',
      'changeRequest.description': 'Describe what to change or cancel.', 'changeRequest.bookingReference': 'Keep the booking reference within 200 characters.', bookingName: 'Keep the approved name within 200 characters.',
      'shareableContact.phone': 'Enter a valid approved callback number, or leave it blank.', 'shareableContact.email': 'Enter a valid approved email, or leave it blank.',
      'callLimits.maxDurationSeconds': 'Set call duration to 0.5–10 minutes in Advanced settings.', 'callLimits.maxEstimatedCost': 'Set a valid non-negative EUR call cost in Advanced settings.',
      'pricePolicy.maximum': 'Set a valid non-negative EUR service price, or leave it blank.' };
    if (!result.success) for (const issue of result.error.issues) {
      const path = issue.path.join('.');
      // Incomplete windows already have a more helpful field-level message.
      if (path === 'availability' && resolved.issues.length) continue;
      const label = Object.keys(labels).find(key => path === key || path.startsWith(key + '.'));
      const message = label ? labels[label]! : path.startsWith('availability') ? 'Availability must have a date and an end after its start; add at least one window for booking.' : issue.message;
      issues.push(message); fields[label ?? path] = message;
    }
    for (const issue of issues) {
      if (/Availability/.test(issue)) fields.availability = issue;
      if (/call duration/.test(issue)) fields['callLimits.maxDurationSeconds'] = issue;
      if (/Call cost|maximum call cost/.test(issue)) fields['callLimits.maxEstimatedCost'] = issue;
      if (/Service price/.test(issue)) fields['pricePolicy.maximum'] = issue;
    }
    return { fields, issues: [...new Set(issues)], request: result.success && !issues.length ? result.data : null };
  }, [v, resolved, selectedContact, normalizedPhone]);
  const showError = (path: string) => submitted || touched.has(path) || [...touched].some(key => key.startsWith(path + '.'));
  const invalid = (path: string, touchPath = path) => ({ onBlur: () => touch(touchPath), 'aria-invalid': (submitted || touched.has(touchPath)) && !!validation.fields[path] || undefined, 'aria-describedby': showError(path) && validation.fields[path] ? `${validationId}-${path}` : undefined });
  const feedback = (path: string) => showError(path) && validation.fields[path] ? <small id={`${validationId}-${path}`} className="field-error">{validation.fields[path]}</small> : null;
  useEffect(() => {
    if (!prepareCheck) return;
    setPrepareCheck(null);
    if (prepareCheck.failed || !validation.request) {
      onRequest("Couldn't understand everything — fill in the details");
      // The fallback notice explains what happened; fields reveal errors when edited.
    } else {
      try { setReviewedRequest(reviewedWithContact(validation.request)); }
      catch (error) { setErrors([(error as Error).message]); onRequest(); }
    }
  }, [prepareCheck, validation, onRequest]);
  async function prepare() {
    if (homeMissing.length || locked || busy || parsing) return;
    setErrors([]); setReviewedRequest(null);
    setPrepareCheck({ failed: !await fillDetails() });
  }
  return <div className="inline-workflow" style={{ paddingBottom: view === 'request' ? reviewBarHeight : 0 }}>
    <section hidden={view !== 'home'} className="panel request-entry" aria-labelledby="request-title">
      <p className="eyebrow">01 / Tell Zeus</p><h2 id="request-title">What should Zeus do?</h2>
      <form noValidate onSubmit={e => { e.preventDefault(); void prepare(); }}>
        <fieldset disabled={locked || busy || parsing} className="space-y-5">
          <label>Goal<textarea data-gramm="false" aria-label="Home goal" value={v.goal} onChange={e => set('goal', e.target.value)} required maxLength={4000} rows={4} placeholder="Describe in English what you need and any limits Zeus should follow…" /></label>
          <div className="flex flex-wrap gap-3" aria-label="Request templates">
            <button type="button" className="secondary template-chip" onClick={() => template('book')}>Book a haircut</button>
            <button type="button" className="secondary template-chip" onClick={() => template('ask')}>Ask a clinic about documents</button>
            <button type="button" className="secondary template-chip" onClick={() => template('change')}>Reschedule a vet visit</button>
          </div>
          {view === 'home' && <ContactPicker compact value={contactDetails} contacts={contacts} selectedId={selectedId} saveChecked={saveContact} onChange={changeContact} onSelect={chooseContact} onContactsChange={setContacts} onSaveChecked={checked => { setSaveContact(checked); setReviewedRequest(null); }} />}
          <div className="flex flex-wrap items-center gap-4"><button type="submit" className="primary" disabled={!!homeMissing.length || locked || busy || parsing} aria-describedby="home-readiness">{parsing ? 'Preparing the plan…' : 'Prepare the plan'}</button><span id="home-readiness" role="status" className="text-base text-stone-300">{homeMissing.length ? `Add ${homeMissing.join(', ')} to continue.` : ''}</span><button type="button" className="text-add" onClick={() => onRequest()}>Enter details manually</button></div>
        </fieldset>
      </form>
    </section>
    <section hidden={view !== 'request'} className="manual-request" aria-labelledby="manual-request-title">
      <p className="eyebrow">Your instructions</p><h2 id="manual-request-title">Request</h2>
      {errors.length > 0 && <div role="alert" className="notice error"><ul className="list-disc pl-5">{errors.map((error, i) => <li key={i}>{error}</li>)}</ul></div>}
      <form noValidate onSubmit={e => {
        e.preventDefault();
        if (locked || busy || parsing) return;
        setSubmitted(true);
        if (!validation.request) { setErrors(validation.issues); return; }
        if (validation.request.availability.some(w => Date.parse(w.start.instant) <= Date.now())) { setErrors(['Availability must start in the future in the destination timezone.']); return; }
        try { setReviewedRequest(reviewedWithContact(validation.request)); setErrors([]); onRequest(); }
        catch (error) { setErrors([(error as Error).message]); }
      }}>
      <fieldset disabled={locked || busy || parsing} className="request-sections">
        <SectionCard step={1} title="Who to call">{view === 'request' && <ContactPicker hideHeading deferErrors showErrors={submitted} value={contactDetails} contacts={contacts} selectedId={selectedId} saveChecked={saveContact} onChange={changeContact} onSelect={chooseContact} onContactsChange={setContacts} onSaveChecked={checked => { setSaveContact(checked); setReviewedRequest(null); }} />}</SectionCard>
        <SectionCard step={2} title="What Zeus should do"><div className="request-goal-grid"><fieldset className="request-type-field" {...auto('kind')} {...invalid('requestType')}><legend className="section-title">Request type{badge('kind')}</legend><div className="flex flex-wrap gap-2" role="group" aria-label="Request type">{Object.entries(requestLabels).map(([kind, label]) => <button key={kind} type="button" className="secondary template-chip" aria-pressed={v.kind === kind} onClick={() => { set('kind', kind as Kind); touch('requestType'); }}>{label}</button>)}</div>{feedback('requestType')}</fieldset>
        <div className="goal-details"><label><span className="field-caption">Goal</span><span className="field-control"><textarea data-gramm="false" aria-label="Goal" {...invalid('goal')} value={v.goal} onChange={e => set('goal', e.target.value)} maxLength={4000} rows={3} required />{feedback('goal')}</span></label>
        {isMockMode && <button type="button" className="secondary fill-details" disabled={!v.goal.trim()} onClick={() => { setReviewedRequest(null); void fillDetails(); }}>Fill details from goal</button>}
        {!!parsedSource && <p id="auto-fill-help" className="text-base text-stone-300">{isMockMode ? 'Gold highlights mark suggestions from your goal. Every field is editable.' : 'Automatic suggestions are not available for this backend yet. Complete the plan below.'}</p>}
        {parseNotes.length > 0 && <details className="parse-notes"><summary>Check goal interpretations</summary><ul className="list-disc pl-5">{parseNotes.map((note, i) => <li key={i}>{note}</li>)}</ul></details>}
        {!!parsedSource && parsedSource !== v.goal && <p className="notice">Your goal changed. Prepare the plan again to refresh suggestions, or check and edit each detail below.</p>}
        </div></div>
        {v.kind === 'book' && <fieldset><legend className="section-title">Appointment details</legend><div className="form-grid appointment-fields">
          <label><span className="field-caption">Requested service{badge('service')}</span><span className="field-control"><input {...auto('service')} aria-label="Requested service" {...invalid('service')} value={v.service} onChange={e => set('service', e.target.value)} required maxLength={200} />{feedback('service')}</span></label>
          <label><span className="field-caption">Maximum service price (EUR){badge('maximum')}</span><span className="field-control"><input {...auto('maximum')} aria-label="Maximum service price (EUR)" {...invalid('pricePolicy.maximum')} type="number" min="0" step="0.01" value={v.maximum} onChange={e => set('maximum', e.target.value)} />{feedback('pricePolicy.maximum')}<small>Leave blank for no service-price cap. Separate from call charges.</small></span></label>
          <label><span className="field-caption">Zeus may book</span><span className="field-control"><select aria-label="Zeus may book" value={v.authority} onChange={e => set('authority', e.target.value)}><option value="within_constraints">Automatically within my constraints</option><option value="ask_before_accepting">Only after I approve the exact offer</option></select></span></label>
          <label className="check-label"><input type="checkbox" checked={v.unknown} onChange={e => set('unknown', e.target.checked)} />Allow a booking when the service price is unknown</label>
        </div></fieldset>}
        {v.kind === 'ask' && <div {...invalid('questions')}><ListEditor showErrors={submitted} title="Questions Zeus must answer" singular="Question" items={v.questions} autoFilled={autoFields.has('questions')} onChange={items => { set('questions', items); if (!items.length) touch('questions'); }} />{feedback('questions')}</div>}
        {v.kind === 'change' && <fieldset><legend className="section-title">Change or cancel details</legend><div className="form-grid">
          <label><span className="field-caption">What to change or cancel{badge('change')}</span><span className="field-control"><textarea data-gramm="false" {...auto('change')} aria-label="What to change or cancel" {...invalid('changeRequest.description')} value={v.change} onChange={e => set('change', e.target.value)} required maxLength={4000} rows={3} />{feedback('changeRequest.description')}</span></label>
          <label><span className="field-caption">Existing booking reference{badge('reference')}</span><span className="field-control"><input {...auto('reference')} aria-label="Existing booking reference" {...invalid('changeRequest.bookingReference')} value={v.reference} onChange={e => set('reference', e.target.value)} maxLength={200} placeholder="Optional" />{feedback('changeRequest.bookingReference')}</span></label>
        </div></fieldset>}
        {(v.kind === 'book' || v.kind === 'change') && <fieldset><legend className="section-title">{v.kind === 'book' ? 'Availability windows' : 'New availability (optional for cancellation)'}</legend>
          <p className="mb-4 text-base text-stone-300">Use explicit dates and times in {v.zone}. A repeated clock-change time needs an earlier/later choice.</p>
          {v.windows.map((w, index) => <div key={index} className="mb-4 rounded-lg border border-stone-700 p-4">
            <div className="form-grid availability-fields"><label><span className="field-caption">Date {index + 1}{index === 0 && badge('date')}</span><span className="field-control"><input {...(index === 0 ? auto('date') : {})} {...invalid('availability', `availability.${index}.date`)} aria-label={'Date ' + (index + 1)} type="date" value={w.date} min={TimeZoneSchema.safeParse(v.zone).success ? localDateInZone(new Date(), v.zone) : undefined} required={v.kind === 'book' || !!(w.date || w.start || w.end)} onChange={e => updateWindow(index, 'date', e.target.value)} /></span></label>
            <label><span className="field-caption">From{index === 0 && badge('start')}</span><span className="field-control"><input {...(index === 0 ? auto('start') : {})} {...invalid('availability', `availability.${index}.start`)} aria-label={'From ' + (index + 1)} type="time" value={w.start} required={v.kind === 'book' || !!(w.date || w.start || w.end)} onChange={e => updateWindow(index, 'start', e.target.value)} /></span></label>
            <label><span className="field-caption">Until{index === 0 && badge('end')}</span><span className="field-control"><input {...(index === 0 ? auto('end') : {})} {...invalid('availability', `availability.${index}.end`)} aria-label={'Until ' + (index + 1)} type="time" value={w.end} required={v.kind === 'book' || !!(w.date || w.start || w.end)} onChange={e => updateWindow(index, 'end', e.target.value)} /></span></label>
            <label><span className="field-caption">If the clocks repeat this time</span><span className="field-control"><select aria-label={'Clock change ' + (index + 1)} value={w.occurrence} onChange={e => updateWindow(index, 'occurrence', e.target.value)}><option value="">Ask me to choose</option><option value="earlier">Earlier occurrence</option><option value="later">Later occurrence</option></select></span></label></div>
            <div className="mt-3 flex justify-end"><RemoveButton label={'Remove window ' + (index + 1)} onClick={() => { set('windows', v.windows.filter((_, i) => i !== index)); touch('availability'); }} /></div>
          </div>)}
          {feedback('availability')}
          <button type="button" className="text-add" disabled={v.windows.length >= 20} onClick={() => set('windows', [...v.windows, emptyWindow()])}>+ Add availability window</button>
        </fieldset>}

        </SectionCard>
        <SectionCard step={3} title="Tone &amp; manner"><ToneFields hideHeading tone={v.tone} notes={v.toneNotes} onChange={(tone, toneNotes) => { setValues(old => ({ ...old, tone, toneNotes })); setReviewedRequest(null); }} /></SectionCard>
        <SectionCard step={4} title="Boundaries">
          <p className="mb-3 text-base text-stone-300">Zeus only decides what you allow here. Everything else, he asks you first.</p>
          <div className="plan-boundaries" onBlur={e => { const label = (e.target as HTMLInputElement).getAttribute('aria-label') ?? ''; if (label.startsWith('Allowed decision')) touch('boundaries.canDecideAlone'); if (label.startsWith('Approval boundary')) touch('boundaries.mustAskMe'); }}>
            <BoundaryTags showErrors={submitted} title="May decide alone" singular="Allowed decision" items={v.canDecide} suggestions={['Any slot in my time window', 'Price within my limit']} autoFilled={autoFields.has('canDecide')} onChange={items => set('canDecide', items)} />
            <BoundaryTags showErrors={submitted} title="Must ask me first" singular="Approval boundary" items={v.mustAsk} suggestions={approvalRules} autoFilled={autoFields.has('mustAsk')} onChange={items => set('mustAsk', items)} />
          </div>{feedback('boundaries.canDecideAlone')}{feedback('boundaries.mustAskMe')}
        </SectionCard>
        <SectionCard step={5} title="What Zeus may share"><p className="mb-4 text-base text-stone-300">Only these details may be shared. Remembered on this device.</p><div className="form-grid share-grid">
          <label><span className="field-caption">Approved name</span><span className="field-control"><input aria-label="Approved name" {...invalid('bookingName')} value={v.name} onChange={e => set('name', e.target.value)} maxLength={200} placeholder="Optional" />{feedback('bookingName')}</span></label>
          <label><span className="field-caption">Approved callback number</span><span className="field-control"><input aria-label="Approved callback number" {...invalid('shareableContact.phone')} value={v.sharePhone} onChange={e => set('sharePhone', e.target.value)} type="tel" pattern="\+[1-9][0-9]{7,14}" placeholder="Optional: +34…" />{feedback('shareableContact.phone')}</span></label>
          <label><span className="field-caption">Approved email</span><span className="field-control"><input aria-label="Approved email" {...invalid('shareableContact.email')} value={v.shareEmail} onChange={e => set('shareEmail', e.target.value)} type="email" placeholder="Optional" />{feedback('shareableContact.email')}</span></label>
        </div></SectionCard>
        <details className="advanced-limits request-card"><summary className="section-title cursor-pointer"><span>Advanced settings</span><span className="advanced-overview">{v.zone} · {v.duration.trim() ? `${v.duration} min max` : 'Set duration'} · {v.cost.trim() && Number.isFinite(Number(v.cost)) ? `€${Number(v.cost).toFixed(2)} max` : 'Set EUR cost limit'}</span></summary><div className="form-grid mt-4">
          <label><span className="field-caption">Timezone</span><span className="field-control"><input aria-label="Timezone" {...invalid('timeZone')} value={v.zone} onChange={e => set('zone', e.target.value)} required maxLength={100} />{feedback('timeZone')}<small>Suggested from the country code. Check the local timezone, especially for countries with several zones.</small></span></label>
          <label><span className="field-caption">Maximum call duration (minutes)</span><span className="field-control"><input aria-label="Maximum call duration (minutes)" {...invalid('callLimits.maxDurationSeconds')} type="number" min="0.5" max="10" step="0.5" required value={v.duration} onChange={e => set('duration', e.target.value)} />{feedback('callLimits.maxDurationSeconds')}</span></label>
          <label><span className="field-caption">Maximum estimated call cost (EUR)</span><span className="field-control"><input aria-label="Maximum estimated call cost (EUR)" {...invalid('callLimits.maxEstimatedCost')} type="number" min="0" step="0.01" required value={v.cost} onChange={e => set('cost', e.target.value)} />{feedback('callLimits.maxEstimatedCost')}</span></label>
        </div>{initial?.callLimits.maxEstimatedCost.currency === 'USD' && <p className="mt-3 text-base">This saved request used USD. Enter an explicit EUR limit; no currency conversion is applied.</p>}<p className="mt-3 text-base text-stone-300">Duration and spend limits require backend/provider enforcement. Estimates are not settled charges.</p></details>

        {((showError('timeZone') && validation.fields.timeZone) || (showError('callLimits.maxDurationSeconds') && validation.fields['callLimits.maxDurationSeconds']) || (showError('callLimits.maxEstimatedCost') && validation.fields['callLimits.maxEstimatedCost'])) && <p className="field-error">Check Advanced settings: timezone, call duration and cost.</p>}
        <div ref={reviewBar} className="request-review-bar" hidden={!!approvalPending || !!flow}>
          <span id="request-readiness" role="status" aria-live="polite">{validation.issues.length ? `${validation.issues.length} thing${validation.issues.length === 1 ? '' : 's'} missing` : 'Ready to review'}</span>
          <button type="submit" className="primary" disabled={!validation.request || locked || busy || parsing} aria-describedby="request-readiness">Review call plan</button>
        </div>
      </fieldset>
      </form>
    </section>
    {flow ? <section className="workflow-stage" aria-label="Current call">{flow}</section> : reviewedRequest && <section ref={planSection} tabIndex={-1} className="panel inline-plan workflow-stage" aria-labelledby="zeus-plan-title">
      <p className="eyebrow">Approve the plan</p><h2 id="zeus-plan-title">Zeus will…</h2>
      <RequestDetails request={reviewedRequest} />
      <div className="mt-5 space-y-4">{callHelp}<div className="flex flex-wrap gap-3"><button type="button" className="primary" disabled={locked || busy || callDisabled} onClick={() => {
        if (reviewedRequest.availability.some(w => Date.parse(w.start.instant) <= Date.now())) { setErrors(['Availability must start in the future.']); setReviewedRequest(null); onRequest(); return; }
        onCall(reviewedRequest);
      }}>{busy ? 'Starting…' : 'Call'}</button><button type="button" className="secondary" disabled={locked || busy} onClick={() => onRequest()}>Edit details</button></div></div>
    </section>}
  </div>;
}
