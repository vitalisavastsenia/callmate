import { useMemo, useRef, useState } from 'react';
import { Modal } from './ContactFields';
import { agreementEntries, monthDays, shiftMonth, type AgreementEntry } from '../agreements';
import { describeTime, localDateInZone, money } from '../time';
import type { CallSnapshot, HistoryEntry } from '../types';

const dayLabel = (date: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));
const monthLabel = (month: string) => new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(month + '-01T12:00:00Z'));
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

interface Props {
  history: HistoryEntry[]; currentCall: CallSnapshot | null; now: number;
  loading: boolean; busy: boolean; onRefresh: () => void; onOpen: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
}
export default function AgreementsView({ history, currentCall, now, loading, busy, onRefresh, onOpen, onDelete }: Props) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = localDateInZone(new Date(now), timeZone);
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const [month, setMonth] = useState(() => today.slice(0, 7));
  const [day, setDay] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [candidate, setCandidate] = useState<AgreementEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const deletionPending = useRef(false);
  async function confirmDelete() {
    if (!candidate || deletionPending.current) return;
    deletionPending.current = true; setDeleting(true); setDeleteError('');
    try { await onDelete(candidate.call.id); setCandidate(null); }
    catch (error) { setDeleteError(error instanceof Error ? error.message : 'Could not delete the entry. Please try again.'); }
    finally { deletionPending.current = false; setDeleting(false); }
  }
  const entries = useMemo(() => agreementEntries(history, currentCall, timeZone), [history, currentCall, timeZone]);
  const shown = entries.filter(entry => (!kind || entry.kind === kind) && [entry.call.businessName,
    entry.call.outcome.status === 'confirmed' ? entry.call.outcome.offer.service : '',
    entry.call.outcome.status === 'completed' ? entry.call.outcome.findings.filter(f => f.answered).map(f => f.answerEn).join(' ') : '',
    entry.call.outcome.status !== 'pending' ? entry.call.outcome.summaryEn : '']
    .join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const monthEntries = shown.filter(entry => entry.date.startsWith(month));
  const dated = day ? monthEntries.filter(entry => entry.date === day) : monthEntries;
  const upcoming = shown.filter(entry => entry.kind === 'appointment' && Date.parse(entry.instant) >= now).sort((a, b) => Date.parse(a.instant) - Date.parse(b.instant));
  const past = shown.filter(entry => entry.kind === 'appointment' && Date.parse(entry.instant) < now);
  const information = shown.filter(entry => entry.kind === 'information');
  function showDate(date: string) { setMonth(date.slice(0, 7)); setDay(date); setView('calendar'); }
  function cards(items: AgreementEntry[]) {
    return <ul className="space-y-4" aria-label="Agreements list">{items.map(entry => {
      const call = entry.call;
      const outcome = call.outcome;
      return <li key={call.id}><article className="agreement-card" aria-label={call.businessName}>
        <div className="history-card-heading"><h4 className="font-semibold">{call.businessName}</h4><span className="status-badge">{call.mode === 'simulator' ? 'Simulated ' : ''}{entry.kind === 'appointment' ? 'appointment' : 'agreement'}</span></div>
        {outcome.status === 'confirmed' && <><p className="agreement-date"><time dateTime={entry.instant}>{describeTime(outcome.offer.appointment)}</time></p>
          <p>{outcome.offer.service} · {outcome.offer.bookingName} · {money(outcome.offer.price)}</p><p className="mt-2">{outcome.summaryEn}</p></>}
        {outcome.status === 'completed' && <><p className="text-base text-stone-300">Recorded on <time dateTime={entry.instant}>{dayLabel(entry.date)}</time> · {timeZone}</p>
          <ul className="mt-3 list-disc pl-5">{outcome.findings.filter(f => f.answered).map((f, i) => <li key={i}><p className="font-semibold">{f.question}</p><p>{f.answerEn}</p></li>)}</ul>
          {outcome.resolution === 'needs_follow_up' && <div className="notice mt-4"><p className="font-semibold">Follow-up needed</p><ul className="list-disc pl-5">{outcome.nextSteps.map((step, i) => <li key={i}>{step}</li>)}</ul></div>}</>}
        <div className="mt-4 flex flex-wrap gap-3"><button type="button" className="secondary" disabled={busy} onClick={() => onOpen(call.id)}>View call details<span className="sr-only"> for {call.businessName}</span></button>
          {view === 'list' && <button type="button" className="text-add" onClick={() => showDate(entry.date)}>Show in calendar<span className="sr-only"> for {call.businessName}</span></button>}
          <button type="button" className="secondary" disabled={busy || deleting || !['ended', 'busy', 'no_answer', 'failed'].includes(call.callState)} onClick={() => { setDeleteError(''); setCandidate(entry); }}>Delete entry<span className="sr-only"> for {call.businessName}</span></button></div>
      </article></li>;
    })}</ul>;
  }
  return <section className="panel agreements-view" aria-labelledby="agreements-title">
    <div className="agreements-heading"><div><p className="eyebrow">What was agreed</p><h2 id="agreements-title">Agreements</h2></div><button type="button" className="secondary" disabled={busy || loading} onClick={onRefresh}>{busy ? 'Refreshing…' : 'Refresh agreements'}</button></div>
    <p className="mb-5 text-base text-stone-300">Confirmed appointments and answers from your calls. Appointment dates and times use the business timezone. Other agreements use the date of the call in {timeZone}.</p>
    <div className="agreements-controls mb-5"><div className="flex flex-wrap gap-2" role="group" aria-label="Agreements view">{(['list', 'calendar'] as const).map(value => <button key={value} type="button" className="secondary template-chip" aria-pressed={view === value} onClick={() => setView(value)}>{value === 'list' ? 'List' : 'Calendar'}</button>)}</div>
      <label>Search agreements<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Business, service, or answer" /></label>
      <label>Agreement type<select value={kind} onChange={e => setKind(e.target.value)}><option value="">All agreements</option><option value="appointment">Appointments</option><option value="information">Other agreements</option></select></label></div>
    {loading ? <p role="status">Loading agreements…</p> : <>
      {!entries.length && <p className="notice">No agreements yet. Confirmed appointments and answered requests will appear here.</p>}
      {!!entries.length && !shown.length && <div className="notice"><p>No agreements match your search or type filter.</p><button type="button" className="text-add" onClick={() => { setQuery(''); setKind(''); }}>Clear filters</button></div>}
      {view === 'list' ? <div className="space-y-6">
        {!!upcoming.length && <section aria-label="Upcoming appointments"><h3 className="section-title">Upcoming appointments</h3>{cards(upcoming)}</section>}
        {!!information.length && <section aria-label="Other agreements"><h3 className="section-title">Other agreements</h3>{cards(information)}</section>}
        {!!past.length && <section aria-label="Past appointments"><h3 className="section-title">Past appointments</h3>{cards(past)}</section>}
      </div> : <>
        <div className="agreements-month-nav"><button type="button" className="secondary" aria-label="Previous month" onClick={() => { setMonth(shiftMonth(month, -1)); setDay(null); }}>‹</button><h3 className="section-title" aria-live="polite">{monthLabel(month)}</h3><button type="button" className="secondary" aria-label="Next month" onClick={() => { setMonth(shiftMonth(month, 1)); setDay(null); }}>›</button><button type="button" className="text-add" onClick={() => showDate(today)}>Today</button></div>
        <div className="agreements-calendar" role="group" aria-label={`${monthLabel(month)} calendar`}>
          {weekdays.map(name => <abbr key={name} title={name} className="agreements-weekday">{name.slice(0, 3)}</abbr>)}
          {monthDays(month).map((date, i) => {
            if (!date) return <span key={`blank-${i}`} aria-hidden="true" />;
            const count = monthEntries.filter(entry => entry.date === date).length;
            return <button key={date} type="button" className="agreements-calendar-day" aria-pressed={day === date} aria-current={date === today ? 'date' : undefined} aria-label={`${dayLabel(date)}, ${count} ${count === 1 ? 'agreement' : 'agreements'}`} onClick={() => setDay(day === date ? null : date)}><span>{Number(date.slice(-2))}</span>{count > 0 && <span className="agreements-day-count" aria-hidden="true">{count}</span>}</button>;
          })}
        </div>
        <section className="mt-6" aria-label="Calendar agreements"><div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h3 className="section-title">{day ? dayLabel(day) : monthLabel(month)}</h3>{day && <button type="button" className="text-add" onClick={() => setDay(null)}>Show whole month</button>}</div>
          {dated.length ? cards([...dated].sort((a, b) => a.date.localeCompare(b.date) || Date.parse(a.instant) - Date.parse(b.instant))) : <p>No agreements {day ? 'on this date' : 'this month'}.</p>}
        </section>
      </>}
    </>}
    {candidate && <Modal title="Delete agreement?" onClose={() => { if (!deletionPending.current) setCandidate(null); }}>
      <p className="font-semibold">{candidate.call.businessName} · {dayLabel(candidate.date)}</p>
      {candidate.call.outcome.status === 'confirmed' && <p className="mt-2">{candidate.call.outcome.offer.service} · {describeTime(candidate.call.outcome.offer.appointment)}</p>}
      <p className="mt-4">This permanently removes the saved entry from Agreements and the calendar. The original call remains in Summary.</p>
      <p className="notice mt-4">This does not cancel an appointment or change your agreement with the business. Contact the business to cancel.</p>
      {deleteError && <p role="alert" className="notice mt-4">{deleteError}</p>}
      <div className="mt-5 flex flex-wrap gap-3"><button type="button" className="secondary" disabled={deleting} onClick={() => setCandidate(null)}>Cancel</button><button type="button" className="secondary" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? 'Deleting…' : 'Delete entry'}</button></div>
    </Modal>}
  </section>;
}
