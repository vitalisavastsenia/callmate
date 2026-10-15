import { useEffect, useRef, useState } from 'react';
import zeusLlamaLogo from './assets/zeus-llama.png';
import * as api from './api';
import { defaultSettings } from './mock';
import { callIsTerminal, subscribeToCall } from './ws';
import { RequestDraftSchema, ReviewPlanSchema, type ApprovalDecision, type CallSnapshot, type ConnectionState, type HistoryEntry, type Readiness, type RequestDraft, type ReviewPlan, type Scenario, type Settings } from './types';
import RequestForm from './components/RequestForm';
import Home from './components/Home';
import SettingsView from './components/SettingsView';
import { readRequestDefaults, saveRequestDefaults } from './preferences';
import { useApprovalAttention } from './useApprovalAttention';
import CallHistory from './components/CallHistory';
import { ApprovalCard, LiveCall, PlanDetails, Result, ShortResult, Transcript } from './components/CallViews';

type Page = 'home' | 'request' | 'summary' | 'settings';
const activeKey = 'zeus-llama.active-attempt.v1';
const pendingKey = 'zeus-llama.pending-start.v1';
interface PendingStart { plan: ReviewPlan; mode: 'simulator' | 'live'; key: string; scenario: Scenario }
export default function App() {
  const [defaults, setDefaults] = useState(readRequestDefaults);
  const [simulator, setSimulator] = useState(api.isMockMode);
  const [inlineApprovalVisible, setInlineApprovalVisible] = useState(false);
  const [approvalRecords, setApprovalRecords] = useState<Record<string, { callId: string; text: string }>>({});
  const latestCall = useRef<CallSnapshot | null>(null);
  const [page, setPage] = useState<Page>('home');
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [plan, setPlan] = useState<ReviewPlan | null>(null);
  const [requestInitial, setRequestInitial] = useState<RequestDraft | undefined>();
  const [initialPrepared, setInitialPrepared] = useState(false);
  const [showCall, setShowCall] = useState(false);
  const [historyCall, setHistoryCall] = useState<CallSnapshot | null>(null);
  const [requestKey, setRequestKey] = useState(0);
  const [call, setCall] = useState<CallSnapshot | null>(null);
  const [scenario, setScenario] = useState<Scenario>('alternative');
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(Date.now());
  const [pending, setPending] = useState<PendingStart | null>(null);
  const inFlight = useRef(false);
  const startCommand = useRef<PendingStart | null>(null);
  const main = useRef<HTMLElement>(null);
  const active = !!call && !callIsTerminal(call);
  const unresolved = !!localStorage.getItem(activeKey) && !call;
  const mayStart = !!readiness?.ready && !active && !loading && !unresolved;

  function acceptSnapshot(next: CallSnapshot) {
    const old = latestCall.current;
    if (old?.id === next.id && old.revision > next.revision) return;
    if (old?.id === next.id && old.pendingApproval && !next.pendingApproval && next.outcome.status === 'not_booked') {
      const id = old.pendingApproval.id;
      setApprovalRecords(records => records[id] ? records : { ...records, [id]: { callId: next.id, text: next.outcome.status === 'not_booked' ? next.outcome.summaryEn : '' } });
    }
    latestCall.current = next;
    setCall(old => old?.id === next.id && old.revision > next.revision ? old : next);
    if (!callIsTerminal(next)) localStorage.setItem(activeKey, next.id);
    else if (localStorage.getItem(activeKey) === next.id) localStorage.removeItem(activeKey);
  }
  async function refreshHistory() { setHistory((await api.getHistory()).items); }
  async function refreshReadiness() { setReadiness(await api.getReadiness()); }
  async function perform(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) { setError(e instanceof api.ApiError ? e.message + (e.details.length ? ' ' + e.details.map(d => d.path + ': ' + d.message).join('; ') : '') : e instanceof Error ? e.message : 'The request could not be completed.'); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function executeStart(command: PendingStart) {
    const next = await api.startCall(command.plan, command.mode, command.key, command.scenario);
    acceptSnapshot(next); setShowCall(true); setPage('home');
    localStorage.removeItem(pendingKey); startCommand.current = null; setPending(null);
  }
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const results = await Promise.allSettled([api.getReadiness(), api.getSettings(), api.getHistory()]);
        if (cancelled) return;
        if (results[0].status === 'fulfilled') setReadiness(results[0].value);
        if (results[1].status === 'fulfilled') setSettings(results[1].value);
        if (results[2].status === 'fulfilled') setHistory(results[2].value.items);
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') setError(failed.reason instanceof Error ? failed.reason.message : 'Backend unavailable. Real calls are disabled until readiness is known.');
        const savedStart = localStorage.getItem(pendingKey);
        const currentId = localStorage.getItem(activeKey) ?? (results[2].status === 'fulfilled' ? results[2].value.items.find(item => !['ended', 'busy', 'no_answer', 'failed'].includes(item.callState))?.id : undefined);
        if (savedStart) {
          const saved = JSON.parse(savedStart) as PendingStart;
          saved.plan = ReviewPlanSchema.parse(saved.plan);
          startCommand.current = saved; setPending(saved); setPlan(saved.plan); setRequestInitial(saved.plan.request); setRequestKey(old => old + 1); setPage('home');
          setNotice('A Start response may have been lost. Check the original request below; it uses the same command key and cannot create a second attempt.');
        } else if (currentId) {
          const next = await api.getCall(currentId);
          if (!cancelled) { acceptSnapshot(next); setPlan(next.plan); setRequestInitial(next.plan.request); setRequestKey(old => old + 1); setShowCall(true); setPage('home'); }
        }
      } catch (e) { if (!cancelled) setError('Could not restore the previous call. Do not start another attempt until its state is known. ' + (e instanceof Error ? e.message : '')); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, []);
  useEffect(() => { main.current?.focus({ preventScroll: true }); }, [page]);
  const callId = call?.id;
  useEffect(() => {
    if (!callId) return;
    return subscribeToCall(callId, {
      onSnapshot: acceptSnapshot, onConnection: setConnection, onError: setError,
      onApprovalResolved: resolution => {
        const text = resolution.status === 'approved' ? 'You answered: Approve this offer' : resolution.status === 'rejected' ? 'You answered: Reject offer' : resolution.status === 'expired' ? 'No answer — approval expired.' : 'The offer changed or closed. The previous approval no longer applies.';
        setApprovalRecords(old => ({ ...old, [resolution.approvalId]: { callId, text } }));
      },
      onConversationDeleted: () => setCall(old => old ? { ...old, messages: [], conversationData: 'deleted' } : old),
    });
  }, [callId]);
  const revision = call?.revision;
  useEffect(() => { if (call && callIsTerminal(call)) void refreshHistory().catch(() => {}); }, [callId, revision]);

  const backendUnreachable = !simulator && error.includes(api.BACKEND_UNREACHABLE_MESSAGE);
  const modeLocked = active || !!pending || loading || unresolved;
  const requestDisabled = active || !!pending || loading || unresolved || busy;
  function newRequest(request?: RequestDraft, destination: 'home' | 'request' = request ? 'request' : 'home') {
    if (requestDisabled) return;
    setNotice(''); setError(''); setPlan(null); setShowCall(false); setRequestInitial(request); setInitialPrepared(false);
    setRequestKey(old => old + 1); startCommand.current = null; setPage(destination);
    requestAnimationFrame(() => document.getElementById(destination === 'request' ? 'manual-request-title' : 'request-title')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }));
  }
  function openSummary(selected?: CallSnapshot) {
    setHistoryCall(selected ?? null);
    setPage('summary'); void perform(refreshHistory);
  }
  async function openHistoryCall(id: string) {
    const selected = await api.getCall(id);
    if (!callIsTerminal(selected)) { acceptSnapshot(selected); setShowCall(true); setPage('home'); }
    else setHistoryCall(selected);
  }
  function repeatCall(selected: CallSnapshot) {
    if (!callIsTerminal(selected)) { acceptSnapshot(selected); setShowCall(true); setPage('home'); return; }
    newRequest(structuredClone(selected.plan.request));
    if (selected.outcome.status === 'uncertain') setNotice('This earlier result was uncertain. Check with the business before repeating the request.');
  }
  async function deleteConversation(selected: CallSnapshot) {
    await api.deleteConversation(selected.id);
    const next = await api.getCall(selected.id);
    if (next.id === call?.id) acceptSnapshot(next);
    setHistoryCall(old => old?.id === next.id ? next : old);
    await refreshHistory();
  }
  async function callRequest(request: RequestDraft) {
    if (!mayStart || pending) return;
    prepareAttention();
    const saved = await api.makePlan(request); setPlan(saved);
    // A backend-normalized plan needs another deliberate review before dialing.
    if (JSON.stringify(RequestDraftSchema.parse(saved.request)) !== JSON.stringify(RequestDraftSchema.parse(request))) {
      setRequestInitial(saved.request); setInitialPrepared(true); setRequestKey(old => old + 1);
      setNotice('The backend adjusted the plan. Review the updated details below, then choose Call to approve them.'); return;
    }
    const command: PendingStart = { plan: saved, mode: readiness!.mode, key: crypto.randomUUID(), scenario: (request.requestType ?? 'book') !== 'book' && !['uncertain', 'no_answer', 'interrupted'].includes(scenario) ? 'within_plan' : scenario };
    startCommand.current = command; setPending(command); localStorage.setItem(pendingKey, JSON.stringify(command));
    try { await executeStart(command); } catch (e) { setNotice('The Start response is unknown. Check the original request below; do not start another attempt.'); throw e; }
  }
  const homeOutcome = showCall ? call?.outcome.status : undefined;
  useEffect(() => {
    if (page !== 'home' || (!showCall && !pending)) return;
    const target = document.getElementById('home-call-stage');
    target?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    target?.focus({ preventScroll: true });
  }, [page, showCall, !!pending, homeOutcome]);
  useEffect(() => {
    if (page === 'summary' && historyCall) {
      document.getElementById('history-detail')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
      document.getElementById('history-detail')?.focus({ preventScroll: true });
    }
  }, [page, historyCall?.id]);
  function showApproval() {
    setPage('home'); setShowCall(true);
    requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector('#home-call-stage .approval-actions')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' })));
  }
  const prepareAttention = useApprovalAttention(call?.pendingApproval && Date.parse(call.pendingApproval.expiresAt) > now ? call.pendingApproval : null, showApproval);
  function decideApproval(decision: 'approve' | 'reject') {
    if (!call || connection !== 'connected' || !call.pendingApproval || Date.parse(call.pendingApproval.expiresAt) <= Date.now()) return;
    void perform(async () => {
      const approval = call.pendingApproval; if (!approval) return;
      const storageKey = 'zeus-llama.decision.' + approval.id + '.' + decision;
      const key = localStorage.getItem(storageKey) ?? crypto.randomUUID(); localStorage.setItem(storageKey, key);
      const body: ApprovalDecision = { approvalId: approval.id, plan: approval.plan, offer: { offerId: approval.offer.id, offerVersion: approval.offer.version }, decision };
      try {
        const next = await api.decideApproval(call.id, body, key);
        setApprovalRecords(old => ({ ...old, [approval.id]: { callId: call.id, text: decision === 'approve' ? 'You answered: Approve this offer' : 'You answered: Reject offer' } }));
        acceptSnapshot(next);
      } catch (e) { acceptSnapshot(await api.getCall(call.id)); throw e; }
    });
  }
  async function switchMode(next: boolean) {
    if (active || pending || unresolved || loading || simulator === next) return;
    api.setMockMode(next); setSimulator(next); setCall(null); latestCall.current = null;
    setPlan(null); setShowCall(false); setHistoryCall(null); setHistory([]); setReadiness(null); setConnection('closed');
    const results = await Promise.allSettled([api.getReadiness(), api.getSettings(), api.getHistory()]);
    if (results[0].status === 'fulfilled') setReadiness(results[0].value);
    if (results[1].status === 'fulfilled') setSettings(results[1].value);
    if (results[2].status === 'fulfilled') {
      setHistory(results[2].value.items);
      const ongoing = results[2].value.items.find(item => !['ended', 'busy', 'no_answer', 'failed'].includes(item.callState));
      if (ongoing) { localStorage.setItem(activeKey, ongoing.id); acceptSnapshot(await api.getCall(ongoing.id)); setShowCall(true); }
    }
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  const approvalLines = Object.values(approvalRecords).filter(record => record.callId === call?.id).map(record => record.text);
  const attentionPanel = !!call?.pendingApproval && !callIsTerminal(call) && (page === 'summary' || page === 'settings' || !inlineApprovalVisible);
  const callFlow = pending && plan ? <section id="home-call-stage" tabIndex={-1} className="panel workflow-stage">
    <h2>Check the original call request</h2><p className="notice">The Start response may have been lost. Retrying uses the same command key and cannot create a second attempt.</p>
    <PlanDetails plan={plan} /><button className="primary mt-5" disabled={busy} onClick={() => void perform(() => executeStart(pending))}>{busy ? 'Checking…' : 'Check original Start request'}</button>
  </section> : showCall && call ? <div id="home-call-stage" tabIndex={-1} className="workflow-stage">
    {callIsTerminal(call) ? <>
      <ShortResult call={call} />
      <div className="flex flex-wrap gap-3"><button className="primary" onClick={() => openSummary(call)}>View in Summary</button><button className="secondary" disabled={requestDisabled} onClick={() => newRequest()}>New request</button></div>
    </> : <LiveCall call={call} connection={connection} now={now} busy={busy} stopping={stopping} onStop={() => {
      if (stopping) return; setStopping(true); setError('');
      void api.stopCall(call.id).then(acceptSnapshot).catch(e => setError((e instanceof Error ? e.message : 'Stop response unavailable.') + ' Hangup is not confirmed; keep checking this attempt.')).finally(() => setStopping(false));
    }} onDecision={decideApproval} onApprovalVisibility={setInlineApprovalVisible} approvalLines={approvalLines} />}
  </div> : undefined;
  return <div className={'mx-auto max-w-7xl px-4 py-6 sm:px-8' + (attentionPanel ? ' has-attention-panel' : '')}>
    <header className="app-header mb-6 border-b border-stone-700 pb-6">
      <div className="flex items-center gap-3"><img src={zeusLlamaLogo} alt="White llama wearing a golden headset and laurel crown" width={203} height={342} className="h-[80px] w-auto shrink-0 object-contain sm:h-[104px]" /><div><p className="eyebrow">A little divine intervention</p><h1 className="font-serif text-3xl sm:text-5xl">Zeus <span className="text-amber-300">Llama</span></h1></div></div>
      <nav aria-label="Main navigation" className="header-nav">
      <button className="secondary" aria-current={page === 'home' ? 'page' : undefined} onClick={() => setPage('home')}>Home</button>
      <button className="secondary" aria-current={page === 'request' ? 'page' : undefined} onClick={() => setPage('request')}>Request</button>
      <button className="secondary" aria-current={page === 'summary' ? 'page' : undefined} onClick={() => openSummary()}>Summary</button>
      <button className="secondary" aria-current={page === 'settings' ? 'page' : undefined} onClick={() => setPage('settings')}>Settings</button>
      </nav>
    </header>
    {error && <div role="alert" className="notice error"><p>{error}</p>{backendUnreachable && <>
      <button type="button" className="secondary mt-3" disabled={busy || modeLocked} onClick={() => void perform(() => switchMode(true))}>Switch to Simulator</button>
      {modeLocked && <p className="mt-2 text-base">Finish or resolve the current call attempt before switching modes.</p>}
    </>}</div>}{notice && <p role="status" className="notice">{notice}</p>}
    <main ref={main} tabIndex={-1} className="outline-none">
      {loading && <p role="status" className="notice">Checking readiness and restoring local state…</p>}
      <div hidden={page === 'summary' || page === 'settings'}>
        <div hidden={page !== 'home'}><Home onRequest={() => { setNotice(''); setPage('request'); }} /></div>
        {!loading && <RequestForm key={requestKey} initial={requestInitial} initialPrepared={initialPrepared} view={page === 'request' ? 'request' : 'home'} onRequest={message => { setNotice(message ?? ''); setPage('request'); }} settings={settings} defaults={defaults} approvalPending={!!call?.pendingApproval} busy={busy} locked={requestDisabled || showCall} callDisabled={!mayStart}
          callHelp={<>{!readiness?.ready && <div className="notice"><p>Calling requires confirmed backend readiness.</p><button type="button" className="secondary mt-3" disabled={busy} onClick={() => void perform(refreshReadiness)}>Check readiness again</button></div>}{api.isMockMode && <p className="text-base text-stone-300">No number will be dialed. Custom simulator requests use scripted answers and may need follow-up.</p>}</>}
          flow={callFlow} onCall={request => void perform(() => callRequest(request))}
          scenario={scenario} onScenarioChange={setScenario}
        />}
      </div>
      {page === 'summary' && <div className="space-y-6">
        <CallHistory history={history} currentCall={call} now={now} busy={busy} repeatDisabled={requestDisabled} loading={loading}
          onOpen={id => void perform(() => openHistoryCall(id))} onRepeat={id => void perform(async () => repeatCall(await api.getCall(id)))}
          onCreate={() => newRequest(undefined, 'home')} onReturn={() => setPage('home')} />
        {historyCall && <section id="history-detail" tabIndex={-1} className="workflow-stage" aria-label="Call details">
          <Result call={historyCall} deleting={busy} onDelete={() => void perform(() => deleteConversation(historyCall))} />
          <section className="panel mb-6"><h3 className="section-title">Agreements</h3>{historyCall.outcome.status === 'confirmed' ? <p>{historyCall.outcome.summaryEn}</p> : <p>{historyCall.outcome.status === 'completed' ? 'See the findings above for answered and unanswered questions. No appointment is confirmed.' : 'No verified agreement is recorded.'}</p>}</section>
          <Transcript call={historyCall} approvalLines={Object.values(approvalRecords).filter(r => r.callId === historyCall.id).map(r => r.text)} />
          <button className="primary mt-5" disabled={requestDisabled} onClick={() => repeatCall(historyCall)}>Repeat</button>
        </section>}
      </div>}
      {page === 'settings' && <SettingsView key={String(simulator)} readiness={readiness} settings={settings} defaults={defaults} busy={busy || loading} simulator={simulator} modeLocked={active || !!pending || unresolved || loading} scenario={scenario} onScenarioChange={setScenario}
        onModeChange={value => void perform(() => switchMode(value))} onRefresh={() => void perform(refreshReadiness)}
        onSave={(value, nextDefaults) => void perform(async () => { const saved = await api.updateSettings(value); setSettings(saved); saveRequestDefaults(nextDefaults); setDefaults(nextDefaults); setNotice('Settings saved. Defaults apply to new requests and untouched fields in your current draft.'); })} />}
    </main>
    {attentionPanel && call && <aside className="attention-panel" aria-label="Zeus needs your approval"><ApprovalCard compact call={call} now={now} disabled={busy || connection !== 'connected'} onDecision={decideApproval} /><button className="text-add" onClick={showApproval}>Go to the conversation</button></aside>}
    <footer className="mt-10 text-center text-base text-stone-400">Your intention. Zeus’s voice.</footer>
  </div>;
}
