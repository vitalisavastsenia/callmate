import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AuthSession } from '../types';
import { ApiError, getSession, signIn, signOut } from '../api';

export default function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState(''); const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const generation = useRef(0); const submitting = useRef(false);
  const retrySession = useRef<() => Promise<void>>(async () => {});
  const [checkUnavailable, setCheckUnavailable] = useState(false);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      if (submitting.current) return;
      const current = ++generation.current;
      try { const next = await getSession(); if (!disposed && current === generation.current) { setSession(next); setError(''); setCheckUnavailable(false); } }
      catch (error) { if (!disposed && current === generation.current) {
        if (error instanceof ApiError && error.code === 'UNAUTHENTICATED') setSession(old => old ? { ...old, authenticated: false, username: null, expiresAt: null } : old);
        setCheckUnavailable(true); setError(error instanceof Error ? error.message : 'Cannot check sign-in status.');
      } }
    };
    retrySession.current = refresh;
    const expired = () => { setSession(old => old ? { ...old, authenticated: false, username: null, expiresAt: null } : old); void refresh(); };
    const focus = () => { void refresh(); };
    window.addEventListener('callmate:unauthorized', expired); window.addEventListener('focus', focus);
    const timer = setInterval(() => void refresh(), 60_000); void refresh();
    return () => { disposed = true; clearInterval(timer); window.removeEventListener('focus', focus); window.removeEventListener('callmate:unauthorized', expired); };
  }, []);
  useEffect(() => {
    if (!session?.expiresAt) return;
    const timer = setTimeout(() => {
      generation.current++;
      setSession(old => old ? { ...old, authenticated: false, username: null, expiresAt: null } : old);
      setError('Your session expired. Sign in again to continue.');
    }, Math.max(0, Date.parse(session.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [session?.expiresAt]);
  if (session?.authenticated) return <>
    <div className="auth-account"><span>Signed in as {session.username}</span><button type="button" className="secondary" disabled={busy} onClick={async () => {
      submitting.current = true; generation.current++; setBusy(true); setError('');
      try { await signOut(); setSession({ setupRequired: false, authenticated: false, username: null, expiresAt: null }); }
      catch (error) { setError(error instanceof Error ? error.message : 'Sign out failed. Try again.'); }
      finally { submitting.current = false; setBusy(false); }
    }}>{busy ? 'Signing out…' : 'Sign out'}</button></div>
    {error && <div role="alert" className="notice error mx-auto max-w-xl"><p>{error}</p>{checkUnavailable && <><p>Your sign-in check is temporarily unavailable. Your draft is still here; the session expiry remains enforced.</p><button type="button" className="secondary mt-3" onClick={() => void retrySession.current()}>Retry connection</button></>}</div>}{children}
  </>;
  const setup = session?.setupRequired ?? false;
  return <main className="auth-screen"><section className="panel space-y-5" aria-labelledby="auth-title">
    <p className="eyebrow">Zeus Llama · CallMate</p><h1 id="auth-title" className="section-title">{!session ? 'Connecting to CallMate' : setup ? 'Create your owner account' : 'Sign in'}</h1>
    {error && <p role="alert" className="notice error">{error}</p>}
    {!session ? <><p>Your local backend must be running to sign in.</p><button type="button" className="secondary" onClick={() => void retrySession.current()}>Retry connection</button></> : <>
      <p>{setup ? 'One account protects your contacts, calls, and settings on this installation. Choose a password with at least 12 characters.' : 'Use the owner account for this installation.'}</p>
      <form method="post" className="space-y-4" onSubmit={async event => {
        event.preventDefault(); if (busy) return;
        if (setup && password !== confirmation) { setError('Passwords do not match.'); return; }
        submitting.current = true; generation.current++; setBusy(true); setError('');
        try { setSession(await signIn(username, password, setup)); setPassword(''); setConfirmation(''); }
        catch (error) {
          if (error instanceof ApiError && error.code === 'AUTH_ALREADY_CONFIGURED') setSession({ setupRequired: false, authenticated: false, username: null, expiresAt: null });
          setPassword(''); setConfirmation(''); setError(error instanceof Error ? error.message : 'Sign in failed.');
        }
        finally { submitting.current = false; setBusy(false); }
      }}>
        <label>Username<input name="username" aria-describedby="auth-username-help" autoComplete="username" autoCapitalize="none" spellCheck={false} required minLength={3} maxLength={64} pattern="[a-zA-Z0-9_.\-]+" value={username} disabled={busy} onChange={event => setUsername(event.target.value)} /></label>
        <p id="auth-username-help" className="text-base text-stone-300">3–64 letters, numbers, dots, underscores or hyphens.</p>
        <label>Password<input type="password" name="password" autoComplete={setup ? 'new-password' : 'current-password'} required minLength={setup ? 12 : 1} maxLength={128} value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
        {setup && <label>Confirm password<input type="password" name="confirmation" autoComplete="new-password" required maxLength={128} value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label>}
        <button type="submit" className="primary" disabled={busy}>{busy ? 'Please wait…' : setup ? 'Create account' : 'Sign in'}</button>
      </form>
    </>}
  </section></main>;
}
