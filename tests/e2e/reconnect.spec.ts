import { expect, test } from './fixtures';
import { awaitingApprovalFixture, confirmedCallFixture, reviewPlanFixture, transcriptEventFixture } from '@callmate/contracts/fixtures';

test('failed agreement deletion preserves the entry and allows retry after backend acknowledgement', async ({ page }) => {
  let deletes = 0;
  const call = structuredClone(confirmedCallFixture);
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/v1/contacts')) return route.continue();
    if (path.endsWith('/readiness')) return route.fulfill({ json: { mode: 'simulator', ready: true, voiceEngine: null, capabilities: [], checks: [] } });
    if (path.endsWith('/settings')) return route.fulfill({ json: { defaultCallLimits: reviewPlanFixture.request.callLimits, transcriptRetentionDays: 30 } });
    if (path.endsWith('/history')) return route.fulfill({ json: { items: [{ id: call.id, mode: call.mode, businessName: call.plan.request.business.name,
      callState: call.callState, outcome: call.outcome, createdAt: call.createdAt, usage: call.usage, agreementDeletedAt: call.agreementDeletedAt }], nextCursor: null } });
    if (path.endsWith('/agreement')) {
      expect(route.request().method()).toBe('DELETE'); deletes++;
      if (deletes === 1) return route.fulfill({ status: 503, json: { error: { code: 'PROVIDER_UNAVAILABLE', message: 'Storage is temporarily unavailable. Try again.', requestId: crypto.randomUUID(), details: [] } } });
      call.agreementDeletedAt = new Date().toISOString(); call.revision++;
      return route.fulfill({ json: { call } });
    }
    return route.fulfill({ json: { call } });
  });
  await page.goto('/'); await page.getByRole('button', { name: 'Agreements', exact: true }).click();
  await page.getByRole('button', { name: /^Delete entry for / }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete agreement?', exact: true });
  const confirm = dialog.getByRole('button', { name: 'Delete entry', exact: true });
  await confirm.click();
  await expect(dialog.getByRole('alert')).toContainText('Storage is temporarily unavailable. Try again.');
  await expect(page.locator('.agreement-card')).toHaveCount(1);
  await confirm.click(); await expect(dialog).toHaveCount(0);
  await expect(page.locator('.agreement-card')).toHaveCount(0);
  await page.reload(); await page.getByRole('button', { name: 'Agreements', exact: true }).click();
  await expect(page.getByText('No agreements yet.', { exact: false })).toBeVisible();
  expect(deletes).toBe(2);
});

test('HTTP/SSE reconnect disables old decisions and resynchronizes without a new Start', async ({ page }) => {
  let starts = 0; let snapshots = 0; let streams = 0;
  const waiting = structuredClone(awaitingApprovalFixture);
  waiting.lastEventSequence = 0;
  waiting.pendingApproval!.createdAt = new Date(Date.now() - 1000).toISOString();
  waiting.pendingApproval!.expiresAt = new Date(Date.now() + 60_000).toISOString();
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()); const path = url.pathname;
    if (path.startsWith('/api/v1/contacts')) return route.continue();
    if (path.endsWith('/readiness')) return route.fulfill({ json: { mode: 'simulator', ready: true, voiceEngine: null, capabilities: [], checks: [] } });
    if (path.endsWith('/settings')) return route.fulfill({ json: { defaultCallLimits: reviewPlanFixture.request.callLimits, transcriptRetentionDays: 30 } });
    if (path.endsWith('/history')) return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path.endsWith('/plans')) return route.fulfill({ json: { plan: { ...reviewPlanFixture, request: route.request().postDataJSON() } } });
    if (path === '/api/v1/calls') { starts++; expect(route.request().headers()['idempotency-key']).toBeTruthy(); return route.fulfill({ json: { call: waiting } }); }
    if (path.endsWith('/events')) {
      streams++;
      expect(route.request().headers()['last-event-id']).toBe('0');
      const event = { ...transcriptEventFixture, sequence: 2 };
      return route.fulfill({ contentType: 'text/event-stream', body: 'event: callmate\nid: 2\ndata: ' + JSON.stringify(event) + '\n\n' });
    }
    snapshots++;
    // Give the UI time to display its disconnected state before returning the final snapshot.
    if (snapshots > 1) await new Promise(resolve => setTimeout(resolve, 800));
    return route.fulfill({ json: { call: snapshots === 1 ? waiting : confirmedCallFixture } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Book a haircut', exact: true }).click();
  await page.getByRole('button', { name: 'Prepare the plan', exact: true }).click();
  await page.getByRole('button', { name: 'Request', exact: true }).click();
  await page.getByLabel('Approved name', { exact: true }).fill('Alex');
  await page.getByRole('button', { name: 'Review call plan', exact: true }).click();
  await page.getByRole('button', { name: 'Call', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approve this offer' }).last()).toBeDisabled();
  await expect(page.getByText(/^Call updates are disconnected\./)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Confirmed', exact: true })).toBeVisible();
  expect(starts).toBe(1); expect(streams).toBe(1); expect(snapshots).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('button', { name: 'Approve this offer' }).last()).toHaveCount(0);
  await page.getByRole('button', { name: 'View in Summary', exact: true }).click();
  await expect(page.getByText(/Yes, it is booked under Alex.s name\./)).toHaveCount(2);
});


test('a lost Start response reuses the same idempotency key after refresh', async ({ page }) => {
  const keys: string[] = [];
  const started = structuredClone(awaitingApprovalFixture);
  started.pendingApproval!.createdAt = new Date(Date.now() - 1000).toISOString();
  started.pendingApproval!.expiresAt = new Date(Date.now() + 60_000).toISOString();
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/v1/contacts')) return route.continue();
    if (path.endsWith('/readiness')) return route.fulfill({ json: { mode: 'simulator', ready: true, voiceEngine: null, capabilities: [], checks: [] } });
    if (path.endsWith('/settings')) return route.fulfill({ json: { defaultCallLimits: reviewPlanFixture.request.callLimits, transcriptRetentionDays: 30 } });
    if (path.endsWith('/history')) return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path.endsWith('/plans')) return route.fulfill({ json: { plan: { ...reviewPlanFixture, request: route.request().postDataJSON() } } });
    if (path === '/api/v1/calls') {
      keys.push(route.request().headers()['idempotency-key']!);
      if (keys.length === 1) return route.abort('failed');
      return route.fulfill({ json: { call: started } });
    }
    if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': heartbeat\n\n' });
    return route.fulfill({ json: { call: started } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Book a haircut', exact: true }).click();
  await page.getByRole('button', { name: 'Prepare the plan', exact: true }).click();
  await page.getByRole('button', { name: 'Request', exact: true }).click();
  await page.getByLabel('Approved name', { exact: true }).fill('Alex');
  await page.getByRole('button', { name: 'Review call plan', exact: true }).click();
  await page.getByRole('button', { name: 'Call', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check original Start request' })).toBeEnabled();
  await page.reload();
  await page.getByRole('button', { name: 'Check original Start request' }).click();
  await expect(page.getByRole('heading', { name: 'Approve this exact alternative?' }).last()).toBeVisible();
  expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
});

test('the Home header omits the mode badge without starting a call', async ({ page }) => {
  let starts = 0;
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/v1/contacts')) return route.continue();
    if (path.endsWith('/readiness')) return route.fulfill({ json: { mode: 'live', ready: false, voiceEngine: null, capabilities: [], checks: [] } });
    if (path.endsWith('/settings')) return route.fulfill({ json: { defaultCallLimits: reviewPlanFixture.request.callLimits, transcriptRetentionDays: 30 } });
    if (path.endsWith('/history')) return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/v1/calls') starts++;
    return route.abort();
  });
  await page.goto('/');
  await expect(page.locator('header .mode-badge')).toHaveCount(0);
  await expect(page.locator('header')).not.toContainText('No drama. Zeus will llama.');
  await expect(page.getByRole('heading', { name: 'Leave the call to Zeus.' })).toBeVisible();
  await page.getByLabel('Home goal', { exact: true }).fill('Call my clinic and ask about documents.');
  await page.getByLabel('Name', { exact: true }).fill('My clinic');
  await page.getByLabel('Phone number', { exact: true }).fill('612 345 678');
  await page.getByRole('button', { name: 'Prepare the plan', exact: true }).click();
  await expect(page.getByText("Couldn't understand everything — fill in the details", { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByLabel('Goal', { exact: true })).toHaveValue('Call my clinic and ask about documents.');
  expect(starts).toBe(0);
});


test('a backend-adjusted plan stays editable and needs another Call before dialing', async ({ page }) => {
  let starts = 0;
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/v1/contacts')) return route.continue();
    if (path.endsWith('/readiness')) return route.fulfill({ json: { mode: 'simulator', ready: true, voiceEngine: null, capabilities: [], checks: [] } });
    if (path.endsWith('/settings')) return route.fulfill({ json: { defaultCallLimits: reviewPlanFixture.request.callLimits, transcriptRetentionDays: 30 } });
    if (path.endsWith('/history')) return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path.endsWith('/plans')) return route.fulfill({ json: { plan: { ...reviewPlanFixture, request: { ...route.request().postDataJSON(), service: 'corte de pelo' } } } });
    if (path === '/api/v1/calls') { starts++; return route.fulfill({ json: { call: awaitingApprovalFixture } }); }
    if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': heartbeat\n\n' });
    return route.fulfill({ json: { call: awaitingApprovalFixture } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Book a haircut', exact: true }).click();
  await page.getByRole('button', { name: 'Prepare the plan', exact: true }).click();
  await page.getByRole('button', { name: 'Review call plan', exact: true }).click();
  await page.getByRole('button', { name: 'Call', exact: true }).click();
  await expect(page.getByText('The backend adjusted the plan.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Edit details', exact: true }).click();
  await expect(page.getByLabel('Requested service', { exact: true })).toHaveValue('corte de pelo');
  expect(starts).toBe(0);
  await page.getByRole('button', { name: 'Call', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop call', exact: true })).toBeVisible();
  expect(starts).toBe(1);
});

for (const failure of ['network', 'empty-proxy-error'] as const) {
  test(`unreachable Live backend (${failure}) offers Simulator and preserves the shared draft`, async ({ page }) => {
    const logs: string[] = []; const crashes: string[] = [];
    page.on('console', message => logs.push(message.text())); page.on('pageerror', error => crashes.push(error.message));
    await page.route('**/api/v1/**', route => {
      if (new URL(route.request().url()).pathname.startsWith('/api/v1/contacts')) return route.continue();
      return failure === 'network' ? route.abort('connectionrefused') : route.fulfill({ status: 500, body: '' });
    });
    await page.goto('/');
    const alert = page.getByRole('alert');
    await expect(alert).toContainText("Can't reach the Zeus backend. Check that it's running, or switch to Simulator in Settings.");
    if (failure === 'empty-proxy-error') await expect(alert).toContainText('HTTP 500');
    const fallback = page.getByRole('button', { name: 'Switch to Simulator', exact: true });
    await expect(fallback).toBeEnabled();
    await page.getByLabel('Home goal', { exact: true }).fill('Ask the clinic about opening hours.');
    await page.getByLabel('Name', { exact: true }).fill('Clinic Sol');
    await page.getByLabel('Phone number', { exact: true }).fill('612 345-678');
    await fallback.click(); await expect(alert).toHaveCount(0);
    await expect(page.getByLabel('Home goal', { exact: true })).toHaveValue('Ask the clinic about opening hours.');
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Clinic Sol');
    await expect(page.getByLabel('Phone number', { exact: true })).toHaveValue('612345678');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Simulator', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(logs.filter(line => line.includes('[Zeus API] Live API base:'))).toHaveLength(1);
    expect(logs.some(line => line.includes('/api/v1/readiness') && line.includes('status:'))).toBe(true);
    expect(crashes).toEqual([]);
    await page.reload(); await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Simulator', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });
}
for (const response of ['empty-json', 'html'] as const) {
  test(`a successful ${response} response cannot become fake readiness or crash the UI`, async ({ page }) => {
    const crashes: string[] = []; page.on('pageerror', error => crashes.push(error.message));
    await page.route('**/api/v1/**', route => {
      if (new URL(route.request().url()).pathname.startsWith('/api/v1/contacts')) return route.continue();
      return route.fulfill({ status: 200, contentType: response === 'html' ? 'text/html' : 'application/json', body: response === 'html' ? '<html>Vite fallback page</html>' : '' });
    });
    await page.goto('/');
    await expect(page.getByRole('alert')).toContainText('HTTP 200');
    await expect(page.getByRole('alert')).not.toContainText('Unexpected end of JSON input');
    await expect(page.getByLabel('Home goal', { exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Call', exact: true })).toHaveCount(0);
    expect(crashes).toEqual([]);
  });
}

test('an unreachable backend after a lost Start keeps Simulator switching locked and preserves the command', async ({ page }) => {
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/v1/contacts')) return route.continue();
    if (path.endsWith('/readiness')) return route.fulfill({ json: { mode: 'live', ready: true, voiceEngine: null, capabilities: [], checks: [] } });
    if (path.endsWith('/settings')) return route.fulfill({ json: { defaultCallLimits: reviewPlanFixture.request.callLimits, transcriptRetentionDays: 30 } });
    if (path.endsWith('/history')) return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path.endsWith('/plans')) return route.fulfill({ json: { plan: { ...reviewPlanFixture, request: route.request().postDataJSON() } } });
    return route.abort('connectionrefused');
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Book a haircut', exact: true }).click();
  await page.getByRole('button', { name: 'Prepare the plan', exact: true }).click();
  await page.getByRole('button', { name: 'Review call plan', exact: true }).click();
  await page.getByRole('button', { name: 'Call', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText("Can't reach the Zeus backend.");
  await expect(page.getByRole('button', { name: 'Switch to Simulator', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Check original Start request', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => !!localStorage.getItem('zeus-llama.pending-start.v1'))).toBe(true);
});
