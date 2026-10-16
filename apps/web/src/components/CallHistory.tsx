import { useState } from 'react';
import mascot from '../assets/zeus_resting.png';
import { requestLabels, type CallSnapshot, type HistoryEntry } from '../types';
import { callIsTerminal } from '../ws';

type HistoryStatus = 'Booked' | 'Answered' | 'Needed you' | 'Failed' | 'Cancelled' | 'In progress';
const statuses: HistoryStatus[] = ['Booked', 'Answered', 'Needed you', 'Failed', 'Cancelled', 'In progress'];
function statusFor(item: HistoryEntry): HistoryStatus {
  const outcome = item.outcome;
  if (outcome.status === 'confirmed') return 'Booked';
  if (outcome.status === 'completed') return outcome.resolution === 'resolved' ? 'Answered' : 'Needed you';
  if (outcome.status === 'uncertain') return 'Needed you';
  if (outcome.status === 'not_booked') return outcome.reason === 'user_stopped' ? 'Cancelled' : outcome.reason === 'policy_declined' ? 'Needed you' : 'Failed';
  return 'In progress';
}
const callDate = (instant: string) => new Date(instant).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const summaryFor = (item: HistoryEntry) => item.outcome.status !== 'pending' ? item.outcome.summaryEn
  : item.callState === 'reconciliation_required' ? 'Checking the call state with the provider.' : 'Zeus is working on your request.';

interface Props {
  history: HistoryEntry[]; currentCall: CallSnapshot | null; now: number;
  busy: boolean; repeatDisabled: boolean; loading: boolean;
  onOpen: (id: string) => void; onRepeat: (id: string) => void;
  onCreate: () => void; onReturn: () => void;
}
export default function CallHistory({ history, currentCall, now, busy, repeatDisabled, loading, onOpen, onRepeat, onCreate, onReturn }: Props) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<HistoryStatus | ''>('');
  // The subscribed snapshot is fresher than the last history refresh, including while on Summary.
  const entries = [...history];
  if (currentCall) {
    const item: HistoryEntry = { id: currentCall.id, mode: currentCall.mode, businessName: currentCall.plan.request.business.name,
      requestType: currentCall.plan.request.requestType, callState: currentCall.callState, outcome: currentCall.outcome,
      createdAt: currentCall.createdAt, usage: currentCall.usage };
    const index = entries.findIndex(entry => entry.id === item.id);
    if (index < 0) entries.push(item); else entries[index] = item;
  }
  entries.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const showFilters = entries.length > 5;
  const shown = entries.filter(item => !showFilters || ((!status || statusFor(item) === status)
    && [item.businessName, requestLabels[item.requestType ?? 'book'], summaryFor(item), statusFor(item), callDate(item.createdAt)]
      .join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const approval = currentCall?.pendingApproval;
  const waiting = currentCall && !callIsTerminal(currentCall) && approval && Date.parse(approval.expiresAt) > now;

  return <>
    {waiting && <section className="panel history-attention" aria-labelledby="attention-title">
      <p className="eyebrow">A little help from you</p><h2 id="attention-title">Needs your attention</h2>
      <div className="history-attention-row"><div className="min-w-0"><h3 className="font-semibold">{currentCall.plan.request.business.name}</h3>
        <p className="text-base text-stone-300">Zeus needs your approval before accepting an offer.</p>
        <p className="text-base text-amber-200">Answer before {new Date(approval.expiresAt).toLocaleTimeString('en-GB')}.</p>
      </div><button type="button" className="primary" disabled={busy} onClick={onReturn}>Answer Zeus</button></div>
    </section>}
    {currentCall && !callIsTerminal(currentCall) && <button type="button" className="secondary" onClick={onReturn}>Return to active call</button>}
    <section className="panel" aria-labelledby="history-title">
      <p className="eyebrow">Your calls</p><h2 id="history-title">Call history</h2>
      {loading ? <p role="status">Loading your calls…</p> : !entries.length ? <div className="history-empty">
        <img src={mascot} alt="Zeus resting" />
        <p>Zeus is resting. Give him something to do.</p>
        <button type="button" className="primary" disabled={repeatDisabled} onClick={onCreate}>Create a request</button>
      </div> : <>
        {showFilters && <div className="history-filters mb-5">
          <label>Search calls<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Business, request, or result" /></label>
          <label>Status<select value={status} onChange={e => setStatus(e.target.value as HistoryStatus | '')}><option value="">All statuses</option>{statuses.map(value => <option key={value}>{value}</option>)}</select></label>
        </div>}
        {showFilters && <p role="status" className="mb-4 text-base text-stone-300">{shown.length} of {entries.length} calls</p>}
        {!shown.length ? <div className="notice"><p>No calls match your search or status filter.</p><button type="button" className="text-add" onClick={() => { setQuery(''); setStatus(''); }}>Clear filters</button></div>
          : <ul className="space-y-4" aria-label="Call history">{shown.map(item => {
            const label = statusFor(item);
            const waitingForYou = waiting && item.id === currentCall.id;
            const summary = waitingForYou ? 'Zeus is waiting for your answer.' : summaryFor(item);
            return <li key={item.id}><article className="history-card" aria-label={item.businessName}>
              <div className="history-card-copy"><div className="history-card-heading"><h3 className="font-semibold">{item.businessName}</h3>
                <span className={'status-badge history-status-' + label.toLowerCase().replaceAll(' ', '-')}>{waitingForYou ? 'Waiting for you' : label}</span></div>
                <p className="text-base text-stone-300"><time dateTime={item.createdAt}>{callDate(item.createdAt)}</time> · {requestLabels[item.requestType ?? 'book']} · {item.mode === 'simulator' ? 'Simulated' : 'Live'}</p>
                <p className="history-summary" title={summary}>{summary}</p>
                {item.outcome.status === 'uncertain' && <p className="mt-2 text-base text-amber-200">Outcome uncertain — check with the business before repeating.</p>}
              </div>
              <div className="history-card-actions"><button type="button" className="secondary" disabled={busy} onClick={() => onOpen(item.id)}>View details<span className="sr-only"> for {item.businessName}</span></button>
                <button type="button" className="text-add" disabled={repeatDisabled || !['ended', 'busy', 'no_answer', 'failed'].includes(item.callState)} onClick={() => onRepeat(item.id)}>Repeat<span className="sr-only"> for {item.businessName}</span></button></div>
            </article></li>;
          })}</ul>}
      </>}
    </section>
  </>;
}
