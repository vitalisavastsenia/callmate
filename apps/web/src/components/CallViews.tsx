import { useEffect, useId, useRef, type ReactNode } from 'react';
import { describeTime, money } from '../time';
import { downloadCalendar } from '../calendar';
import { callIsTerminal } from '../ws';
import { approvalReasons, type CallActivity } from '../callActivity';
import { templateForRequest, templateForService, requestLabels, type CallSnapshot, type ConnectionState, type HistoryEntry, type Offer, type ReviewPlan, type RequestDraft } from '../types';

const languageNames = { 'es-ES': 'Spanish', 'ru-RU': 'Russian', 'en-US': 'English', 'pl-PL': 'Polish' };
export function PlanDetails({ plan }: { plan: ReviewPlan }) {
  return <RequestDetails request={plan.request} />;
}
export function RequestDetails({ request: r }: { request: RequestDraft }) {
  const kind = r.requestType ?? 'book';
  const profile = templateForRequest(r);
  const list = (items: string[] | undefined) => items?.length ? <ul className="list-disc pl-5">{items.map((item, i) => <li key={i}>{item}</li>)}</ul> : 'None specified';
  return <dl className="details">
    <dt>Business and destination</dt><dd>{r.business.name} · {r.business.phone}</dd>
    <dt>Conversation language</dt><dd>{languageNames[r.language ?? 'es-ES']}</dd>
    {profile && <><dt>Conversation template</dt><dd>{profile.label}</dd>{profile.fields.map(field => <div className="contents" key={field.key}><dt>{field.label}</dt><dd>{field.options?.find(option => option.value === r.templateDetails?.[field.key])?.label[2] ?? String(r.templateDetails?.[field.key] ?? 'Not supplied')}</dd></div>)}</>}
    <dt>Request type</dt><dd>{requestLabels[kind]}</dd>
    <dt>Goal</dt><dd>{r.goal ?? 'Book ' + r.service + ' within the approved constraints.'}</dd>
    <dt>Zeus will be</dt><dd>{r.tone?.length ? r.tone.map(t => t === 'Formal "usted"' ? 'formal' : t.toLowerCase()).join(', ') : 'No tone preference specified'}</dd>
    {r.tone_notes && <><dt>Notes for Zeus</dt><dd className="whitespace-pre-wrap">{r.tone_notes}</dd></>}
    <dt>Timezone</dt><dd>{r.timeZone ?? r.availability[0]?.start.timeZone}</dd>
    {kind === 'book' && <><dt>Requested service</dt><dd>{r.service}</dd>
      <dt>Service price</dt><dd>{r.pricePolicy.maximum ? 'Maximum ' + money(r.pricePolicy.maximum) : 'No price cap'} · Unknown price {r.pricePolicy.allowUnknownPrice ? 'permitted' : 'requires approval'}</dd>
      <dt>Booking authority</dt><dd>{r.bookingAuthority === 'within_constraints' ? 'May book within these constraints' : 'Ask me before accepting any offer'}</dd></>}
    {(kind === 'book' || kind === 'change') && <><dt>{kind === 'book' ? 'Approved availability' : 'New availability'}</dt><dd>{r.availability.length ? <ul>{r.availability.map((w, i) => <li key={i}>{describeTime(w.start)} — {w.end.localTime}</li>)}</ul> : 'No new availability specified'}</dd></>}
    {kind === 'ask' && <><dt>Questions Zeus must answer</dt><dd>{list(r.questions)}</dd></>}
    {kind === 'change' && <><dt>What to change or cancel</dt><dd>{r.changeRequest?.description}</dd><dt>Existing booking reference</dt><dd>{r.changeRequest?.bookingReference || 'Not provided'}</dd></>}
    <dt>May decide alone</dt><dd>{list(r.boundaries?.canDecideAlone)}</dd>
    <dt>Must ask me about</dt><dd>{list(r.boundaries?.mustAskMe)}</dd>
    <dt>May share</dt><dd>Name: {r.bookingName || 'withheld'}; callback: {r.shareableContact.phone ?? 'withheld'}; email: {r.shareableContact.email ?? 'withheld'}</dd>
    <dt>Prohibited conditions</dt><dd>No deposit, payment, paid add-on, or cancellation fee</dd>
    <dt>Call limits</dt><dd>{r.callLimits.maxDurationSeconds} seconds · Maximum estimated call cost {money(r.callLimits.maxEstimatedCost)} ({r.callLimits.maxEstimatedCost.currency})</dd>
  </dl>;
}
export function OfferDetails({ offer }: { offer: Offer }) {
  const profile = templateForService(offer.service);
  return <dl className="details">
    <dt>Service and name</dt><dd>{offer.service} · {offer.bookingName}</dd>
    {profile?.fields.map(field => <div className="contents" key={field.key}><dt>{field.label}</dt><dd>{field.options?.find(option => option.value === offer.templateDetails?.[field.key])?.label[2] ?? String(offer.templateDetails?.[field.key] ?? 'Not confirmed')}</dd></div>)}
    <dt>Appointment</dt><dd>{describeTime(offer.appointment)}</dd>
    <dt>Service price</dt><dd>{offer.price ? money(offer.price) : 'Unknown price'}</dd>
    <dt>Duration</dt><dd>{offer.durationMinutes === null ? 'Unknown — confirm with the business' : offer.durationMinutes + ' minutes'}</dd>
    <dt>Conditions</dt><dd>Deposit: {offer.conditions.deposit}; cancellation fee: {offer.conditions.cancellationFee}; paid add-on: {offer.conditions.paidAddOn}</dd>
  </dl>;
}
export function Usage({ call }: { call: Pick<CallSnapshot, 'usage'> }) {
  return <div className="mt-5 border-t border-stone-700 pt-4 text-base"><p>Estimated call charge: {money(call.usage.estimate)}</p><p>Settled call charge: {call.usage.status === 'settled' ? money(call.usage.settledTotal) : 'Not available yet'}</p><p className="text-stone-400">Charge status: {call.usage.status}. Any service price is separate. Each amount shows its recorded currency.</p></div>;
}
export function ApprovalCard({ call, now, disabled, onDecision, compact = false, onVisibilityChange }: { call: CallSnapshot; now: number; disabled: boolean; onDecision: (decision: 'approve' | 'reject') => void; compact?: boolean; onVisibilityChange?: (visible: boolean) => void }) {
  const titleId = useId(); const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!onVisibilityChange || !ref.current) return;
    const observer = new IntersectionObserver(([entry]) => onVisibilityChange(!!entry?.isIntersecting && entry.intersectionRatio >= 0.5), { threshold: [0, 0.5, 1], rootMargin: '0px 0px -180px 0px' });
    observer.observe(ref.current); return () => { observer.disconnect(); onVisibilityChange(false); };
  }, [call.pendingApproval?.id, onVisibilityChange]);
  const a = call.pendingApproval;
  if (!a) return null;
  const seconds = Math.max(0, Math.ceil((Date.parse(a.expiresAt) - now) / 1000));
  const r = call.plan.request;
  const outside = !r.availability.some(w => Date.parse(a.offer.appointment.instant) >= Date.parse(w.start.instant) && Date.parse(a.offer.appointment.instant) <= Date.parse(w.end.instant));
  const above = a.offer.price && r.pricePolicy.maximum && a.offer.price.amountMinor > r.pricePolicy.maximum.amountMinor;
  const forbidden = Object.values(a.offer.conditions).some(value => value !== 'none');
  return <section className={'approval' + (compact ? ' approval-compact' : ' mb-6')} aria-labelledby={titleId} key={a.id}>
    <p className="eyebrow">Approval required · Offer version {a.offer.version}</p><h3 id={titleId} className="section-title">Approve this exact alternative?</h3>
    <p className="mb-3">{approvalReasons[a.reason]}</p>
    {!compact && call.messages.filter(m => m.speaker === 'business').slice(-1).map(m => <blockquote key={m.id} className="transcript-line mb-4"><p lang={m.language}>{m.originalText}</p><p className="text-stone-300">{m.translationEn ?? 'English translation pending…'}</p></blockquote>)}
    {!compact && <div className="mb-5 rounded-lg border border-stone-600 p-4"><p className="mb-2 font-semibold">Changes from your plan</p><ul className="list-disc pl-6">
      {outside && <li>Time offered: {describeTime(a.offer.appointment)}. Approved: {r.availability.map(w => w.start.localDate + ', ' + w.start.localTime + '–' + w.end.localTime + ' ' + w.start.timeZone).join('; ')}.</li>}
      {above && <li>Offered service price {money(a.offer.price)}; your maximum {money(r.pricePolicy.maximum)}.</li>}
      {!a.offer.price && <li>The price is unknown.</li>}
      {!outside && !above && a.offer.price && <li>The time and price fit your plan; you requested explicit approval.</li>}
    </ul></div>}
    {compact ? <p className="text-base">{describeTime(a.offer.appointment)} · {a.offer.price ? money(a.offer.price) : 'Price unknown'}</p> : <OfferDetails offer={a.offer} />}
    <p className="my-4 font-semibold" role="timer" aria-label="Approval time remaining">{seconds > 0 ? seconds + ' seconds left to decide' : 'Approval expired — waiting for the server to close it'}</p>
    {!compact && <p className="mb-4 text-base">Choose whether to approve this exact offer or reject it before the deadline. If you do not answer, it will not be accepted and the call will close or continue without this offer.</p>}
    {!compact && <p className="mb-4 text-base">This decision applies only to this offer and version. A changed offer needs fresh approval. Approval does not mean the business has confirmed.</p>}
    {forbidden && <p role="alert" className="notice error">This offer includes unknown or prohibited conditions. It cannot be approved in this MVP.</p>}
    <div ref={ref} className="approval-actions flex flex-wrap gap-3"><button className="primary" disabled={disabled || seconds === 0 || forbidden} onClick={() => onDecision('approve')}>Approve this offer</button><button className="secondary" disabled={disabled || seconds === 0} onClick={() => onDecision('reject')}>Reject offer</button></div>
    {disabled && <p className="mt-3 text-base">Decisions are unavailable while a command is pending or call updates are disconnected.</p>}
  </section>;
}
const callLabels: Record<CallSnapshot['callState'], string> = { creating: 'Starting call', dialing: 'Dialing', ringing: 'Ringing', connected: 'Connected', ending: 'Ending call — awaiting acknowledgement', ended: 'Call ended', busy: 'Business is busy', no_answer: 'No answer', failed: 'Call failed', reconciliation_required: 'Call state unknown — checking with the provider' };
const bookingLabels: Record<CallSnapshot['bookingState'], string> = { completed: 'Call completed', pending: 'No booking confirmed', offer_received: 'Offer received', awaiting_approval: 'Waiting for your approval', reading_back: 'Reading back the details', awaiting_business_confirmation: 'Waiting for the business to confirm', confirmed: 'Booking confirmed', not_booked: 'Not booked', uncertain: 'Uncertain — check before trying again' };
export function LiveCall({ call, connection, now, busy, stopping, onStop, onDecision, onApprovalVisibility, approvalLines, activity = [] }: { call: CallSnapshot; connection: ConnectionState; now: number; busy: boolean; stopping: boolean; onStop: () => void; onDecision: (decision: 'approve' | 'reject') => void; onApprovalVisibility: (visible: boolean) => void; approvalLines: string[]; activity?: CallActivity[] }) {
  const ended = callIsTerminal(call);
  const booking = (call.plan.request.requestType ?? 'book') === 'book';
  return <>
    <p className="mb-4 text-base text-stone-300">Agent language: {languageNames[call.plan.request.language ?? 'es-ES']}. {!ended && 'To change it, stop this call and review a new request.'}</p>
    <div className="call-toolbar mb-6 flex flex-wrap items-start justify-between gap-4"><div><p className="eyebrow">03 / On the line</p><h2 role="status">{callLabels[call.callState]}</h2><p className="text-xl" role="status">{booking ? bookingLabels[call.bookingState] : call.bookingState === 'completed' ? 'Request result available' : call.bookingState === 'not_booked' ? 'Request not completed' : call.bookingState === 'uncertain' ? 'Result uncertain' : 'Working on your request'}</p></div>
      {!ended && <button className="stop" disabled={stopping || call.callState === 'ending'} onClick={onStop}>{stopping ? 'Requesting stop…' : call.callState === 'ending' ? 'Hangup requested…' : 'Stop call'}</button>}
    </div>
    <p className="mb-4 text-base" role="status">Updates: {connection}. {call.mode === 'simulator' ? 'Simulated call; no real phone connection.' : 'Closing this tab does not end the phone call.'}</p>
    {!ended && connection !== 'connected' && <p className="notice">Call updates are disconnected. The backend may still be on the call. Do not assume an approval or booking succeeded, and do not start another attempt.</p>}
    {!ended && <p className="mb-5 text-base text-stone-300">Stop requests hangup; it does not cancel an appointment already made.</p>}
    <div className="grid items-start gap-6 lg:grid-cols-[2fr_1fr]">
      <Transcript call={call} approvalLines={approvalLines}>{!ended && <ApprovalCard call={call} now={now} disabled={busy || connection !== 'connected'} onDecision={onDecision} onVisibilityChange={onApprovalVisibility} />}</Transcript>
      <aside className="space-y-5"><section className="panel" aria-label="Agent decisions and actions"><h3 className="section-title">Agent decisions &amp; actions</h3>
        <p className="mb-4 text-base text-stone-300">Observed workflow actions. Earlier history may be unavailable after reload.</p>
        <ol className="space-y-4" aria-live="polite" aria-relevant="additions">{activity.map(item => <li key={item.id} className="agent-action"><p className="eyebrow"><time dateTime={item.at}>{new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></p><h4 className="font-semibold">{item.title}</h4><p>{item.detail}</p></li>)}</ol>
        {!activity.length && <p>No agent decision has been reported yet.</p>}
      </section><section className="panel"><h3 className="section-title">{booking ? 'Current offer' : 'Your request'}</h3>{booking ? <>{call.activeOffer ? <OfferDetails offer={call.activeOffer} /> : <p>No offer yet.</p>}<p className="mt-5 text-base text-stone-300">An offer, your approval, and an ended phone call are not business confirmation.</p></> : <PlanDetails plan={call.plan} />}<Usage call={call} /></section></aside>
    </div>
  </>;
}
export function Transcript({ call, children, approvalLines = [] }: { call: CallSnapshot; children?: ReactNode; approvalLines?: string[] }) {
  const booking = (call.plan.request.requestType ?? 'book') === 'book';
  const log = useRef<HTMLDivElement>(null); const following = useRef(true);
  useEffect(() => { if (log.current && following.current) log.current.scrollTop = log.current.scrollHeight; }, [call.messages]);
  return <section className="panel"><h3 className="section-title">Conversation</h3>
        {call.conversationData === 'deleted' ? <p>{booking ? 'Conversation text was deleted. Booking details remain.' : 'Conversation text was deleted. Request details remain.'}</p> : <div ref={log} onScroll={() => { const el = log.current!; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }} className="transcript space-y-5" role="log" aria-label="Call transcript" tabIndex={0}>
          {!call.messages.length && <p className="text-stone-300">Waiting for the business to answer…</p>}
          {call.messages.map(m => <article key={m.id} className={'transcript-line transcript-' + m.speaker}><p className="eyebrow">{m.speaker === 'assistant' ? 'Agent · Zeus' : 'Business · Other side'} · {languageNames[m.language]} · {!m.final ? 'Provisional' : m.speaker === 'business' ? 'Final' : m.playback === 'played' ? call.mode === 'simulator' ? 'Simulated playback' : 'Spoken' : m.playback}</p><p lang={m.language} className="mb-2">{m.originalText}</p><p lang="en" className="text-stone-300">{m.translationEn ?? 'English translation pending…'}</p>{m.playback === 'interrupted' && <p className="mt-2 text-base text-amber-200">Interrupted — the business may not have heard the full reply.</p>}</article>)}
          {approvalLines.map((line, i) => <p key={i} className="transcript-line">{line}</p>)}
          {children}
        </div>}
      </section>;
}
export function outcomeLabel(call: CallSnapshot | HistoryEntry): string {
  const outcome = call.outcome;
  const booking = ('plan' in call ? call.plan.request.requestType ?? 'book' : call.requestType ?? 'book') === 'book';
  return outcome.status === 'confirmed' ? 'Confirmed' : outcome.status === 'completed' ? outcome.resolution === 'resolved' ? 'Request completed' : 'Follow-up needed' : outcome.status === 'not_booked' ? booking ? 'Not booked' : 'Request not completed' : outcome.status === 'uncertain' ? 'Uncertain — check before trying again' : 'In progress';
}
export function ShortResult({ call }: { call: CallSnapshot }) {
  if (call.outcome.status === 'pending') return null;
  return <section className={'panel mb-5 result-' + call.outcome.status} aria-labelledby="short-result-title">
    <p className="eyebrow">The result</p><h2 id="short-result-title">{outcomeLabel(call)}</h2>
    <p>{call.outcome.summaryEn}</p>
    {call.mode === 'simulator' && <p className="notice mt-4">Simulation only. No real business appointment was confirmed.</p>}
    {call.outcome.status === 'uncertain' && <p className="notice mt-5">The result is uncertain. Contact the business to check before trying again; an appointment may already exist.</p>}
    {call.outcome.status === 'confirmed' && <button className="secondary mt-5" onClick={() => downloadCalendar(call)}>Download calendar (.ics)</button>}
    <p className="mt-4 text-base text-stone-300">Open Summary for agreements, next steps, and the full conversation.</p>
  </section>;
}
export function Result({ call, onDelete, deleting }: { call: CallSnapshot; onDelete: () => void; deleting: boolean }) {
  const outcome = call.outcome;
  if (outcome.status === 'pending') return null;
  const booking = (call.plan.request.requestType ?? 'book') === 'book';
  const ids = outcome.status === 'confirmed' ? outcome.confirmationMessageIds : outcome.status === 'completed' ? outcome.evidenceMessageIds : [];
  const evidence = call.messages.filter(m => ids.includes(m.id));
  const title = outcome.status === 'confirmed' ? 'Confirmed' : outcome.status === 'completed' ? outcome.resolution === 'resolved' ? 'Request completed' : 'Follow-up needed' : outcome.status === 'not_booked' ? booking ? 'Not booked' : 'Request not completed' : 'Uncertain — check before trying again';
  return <section className={'panel mb-6 result-' + outcome.status} aria-labelledby="result-title">
    <p className="eyebrow">04 / The result</p><h2 id="result-title">{title}</h2><p className="mb-5">{outcome.summaryEn}</p>
    {call.mode === 'simulator' && <p className="notice mb-4">Simulation only. No real business appointment was confirmed.</p>}
    <p className="mb-4">Business: {call.plan.request.business.name} · {call.plan.request.business.phone}</p>
    {outcome.status === 'confirmed' && <><OfferDetails offer={outcome.offer} />
      <button className="primary mt-5" onClick={() => downloadCalendar(call)}>Download calendar (.ics)</button>
      {outcome.offer.durationMinutes === null && <p className="mt-3 text-base">Duration is unknown. The calendar file includes no invented end time; check the duration with the business.</p>}
    </>}
    {outcome.status === 'completed' && <>
      <h3 className="section-title">Findings and open questions</h3><ul className="space-y-4">{outcome.findings.map((finding, i) => <li key={i}><p className="font-semibold">{finding.question}</p><p>{finding.answerEn}</p><p className="text-base text-amber-200">{finding.answered ? 'Answered' : 'Still needs confirmation'}</p></li>)}</ul>
      {outcome.nextSteps.length > 0 && <div className="notice mt-5"><h3 className="section-title">Next steps</h3><ul className="list-disc pl-5">{outcome.nextSteps.map((step, i) => <li key={i}>{step}</li>)}</ul></div>}
    </>}
    {evidence.length > 0 && <div className="notice mt-5"><h3 className="mb-2 font-semibold">{booking ? 'Business confirmation evidence' : 'Business response evidence'}</h3>{evidence.map(m => <blockquote key={m.id}><p lang={m.language}>{m.originalText}</p><p>{m.translationEn ?? 'Translation pending'}</p></blockquote>)}</div>}
    {(outcome.status === 'uncertain' || outcome.status === 'not_booked') && <p className="notice">{outcome.status === 'uncertain' ? booking ? 'The appointment may already exist. Contact the business to check before making another attempt. No automatic redial or calendar export is available.' : 'The result could not be verified. Contact the business to check before repeating the request. No automatic redial is available.' : 'You may review the request and choose whether to start a new call.'}</p>}
    <Usage call={call} />
    {callIsTerminal(call) && call.conversationData === 'retained' && <button className="secondary mt-5" disabled={deleting} onClick={onDelete}>{deleting ? 'Deleting…' : 'Delete conversation text'}</button>}
    {call.conversationData === 'deleted' && <p className="mt-4 text-base">Conversation text deleted locally; structured request details retained. Provider logs and backups are separate.</p>}
  </section>;
}
