import { initializeConsole } from './app.js';

const el = id => document.getElementById(id);
let setup = false; let consoleUi; let busy = false; let checkTimer; let expiresTimer; let generation = 0;
function message(text) { el('auth-error').textContent = text || ''; el('auth-error').hidden = !text; }
async function request(path, body) {
  const response = await fetch('/api/auth/' + path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000),
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error?.message || 'Authentication request failed.'); error.code = data.error?.code; throw error; }
  return data;
}
function show(session) {
  clearTimeout(expiresTimer);
  const authenticated = session.authenticated;
  el('auth-panel').hidden = authenticated; el('console-content').hidden = !authenticated;
  el('auth-retry').hidden = true; message('');
  if (authenticated) {
    el('auth-account').textContent = `Signed in as ${session.username}`;
    if (!consoleUi) consoleUi = initializeConsole(window, document);
    expiresTimer = setTimeout(() => void check(), Math.max(0, Date.parse(session.expiresAt) - Date.now()));
  } else {
    consoleUi?.cleanup(); consoleUi = undefined;
    el('initial-message').value = ''; el('response').value = ''; el('operator-link').removeAttribute('href');
    setup = session.setupRequired; el('auth-form').hidden = false;
    el('auth-title').textContent = setup ? 'Create your owner account' : 'Sign in';
    el('auth-help').textContent = setup ? 'Choose a username and a password with at least 12 characters. This is the only account for this installation.' : 'Use your CallMate owner account.';
    el('auth-submit').textContent = setup ? 'Create account' : 'Sign in';
    el('auth-password').minLength = setup ? 12 : 1; el('auth-password').autocomplete = setup ? 'new-password' : 'current-password';
    el('auth-confirm-row').hidden = !setup; el('auth-confirm').required = setup;
  }
}
async function check() {
  if (busy) return;
  const current = ++generation;
  try { const session = await request('session'); if (current === generation) show(session); }
  catch { if (current === generation) { show({ authenticated: false, setupRequired: false }); el('auth-form').hidden = true; el('auth-retry').hidden = false; message('Cannot reach the backend. Retry the connection.'); } }
}
el('auth-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  if (setup && el('auth-password').value !== el('auth-confirm').value) { message('Passwords do not match.'); return; }
  busy = true; generation++; el('auth-submit').disabled = true; message('');
  try { show(await request(setup ? 'setup' : 'login', { username: el('auth-username').value, password: el('auth-password').value })); }
  catch (error) { if (error.code === 'AUTH_ALREADY_CONFIGURED') show({ authenticated: false, setupRequired: false }); message(error.message || 'Sign in failed.'); }
  finally { busy = false; el('auth-submit').disabled = false; el('auth-password').value = ''; el('auth-confirm').value = ''; }
});
el('auth-logout').addEventListener('click', async () => {
  if (busy) return; busy = true; generation++; el('auth-logout').disabled = true;
  try { await request('logout', {}); show({ authenticated: false, setupRequired: false }); }
  catch { window.alert('Sign out failed. Please try again.'); }
  finally { busy = false; el('auth-logout').disabled = false; }
});
el('auth-retry').addEventListener('click', check);
window.addEventListener('callmate:unauthorized', () => { show({ authenticated: false, setupRequired: false }); void check(); });
window.addEventListener('focus', check);
checkTimer = setInterval(check, 60000);
window.addEventListener('pagehide', () => { clearInterval(checkTimer); clearTimeout(expiresTimer); consoleUi?.cleanup(); }, { once: true });
void check();
