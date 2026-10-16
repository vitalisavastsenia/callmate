import { expect, test, type Page } from './fixtures';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true }).last();
async function prepare(page: Page, scenario = 'within_plan') {
  await page.goto('/');
  await button(page, 'Book a haircut').click();
  await button(page, 'Prepare the plan').click();
  await expect(page.getByRole('heading', { name: 'Zeus will…', exact: true })).toBeVisible();
  await button(page, 'Request').click();
  await page.getByLabel('Approved name', { exact: true }).fill('Alex Example');
  await button(page, 'Settings').click();
  await page.getByLabel('Simulated outcome', { exact: true }).selectOption(scenario);
  await button(page, 'Request').click();
  await button(page, 'Review call plan').click();
}
async function start(page: Page, keepWindow = false) {
  if (await button(page, 'Review call plan').isVisible()) await button(page, 'Review call plan').click();
  await button(page, 'Call').click();
  await expect(button(page, 'Stop call')).toBeVisible();
  if (!keepWindow) await page.getByRole('dialog').getByRole('button', { name: 'Minimize call', exact: true }).click();
}
async function advance(page: Page, count: number) {
  for (let i = 0; i < count; i++) await page.clock.runFor(2000);
}
async function historyDetail(page: Page) {
  await button(page, 'View in Summary').click();
  await expect(page.getByRole('heading', { name: 'Call history', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Call details', exact: true })).toBeVisible();
}

test('call popup follows both speakers and agent actions, minimizes and reopens without redial', async ({ page }) => {
  await page.clock.install(); await prepare(page, 'above_price'); await start(page, true);
  const popup = page.getByRole('dialog', { name: 'Call with Example barbershop', exact: true });
  await expect(popup).toBeVisible();
  await expect(popup.getByText('No agent decision has been reported yet.', { exact: true })).toBeVisible();
  await advance(page, 5);
  const transcript = popup.getByRole('log', { name: 'Call transcript', exact: true });
  await expect(transcript.locator('.transcript-assistant')).toContainText(['Agent · Zeus']);
  await expect(transcript.locator('.transcript-business').first()).toContainText('Good morning. How can I help?');
  const actions = popup.getByRole('region', { name: 'Agent decisions and actions', exact: true });
  await expect(actions).toContainText('Agent paused for your approval');
  await expect(actions).toContainText('The service price exceeds your approved maximum.');
  await expect(actions).not.toContainText('Business confirmation recorded');
  expect(await popup.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('call-popup.png') });
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem('zeus-llama.active-attempt.v1') ?? 'null')?.id);
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'View call · In progress', exact: true })).toBeFocused();
  await button(page, 'Settings').click();
  await page.getByRole('button', { name: 'View call · In progress', exact: true }).click();
  await popup.getByRole('button', { name: 'Approve this offer', exact: true }).click();
  await expect(popup.getByRole('log')).toContainText('You answered: Approve this offer');
  await expect(actions).not.toContainText('Business confirmation recorded');
  await advance(page, 3);
  await expect(actions).toContainText('Business confirmation recorded');
  await expect(popup.getByRole('heading', { name: 'Confirmed', exact: true })).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Stop call', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zeus-llama.simulator.v1')!).sessions.map((s: { call: { id: string } }) => s.call.id))).toEqual([id]);
  await popup.getByRole('button', { name: 'View in Summary', exact: true }).click();
  await expect(popup).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Call details', exact: true })).toBeVisible();
});

test('call popup restores the same call after reload and Stop remains available', async ({ page }) => {
  await page.clock.install(); await prepare(page, 'above_price'); await start(page, true); await advance(page, 5);
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem('zeus-llama.active-attempt.v1') ?? 'null')?.id);
  await page.reload();
  const popup = page.getByRole('dialog');
  await expect(popup).toBeVisible();
  await expect(popup.getByRole('region', { name: 'Agent decisions and actions' })).toContainText('Agent paused for your approval');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zeus-llama.active-attempt.v1') ?? 'null')?.id)).toBe(id);
  await popup.getByRole('button', { name: 'Stop call', exact: true }).click();
  await expect(popup.getByRole('heading', { name: 'Not booked', exact: true })).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Approve this offer', exact: true })).toHaveCount(0);
});

test('call popup starts a new attempt from the same reviewed request after Stop', async ({ page }) => {
  await page.clock.install(); await prepare(page, 'above_price'); await start(page, true); await advance(page, 5);
  const popup = page.getByRole('dialog');
  await expect(popup.getByRole('button', { name: 'Call again', exact: true })).toHaveCount(0);
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('zeus-llama.simulator.v1')!).sessions[0].call);
  await popup.getByRole('button', { name: 'Stop call', exact: true }).click();
  const again = popup.getByRole('button', { name: 'Call again', exact: true });
  await expect(again).toBeEnabled();
  await again.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('call-again.png') });
  await again.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(popup.getByRole('button', { name: 'Stop call', exact: true })).toBeVisible();
  await expect(again).toHaveCount(0);
  const after = await page.evaluate(() => ({ id: JSON.parse(localStorage.getItem('zeus-llama.active-attempt.v1') ?? 'null')?.id, sessions: JSON.parse(localStorage.getItem('zeus-llama.simulator.v1')!).sessions }));
  expect(after.id).not.toBe(before.id);
  expect(after.sessions).toHaveLength(2);
  const previous = after.sessions.find((s: { call: { id: string } }) => s.call.id === before.id).call;
  const current = after.sessions.find((s: { call: { id: string } }) => s.call.id === after.id).call;
  expect(previous.callState).toBe('ended'); expect(previous.messages).toEqual(before.messages);
  expect(current.plan.request).toEqual(before.plan.request);
  expect(current.messages).toHaveLength(0);
  await popup.getByRole('button', { name: 'Stop call', exact: true }).click();
});

test('inline request → exact approval → result → history, calendar, deletion, and Repeat', async ({ page }) => {
  const network: string[] = []; page.on('request', r => {
    const path = new URL(r.url()).pathname;
    // Server settings and contacts are shared even in browser Simulator mode.
    if (r.method() === 'GET' && ['/api/v1/settings/call-engine', '/api/v1/settings/llm'].includes(path)) return;
    if (path.startsWith('/api/') && !path.startsWith('/api/v1/contacts') && !path.startsWith('/api/auth/')) network.push(r.url());
  });
  await page.clock.install(); await prepare(page, 'above_price'); await start(page); await advance(page, 5);
  await expect(page.getByRole('heading', { name: 'Approve this exact alternative?' }).last()).toBeVisible();
  await expect(page.getByText('Offered service price €35.00; your maximum €30.00.')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('inline-approval.png'), fullPage: true });
  await button(page, 'Approve this offer').click();
  await expect(page.getByRole('heading', { name: 'Confirmed', exact: true })).toHaveCount(0);
  await advance(page, 3);
  await expect(page.getByRole('heading', { name: 'Confirmed', exact: true })).toBeVisible();
  await expect(button(page, 'Stop call')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Zeus will…', exact: true })).toHaveCount(0);
  await historyDetail(page);
  const details = page.getByRole('region', { name: 'Call details', exact: true });
  await expect(details.getByRole('heading', { name: 'Agreements', exact: true })).toBeVisible();
  await expect(details.getByRole('log', { name: 'Call transcript' })).toBeVisible();
  const download = page.waitForEvent('download');
  await details.getByRole('button', { name: 'Download calendar (.ics)', exact: true }).click();
  const artifact = await download;
  expect(artifact.suggestedFilename()).toMatch(/zeus-llama-.*\.ics/);
  const chunks: Buffer[] = [];
  for await (const chunk of (await artifact.createReadStream())!) chunks.push(chunk);
  const calendar = Buffer.concat(chunks).toString('utf8').replace(/\r\n /g, '');
  expect(calendar).toContain('SUMMARY:[Simulation] ');
  expect(calendar).toContain('No real business appointment was confirmed.');
  expect(calendar).toContain('STATUS:TENTATIVE');
  await expect(details.getByText('Duration is unknown.', { exact: false })).toBeVisible();
  await details.getByRole('button', { name: 'Delete conversation text', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Delete conversation text?', exact: true });
  await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(details.getByRole('log')).toContainText('Good morning');
  await details.getByRole('button', { name: 'Delete conversation text', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Permanently delete conversation text', exact: true }).click();
  await expect(details.getByText('Conversation text was deleted. Booking details remain.', { exact: true })).toBeVisible();
  await button(page, 'Repeat').click();
  await expect(page.getByLabel('Goal', { exact: true })).toHaveValue(/Book a haircut/);
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Example barbershop');
  await expect(page.getByLabel('Country code', { exact: true })).toHaveValue('+1');
  await expect(page.getByLabel('Phone number', { exact: true })).toHaveValue('2025550123');
  await expect(page.getByRole('heading', { name: 'Zeus will…', exact: true })).toHaveCount(0);
  await expect(button(page, 'Stop call')).toHaveCount(0);
  expect(network).toEqual([]);
});

test('uncertainty stays explicit and never enables calendar export or automatic repeat', async ({ page }) => {
  await page.clock.install(); await prepare(page, 'uncertain'); await start(page); await advance(page, 5);
  await button(page, 'Approve this offer').click(); await advance(page, 3);
  await expect(page.getByRole('heading', { name: 'Uncertain — check before trying again', exact: true })).toBeVisible();
  await expect(button(page, 'Download calendar (.ics)')).toHaveCount(0);
  await expect(page.getByText('The result is uncertain.', { exact: false })).toBeVisible();
  await historyDetail(page);
  await button(page, 'Repeat').click();
  await expect(page.getByText('This earlier result was uncertain.', { exact: false })).toBeVisible();
  await expect(button(page, 'Stop call')).toHaveCount(0);
  const calls = await page.evaluate(() => JSON.parse(localStorage.getItem('zeus-llama.simulator.v1')!).sessions.length);
  expect(calls).toBe(1);
});

test('Stop and repeated Call cannot create a second attempt', async ({ page }) => {
  await prepare(page);
  await button(page, 'Call').dblclick();
  await expect(button(page, 'Stop call')).toBeVisible();
  await button(page, 'Stop call').click();
  await expect(page.getByRole('heading', { name: 'Not booked', exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close call window', exact: true }).click();
  await button(page, 'Summary').click();
  await expect(page.getByRole('button', { name: /^View details/ })).toHaveCount(1);
});

test('refresh restores the same inline approval and expiry never accepts it', async ({ page }) => {
  await page.clock.install(); await prepare(page, 'alternative'); await start(page); await advance(page, 5);
  await expect(button(page, 'Approve this offer')).toBeVisible();
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem('zeus-llama.active-attempt.v1') ?? 'null')?.id);
  await page.reload(); await expect(button(page, 'Approve this offer')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zeus-llama.active-attempt.v1') ?? 'null')?.id)).toBe(id);
  await page.clock.runFor(31_000);
  await expect(page.getByRole('heading', { name: 'Not booked', exact: true })).toBeVisible();
  await expect(button(page, 'Approve this offer')).toHaveCount(0);
});

test('changed offers require a fresh exact decision', async ({ page }) => {
  await page.clock.install(); await prepare(page, 'changed_offer'); await start(page); await advance(page, 5);
  await expect(page.getByText('Offered service price €35.00; your maximum €30.00.')).toBeVisible();
  await page.clock.runFor(8000);
  await expect(page.getByText('Offered service price €40.00; your maximum €30.00.')).toBeVisible();
  await expect(page.getByText('Approval required · Offer version 2').last()).toBeVisible();
  await button(page, 'Reject offer').click();
  await expect(page.getByRole('heading', { name: 'Not booked', exact: true })).toBeVisible();
});

test('Home keeps natural-language flow and incomplete parsing opens the manual Request', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button')).toHaveText(['Home', 'Request', 'Summary', 'Agreements', 'Contacts', 'Settings']);
  await expect(page.locator('header .mode-badge')).toHaveCount(0);
  const hero = page.getByRole('region', { name: 'Leave the call to Zeus.', exact: true });
  await expect(hero.locator('.eyebrow')).toHaveText('No drama. Zeus will llama.');
  await expect(page.getByRole('region', { name: 'How it works', exact: true })).toHaveCount(0);
  await expect(button(page, 'Prepare the plan')).toBeDisabled();
  await page.getByLabel('Home goal', { exact: true }).fill('Book a haircut next Tuesday after 5 pm, up to 30 euros.');
  await page.getByLabel('Name', { exact: true }).fill('Example business');
  await page.getByLabel('Phone number', { exact: true }).fill('612 345 678');
  await button(page, 'Prepare the plan').click();
  await expect(page.getByText("Couldn't understand everything — fill in the details", { exact: true })).toBeVisible();
  await expect(button(page, 'Request')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByLabel('Country code', { exact: true })).toHaveValue('+34');
  await expect(page.getByLabel('Requested service', { exact: true })).toHaveValue('Haircut');
  await expect(page.getByLabel('Maximum service price (EUR)', { exact: true })).toHaveValue('30');
  await expect(page.getByLabel('From 1', { exact: true })).toHaveValue('17:00');
  await expect(page.getByLabel('Until 1', { exact: true })).toHaveValue('');
  await page.getByLabel('Name', { exact: true }).fill('Example business');
  await page.getByLabel('Phone number', { exact: true }).fill('612 345 678');
  await page.getByLabel('Until 1', { exact: true }).fill('19:00');
  await button(page, 'Review call plan').click();
  await expect(page.getByRole('heading', { name: 'Zeus will…', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('manual-request.png'), fullPage: true });
});

test('editable plan gates Call, supports quick boundaries, and preserves edits across navigation', async ({ page }) => {
  await prepare(page);
  await page.getByLabel('Until 1', { exact: true }).fill('16:00');
  await expect(button(page, 'Call')).not.toBeVisible();
  await expect(button(page, 'Review call plan')).toBeDisabled();
  await expect(page.getByLabel('Until 1', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Until 1', { exact: true }).fill('19:00');
  const approvalRules = ['Different day or time', 'Price above my limit', 'Any deposit or prepayment', 'Sharing extra personal data', 'Anything not in my request'];
  for (const [index, rule] of approvalRules.entries()) {
    await button(page, '+ ' + rule).click();
    await expect(page.getByLabel(`Approval boundary ${index + 2}`, { exact: true })).toHaveValue(rule);
    await expect(button(page, '+ ' + rule)).toHaveCount(0);
  }
  await button(page, 'Remove approval boundary 6').click();
  await expect(button(page, '+ Anything not in my request')).toBeEnabled();
  await page.getByRole('group', { name: 'Must ask me first', exact: true }).getByRole('button', { name: '+ Add custom…', exact: true }).click();
  await expect(button(page, 'Call')).not.toBeVisible();
  await page.getByLabel('Approval boundary 6', { exact: true }).fill('Ask before accepting a cancellation fee.');
  await expect(page.getByText('Zeus only decides what you allow here. Everything else, he asks you first.', { exact: true })).toBeVisible();
  await expect(page.locator('.advanced-limits')).not.toHaveAttribute('open');
  await expect(page.locator('.advanced-overview')).toContainText('min max');
  await page.getByLabel('Requested service', { exact: true }).fill('Wash and trim');
  await button(page, 'Summary').click(); await button(page, 'Request').click();
  await expect(page.getByLabel('Requested service', { exact: true })).toHaveValue('Wash and trim');
  await button(page, 'Review call plan').click();
  await expect(button(page, 'Call')).toBeEnabled();
  await page.getByText('Advanced settings', { exact: true }).click();
  await page.getByLabel('Timezone', { exact: true }).fill('Invalid/Zone');
  await expect(button(page, 'Call')).not.toBeVisible();
  await page.getByLabel('Timezone', { exact: true }).fill('Europe/Madrid');
  await page.getByLabel('Maximum call duration (minutes)', { exact: true }).fill('0.1');
  await expect(button(page, 'Call')).not.toBeVisible();
  await page.getByLabel('Maximum call duration (minutes)', { exact: true }).fill('3');
  await page.getByLabel('Maximum estimated call cost (EUR)', { exact: true }).fill('1.50');
  await page.getByText('Advanced settings', { exact: true }).click();
  await expect(page.getByLabel('Maximum call duration (minutes)', { exact: true })).toBeHidden();
  await expect(page.locator('.advanced-overview')).toHaveText('Europe/Madrid · 3 min max · €1.50 max');
  await button(page, 'Review call plan').click();
  await expect(button(page, 'Call')).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath('inline-plan.png'), fullPage: true });
});

test('information requests prepare questions and keep honest generic outcomes', async ({ page }) => {
  await page.clock.install(); await page.goto('/');
  await button(page, 'Ask a clinic about documents').click(); await button(page, 'Prepare the plan').click();
  await button(page, 'Request').click();
  await expect(page.getByLabel('Question 1', { exact: true })).toHaveValue(/documents/);
  await expect(page.getByLabel('Requested service', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Date 1', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Maximum estimated call cost (EUR)', { exact: true })).not.toBeVisible();
  await start(page); await advance(page, 7);
  await expect(page.getByRole('heading', { name: 'Follow-up needed', exact: true })).toBeVisible();
  await historyDetail(page);
  await expect(page.getByText('Still needs confirmation', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download calendar (.ics)', exact: true })).not.toBeVisible();
  await button(page, 'Repeat').click(); await button(page, 'Review call plan').click();
  await button(page, 'Remove question 2').click(); await button(page, 'Remove question 1').click();
  await expect(button(page, 'Call')).not.toBeVisible();
  await expect(button(page, 'Review call plan')).toBeDisabled();
  await expect(page.getByText('Add at least one question and complete every question.', { exact: true })).toBeVisible();
});

test('change/cancel and other goals exclude booking-only data without changing wire formats', async ({ page }) => {
  await page.goto('/'); await button(page, 'Reschedule a vet visit').click(); await button(page, 'Prepare the plan').click();
  await button(page, 'Request').click();
  await expect(page.getByLabel('Existing booking reference', { exact: true })).toHaveValue('VET-123');
  await button(page, 'Remove window 1').click();
  await page.getByLabel('What to change or cancel', { exact: true }).fill('Cancel the existing visit without fees.');
  await button(page, 'Review call plan').click();
  await expect(button(page, 'Call')).toBeEnabled();
  await page.getByRole('button', { name: 'Other', exact: true }).click();
  await page.getByLabel('Goal', { exact: true }).fill('Leave a message asking them to email me.');
  await button(page, 'Review call plan').click();
  await button(page, 'Call').click();
  await expect(button(page, 'Stop call')).toBeVisible();
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('zeus-llama.simulator.v1')!).plans.at(-1).request);
  expect(request.requestType).toBe('other'); expect(request.changeRequest).toBeNull();
  expect(request.questions).toEqual([]); expect(request.availability).toEqual([]); expect(request.service).toBe('');
  expect(request.pricePolicy.maximum).toBeNull(); expect(request.bookingAuthority).toBe('ask_before_accepting');
  expect(request.callLimits.maxEstimatedCost.currency).toBe('EUR');
});

test('Prepare derives highlighted details and re-preparing preserves manual changes', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-15T10:00:00Z') }); await page.goto('/'); await button(page, 'Request').click();
  await page.getByRole('button', { name: 'Book an appointment', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Example barber');
  await page.getByLabel('Phone number', { exact: true }).fill('612345678');
  await page.getByLabel('Goal', { exact: true }).fill('Book a haircut next Tuesday between 5 and 7 pm, up to €30. Zeus may choose a slot in that window. Do not accept a deposit.');
  await button(page, 'Fill details from goal').click();
  await expect(page.getByLabel('Requested service', { exact: true })).toHaveValue('Haircut');
  await expect(page.getByLabel('Requested service', { exact: true })).toHaveAttribute('data-auto-filled', 'true');
  await expect(page.getByLabel('Maximum service price (EUR)', { exact: true })).toHaveValue('30');
  await expect(page.getByLabel('Date 1', { exact: true })).toHaveValue('2026-10-20');
  await expect(page.getByLabel('From 1', { exact: true })).toHaveValue('17:00');
  await expect(page.getByLabel('Until 1', { exact: true })).toHaveValue('19:00');
  await expect(page.getByLabel('Approval boundary 1', { exact: true })).toHaveValue('Do not accept a deposit.');
  await page.getByLabel('Requested service', { exact: true }).fill('Wash and trim');
  await page.getByLabel('From 1', { exact: true }).fill('18:00');
  await page.getByLabel('Goal', { exact: true }).fill('Book a vet appointment tomorrow after 6 pm. Ask me before confirming.');
  await button(page, 'Fill details from goal').click();
  await expect(page.getByLabel('Requested service', { exact: true })).toHaveValue('Wash and trim');
  await expect(page.getByLabel('Requested service', { exact: true })).not.toHaveAttribute('data-auto-filled', 'true');
  await expect(page.getByLabel('Maximum service price (EUR)', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Date 1', { exact: true })).toHaveValue('2026-10-16');
  await expect(page.getByLabel('From 1', { exact: true })).toHaveValue('18:00');
  await expect(page.getByLabel('Until 1', { exact: true })).toHaveValue('');
  await expect(button(page, 'Call')).not.toBeVisible();
});

test('Settings owns remembered share defaults and preserves request-only edits', async ({ page }) => {
  await page.goto('/'); await button(page, 'Settings').click();
  await page.getByLabel('Default name', { exact: true }).fill('Sam Example');
  await page.getByLabel('Default callback number', { exact: true }).fill('+34612345678');
  await page.getByLabel('Default email', { exact: true }).fill('sam@example.test');
  await button(page, 'Save personal details').click();
  await expect(page.getByText('Settings saved. Personal details apply to new requests and untouched fields.')).toBeVisible();
  await page.getByLabel('Default timezone', { exact: true }).fill('Atlantic/Canary');
  await page.getByLabel('Default maximum call duration (minutes)', { exact: true }).fill('2.5');
  await page.getByLabel('Default maximum call cost (EUR)', { exact: true }).fill('1.50');
  await button(page, 'Save settings').click();
  await expect(page.getByText('Settings saved. Limits apply to new requests and untouched fields.')).toBeVisible();
  await button(page, 'Request').click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Phone number', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Approved name', { exact: true })).toHaveValue('Sam Example');
  await expect(page.locator('.advanced-overview')).toHaveText('Atlantic/Canary · 2.5 min max · €1.50 max');
  await page.getByLabel('Approved name', { exact: true }).fill('For this request');
  await button(page, 'Settings').click();
  await expect(page.getByLabel('Default name', { exact: true })).toHaveValue('Sam Example');
  await button(page, 'Request').click();
  await expect(page.getByLabel('Approved name', { exact: true })).toHaveValue('For this request');
  await page.reload(); await button(page, 'Request').click();
  await expect(page.getByLabel('Approved name', { exact: true })).toHaveValue('Sam Example');
  await button(page, 'Settings').click();
  await page.getByLabel('Default name', { exact: true }).fill('');
  await page.getByLabel('Default callback number', { exact: true }).fill('');
  await page.getByLabel('Default email', { exact: true }).fill('');
  await button(page, 'Save personal details').click();
  await expect(page.getByText('Settings saved. Personal details apply to new requests and untouched fields.')).toBeVisible();
  await page.reload(); await button(page, 'Request').click();
  await expect(page.getByLabel('Approved name', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Approved callback number', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Approved email', { exact: true })).toHaveValue('');
});

test('Summary and Request preserve an active Home call and prevent another attempt', async ({ page }) => {
  await page.clock.install(); await prepare(page); await start(page);
  await button(page, 'Summary').click();
  await expect(button(page, 'Return to active call')).toBeVisible();
  await button(page, 'Return to active call').click();
  await expect(button(page, 'Stop call')).toBeVisible();
  await expect(button(page, 'Prepare the plan')).toBeDisabled();
  await button(page, 'Request').click();
  await expect(button(page, 'Review call plan')).toBeHidden();
  await expect(page.getByLabel('Name', { exact: true })).toBeDisabled();
  await button(page, 'Home').click();
  await button(page, 'Stop call').focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Not booked', exact: true })).toBeVisible();
});

test('Summary surfaces a new approval live, returns to the exact offer, and removes expired attention', async ({ page }) => {
  await page.clock.install(); await prepare(page, 'alternative'); await start(page);
  await button(page, 'Summary').click();
  const attention = page.getByRole('region', { name: 'Needs your attention', exact: true });
  await expect(attention).toHaveCount(0);
  await advance(page, 5);
  await expect(attention).toContainText('Example barbershop');
  await expect(page.locator('.history-card .status-badge')).toHaveText('Waiting for you');
  await expect(page.getByRole('button', { name: 'Repeat for Example barbershop', exact: true })).toBeDisabled();
  await button(page, 'Answer Zeus').click();
  await expect(page.getByRole('heading', { name: 'Approve this exact alternative?' }).last()).toBeVisible();
  await button(page, 'Summary').click();
  await page.screenshot({ path: test.info().outputPath('history-attention.png'), fullPage: true });
  await page.clock.runFor(31_000);
  await expect(attention).toHaveCount(0);
  await expect(page.locator('.history-card .status-badge')).toHaveText('Needed you');
  await expect(page.locator('.history-card .history-summary')).toHaveText('The approval expired. No appointment was booked.');
  await expect(button(page, 'Return to active call')).toHaveCount(0);
});

test('global approval controls work on Settings and leave an acknowledged transcript receipt', async ({ page }) => {
  await page.clock.install(); await prepare(page, 'alternative'); await start(page);
  await button(page, 'Settings').click();
  await expect(button(page, 'Backend')).toBeDisabled();
  await advance(page, 5);
  const panel = page.getByRole('complementary', { name: 'Zeus needs your approval', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('timer')).toContainText('seconds left');
  await expect(panel.getByRole('button', { name: 'Approve this offer', exact: true })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath('settings-approval.png'), fullPage: true });
  await panel.getByRole('button', { name: 'Approve this offer', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await button(page, 'Home').click();
  await expect(page.getByRole('log', { name: 'Call transcript' })).toContainText('You answered: Approve this offer');
  await advance(page, 3);
  await expect(page.getByRole('heading', { name: 'Confirmed', exact: true })).toBeVisible();
  await button(page, 'Settings').click(); await expect(button(page, 'Backend')).toBeEnabled();
});

test('offscreen approval offers direct controls and its countdown never approves on expiry', async ({ page }) => {
  await page.clock.install(); await prepare(page, 'alternative'); await start(page);
  await page.evaluate(() => window.scrollTo(0, 0)); await advance(page, 5);
  const panel = page.getByRole('complementary', { name: 'Zeus needs your approval', exact: true });
  await expect(panel).toBeVisible();
  await expect(page.locator('.request-review-bar')).toBeHidden();
  await panel.getByRole('button', { name: 'Go to the conversation', exact: true }).click();
  await expect(page.getByRole('dialog').locator('.approval-actions')).toBeInViewport();
  await page.getByRole('dialog').getByRole('button', { name: 'Minimize call', exact: true }).click();
  await button(page, 'Summary').click(); await expect(panel).toBeVisible();
  await page.clock.runFor(31_000);
  await expect(panel).toHaveCount(0);
  await expect(page.locator('.history-summary')).toHaveText('The approval expired. No appointment was booked.');
});

test('mode changes keep the shared draft, isolate history, and persist the selection', async ({ page }) => {
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/v1/contacts')) return route.continue();
    if (path.endsWith('/readiness')) return route.fulfill({ json: { mode: 'live', ready: false, voiceEngine: null, capabilities: [], checks: [] } });
    if (path.endsWith('/history')) return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path.endsWith('/settings')) return route.fulfill({ json: { defaultCallLimits: { maxDurationSeconds: 300, maxEstimatedCost: { amountMinor: 200, currency: 'USD' } }, transcriptRetentionDays: 30 } });
    return route.abort();
  });
  await page.goto('/');
  await page.getByLabel('Home goal', { exact: true }).fill('Ask the manager about opening hours.');
  await page.getByLabel('Name', { exact: true }).fill('Clinic Iris');
  await page.getByLabel('Phone number', { exact: true }).fill('612345678');
  await button(page, 'Settings').click(); await button(page, 'Backend').click();
  await expect(button(page, 'Backend')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Default maximum call cost (USD)', { exact: true })).toHaveValue('2');
  await button(page, 'Request').click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Clinic Iris');
  await expect(page.getByLabel('Goal', { exact: true })).toHaveValue('Ask the manager about opening hours.');
  await expect(page.locator('.advanced-overview')).toContainText('US$2.00 max');
  await expect(button(page, 'Fill details from goal')).toHaveCount(0);
  await page.reload(); await button(page, 'Settings').click();
  await expect(button(page, 'Backend')).toHaveAttribute('aria-pressed', 'true');
  await button(page, 'Simulator').click();
  await expect(button(page, 'Simulator')).toHaveAttribute('aria-pressed', 'true');
});

test('background approvals request permission at call start and notify without sending an answer', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    const state = { requests: 0, notifications: [] as { title: string; body: string }[], closed: 0 };
    Object.assign(window, { attentionTest: state });
    class TestNotification {
      static permission = 'default'; onclick: (() => void) | null = null;
      static async requestPermission() { state.requests++; this.permission = 'granted'; return 'granted' as NotificationPermission; }
      constructor(title: string, options: NotificationOptions) { state.notifications.push({ title, body: options.body! }); }
      close() { state.closed++; }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: TestNotification });
  });
  await page.clock.install(); await prepare(page, 'alternative');
  expect(await page.evaluate(() => (window as any).attentionTest.requests)).toBe(0);
  await start(page); await advance(page, 5);
  expect(await page.evaluate(() => (window as any).attentionTest.requests)).toBe(1);
  expect(await page.evaluate(() => (window as any).attentionTest.notifications)).toHaveLength(1);
  await expect.poll(() => page.title()).toBe('⚡ Zeus needs you');
  await button(page, 'Reject offer').click();
  await expect(page.getByRole('heading', { name: 'Not booked', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).attentionTest.closed)).toBe(1);
  await expect.poll(() => page.title()).not.toBe('⚡ Zeus needs you');
});


test('Request cards defer errors, preserve editable rules, and keep the review bar clear', async ({ page }) => {
  await page.goto('/');
  await button(page, 'Request').click();
  const form = page.locator('.manual-request');
  await expect(form.locator('.request-card-title')).toHaveText(['1Who to call', '2What Zeus should do', '3Tone & manner', '4Boundaries', '5What Zeus may share']);
  await expect(form.locator('.field-error')).toHaveCount(0);
  await expect(form.locator('[aria-invalid="true"]')).toHaveCount(0);
  await expect(button(page, 'Review call plan')).toBeDisabled();
  await expect(button(page, 'Fill details from goal')).toBeDisabled();
  const name = page.getByLabel('Name', { exact: true });
  await name.focus(); await name.press('Tab');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(form.getByText('Enter a name', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Goal', { exact: true })).not.toHaveAttribute('aria-invalid', 'true');
  await name.fill('Example business');
  await expect(name).not.toHaveAttribute('aria-invalid', 'true');
  const phone = page.getByLabel('Phone number', { exact: true });
  await phone.fill('123');
  await expect(phone).not.toHaveAttribute('aria-invalid', 'true');
  await phone.press('Tab');
  await expect(phone).toHaveAttribute('aria-invalid', 'true');
  await phone.fill('612 345 678');
  await expect(phone).not.toHaveAttribute('aria-invalid', 'true');
  await button(page, 'Other').click();
  const goal = page.getByLabel('Goal', { exact: true });
  await goal.focus(); await goal.press('Tab');
  await expect(goal).toHaveAttribute('aria-invalid', 'true');
  await goal.fill('Leave a message asking them to email me.');
  await expect(button(page, 'Fill details from goal')).toBeEnabled();
  await expect(form.locator('.field-error')).toHaveCount(0);
  await expect(button(page, 'Review call plan')).toBeEnabled();
  const boundaries = page.getByRole('group', { name: 'Must ask me first', exact: true });
  await boundaries.getByRole('button', { name: '+ Any deposit or prepayment', exact: true }).click();
  await expect(boundaries.getByRole('button', { name: '+ Any deposit or prepayment', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Approval boundary 1', { exact: true })).toHaveValue('Any deposit or prepayment');
  await button(page, 'Remove approval boundary 1').click();
  await expect(boundaries.getByRole('button', { name: '+ Any deposit or prepayment', exact: true })).toBeEnabled();
  await button(page, 'Very polite').click();
  await expect(button(page, 'Very polite')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Notes for Zeus', { exact: true })).toHaveAttribute('rows', '2');
  await expect(goal).toHaveAttribute('rows', '3');
  for (const textarea of await form.locator('textarea').all()) await expect(textarea).toHaveAttribute('data-gramm', 'false');
  // The fixed bar spans the viewport, and its measured space protects the last card.
  const bar = form.locator('.request-review-bar');
  await expect(bar).toBeInViewport();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const geometry = await page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const bar = box('.request-review-bar');
    const name = box('.manual-request input[aria-label="Name"]');
    const phone = box('.manual-request input[aria-label="Phone number"]');
    const code = box('.manual-request select[aria-label="Country code"]');
    const caption = box('.manual-request .share-grid .field-caption');
    const sharedName = box('.manual-request input[aria-label="Approved name"]');
    return { width: innerWidth, left: bar.left, right: bar.right, top: bar.top, bottom: box('.manual-request .advanced-limits').bottom,
      labelGap: sharedName.top - caption.bottom, heights: [name.height, phone.height, code.height], tops: [name.top, phone.top, code.top], overflow: document.documentElement.scrollWidth > innerWidth };
  });
  expect(geometry.left).toBe(0); expect(geometry.right).toBe(geometry.width);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.top);
  expect(geometry.heights.every(height => height === geometry.heights[0])).toBe(true);
  if (geometry.width > 640) expect(Math.max(...geometry.tops) - Math.min(...geometry.tops)).toBeLessThan(1);
  expect(geometry.overflow).toBe(false);
  expect(geometry.labelGap).toBe(8);
  await page.screenshot({ path: test.info().outputPath('request-cards.png'), fullPage: true });
  await button(page, 'Review call plan').click();
  await expect(page.getByRole('heading', { name: 'Zeus will…', exact: true })).toBeVisible();
  await button(page, 'Home').click();
  await expect(bar).not.toBeVisible();
  await expect(page.getByLabel('Home goal', { exact: true })).toHaveValue('Leave a message asking them to email me.');
});

test('Home language selection survives preparation and requires fresh review when changed', async ({ page }) => {
  await page.goto('/');
  const language = page.getByRole('combobox', { name: /^Conversation language/ });
  await expect(language).toBeVisible();
  await expect(language.locator('option')).toHaveCount(4);
  await language.selectOption('ru-RU');
  await button(page, 'Book a haircut').click();
  await button(page, 'Prepare the plan').click();
  await expect(page.locator('.inline-plan')).toContainText('Russian');
  await button(page, 'Edit details').click();
  await expect(language).toHaveValue('ru-RU');
  await language.selectOption('en-US');
  await expect(button(page, 'Call')).toHaveCount(0);
  await button(page, 'Review call plan').click();
  await expect(page.locator('.inline-plan')).toContainText('English');
  await button(page, 'Home').click();
  await expect(language).toHaveValue('en-US');
  await language.selectOption('pl-PL');
  await expect(button(page, 'Call')).toHaveCount(0);
  await button(page, 'Prepare the plan').click();
  await expect(page.locator('.inline-plan')).toContainText('Polish');
  await page.screenshot({ path: test.info().outputPath('home-conversation-language.png'), fullPage: true });
});

test('domain templates review all 15 profiles and preserve the chosen language', async ({ page }) => {
  const { conversationTemplates } = await import('@callmate/contracts');
  await prepare(page);
  const picker = page.getByRole('combobox', { name: 'Conversation template', exact: true });
  await expect(picker.locator('option')).toHaveCount(16);
  const language = page.getByRole('combobox', { name: /^Conversation language/ });
  await language.selectOption('pl-PL');
  for (const profile of conversationTemplates) {
    await picker.selectOption(profile.id);
    await expect(language).toHaveValue('pl-PL');
    if (profile.fields.length) await expect(button(page, 'Review call plan')).toBeDisabled();
    for (const field of profile.fields) {
      const name = new RegExp('^' + field.label);
      if (field.kind === 'choice') await page.getByRole('combobox', { name }).selectOption(field.options![0]!.value);
      else if (field.kind === 'number') await page.getByRole('spinbutton', { name }).fill('2');
      else await page.getByRole('textbox', { name }).fill('Toyota Corolla');
    }
    await expect(button(page, 'Review call plan')).toBeEnabled();
    await button(page, 'Review call plan').click();
    const review = page.locator('.inline-plan');
    await expect(review).toContainText(profile.label); await expect(review).toContainText('Polish');
    for (const field of profile.fields) await expect(review).toContainText(field.kind === 'choice' ? field.options![0]!.label[2] : field.kind === 'number' ? '2' : 'Toyota Corolla');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (profile.id === 'bank') await page.screenshot({ path: test.info().outputPath('bank-template.png'), fullPage: true });
  }
  await page.getByRole('textbox', { name: 'Requested service', exact: true }).fill('Custom service');
  await expect(picker).toHaveValue('');
});

test('USD backend budgets survive Settings save and a real plan/Start request', async ({ page }) => {
  const url = 'http://127.0.0.1:3000/api/v1/settings';
  const previous = await (await page.request.get(url)).json();
  const usd = { ...previous, defaultCallLimits: { maxDurationSeconds: 300, maxEstimatedCost: { amountMinor: 200, currency: 'USD' } } };
  expect((await page.request.put(url, { data: usd })).ok()).toBe(true);
  let id: string | undefined;
  try {
    await page.goto('http://127.0.0.1:5175/');
    await button(page, 'Settings').click();
    const settingCost = page.getByLabel('Default maximum call cost (USD)', { exact: true });
    await expect(settingCost).toHaveValue('2');
    await settingCost.fill('1.75');
    await button(page, 'Save settings').click();
    await expect(page.getByText(/^Settings saved\./)).toBeVisible();
    expect((await (await page.request.get(url)).json()).defaultCallLimits.maxEstimatedCost).toEqual({ amountMinor: 175, currency: 'USD' });
    await button(page, 'Home').click();
    await button(page, 'Book a haircut').click();
    await button(page, 'Request').click();
    await page.getByLabel('Approved name', { exact: true }).fill('Alex Example');
    await page.getByText('Advanced settings', { exact: true }).click();
    await expect(page.getByLabel('Maximum estimated call cost (USD)', { exact: true })).toHaveValue('1.75');
    await expect(page.getByLabel('Maximum service price (EUR)', { exact: true })).toHaveValue('30');
    await button(page, 'Review call plan').click();
    const created = page.waitForResponse(response => response.url().endsWith('/api/v1/plans') && response.request().method() === 'POST');
    const started = page.waitForResponse(response => response.url().endsWith('/api/v1/calls') && response.request().method() === 'POST');
    await button(page, 'Call').click();
    const planResponse = await created;
    expect(planResponse.status()).toBe(201);
    const plan = (await planResponse.json()).plan;
    expect(plan.request.callLimits.maxEstimatedCost).toEqual({ amountMinor: 175, currency: 'USD' });
    expect(plan.request.pricePolicy.maximum.currency).toBe('EUR');
    const startResponse = await started;
    expect(startResponse.status()).toBe(202);
    id = (await startResponse.json()).call.id;
    await expect(button(page, 'Stop call')).toBeVisible();
    await button(page, 'Stop call').click();
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally {
    if (id) await page.request.post(`http://127.0.0.1:3000/api/v1/calls/${id}/stop`, { data: {} });
    expect((await page.request.put(url, { data: previous })).ok()).toBe(true);
  }
});

test('reviewed mock calls require a ready engine and explain where to answer', async ({ page }) => {
  await prepare(page);
  let engineReady = false;
  let starts = 0;
  await page.route('**/api/v1/readiness', route => route.fulfill({ json: {
    mode: 'simulator', ready: true, voiceEngine: engineReady ? 'conversation_relay' : null,
    checks: [], capabilities: [
      { name: 'mock_relay', enabled: true, ready: true },
      { name: 'dialogue_integration', enabled: engineReady, ready: engineReady },
    ],
  } }));
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/v1/calls' && request.method() === 'POST') starts++; });
  await button(page, 'Settings').click(); await button(page, 'Backend').click();
  await expect(page.getByText('Reviewed mock calls need a ready dialogue engine. Check Provider readiness below.')).toBeVisible();
  await expect(page.getByText('Mock calls need an LLM agent', { exact: true })).toBeVisible();
  const readiness = page.locator('#settings-readiness');
  await readiness.locator('summary').click();
  await expect(readiness.getByText('Backend mock calls · Not ready', { exact: true })).toBeVisible();
  await expect(readiness).toContainText('Transport: Ready · Dialogue agent: Not ready.');
  await page.getByRole('link', { name: 'Configure LLM agent', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'LLM agent', exact: true })).toBeInViewport();
  await button(page, 'Request').click(); await button(page, 'Review call plan').click();
  await expect(button(page, 'Call')).toBeDisabled();
  await expect(page.getByText(/Mock calls need a ready dialogue engine/)).toBeVisible();
  await button(page, 'Set up LLM agent').click();
  await expect(page.getByRole('heading', { name: 'LLM agent', exact: true })).toBeInViewport();
  await button(page, 'Request').click();
  engineReady = true;
  await button(page, 'Check readiness again').click();
  await expect(button(page, 'Call')).toBeEnabled();
  await expect(page.getByText(/Local mock call: open localhost:8080/)).toBeVisible();
  expect(starts).toBe(0);
});

test('switching to a different budget currency clears an edited amount and requires review', async ({ page }) => {
  await prepare(page);
  await page.getByText('Advanced settings', { exact: true }).click();
  // Even an explicit amount equal to the default must not be relabeled as USD.
  await page.getByLabel('Maximum estimated call cost (EUR)', { exact: true }).fill('');
  await page.getByLabel('Maximum estimated call cost (EUR)', { exact: true }).fill('2');
  await button(page, 'Review call plan').click();
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/v1/contacts')) return route.continue();
    if (path.endsWith('/readiness')) return route.fulfill({ json: { mode: 'simulator', ready: true, voiceEngine: null, capabilities: [], checks: [] } });
    if (path.endsWith('/history')) return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path.endsWith('/settings')) return route.fulfill({ json: { defaultCallLimits: { maxDurationSeconds: 300, maxEstimatedCost: { amountMinor: 200, currency: 'USD' } }, transcriptRetentionDays: 30 } });
    return route.abort();
  });
  await button(page, 'Settings').click(); await button(page, 'Backend').click();
  await expect(page.getByLabel('Default maximum call cost (USD)', { exact: true })).toHaveValue('2');
  await button(page, 'Request').click();
  const budget = page.getByLabel('Maximum estimated call cost (USD)', { exact: true });
  await expect(budget).toHaveValue('');
  await expect(page.getByText(/^Call budgets now use USD\./)).toBeVisible();
  await expect(button(page, 'Review call plan')).toBeDisabled();
  await expect(button(page, 'Call')).toHaveCount(0);
  await budget.fill('1');
  await button(page, 'Review call plan').click();
  await expect(page.locator('.inline-plan')).toContainText('US$1.00');
  await expect(page.locator('.inline-plan')).toContainText('Maximum €30.00');
});

test('another tab cannot switch away from a saved call and reload restores its transport', async ({ page, context }) => {
  await prepare(page, 'above_price'); await start(page, true);
  await page.getByRole('dialog').getByRole('button', { name: 'Stop call', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close call window', exact: true }).click();
  await page.evaluate(() => localStorage.setItem('zeus-llama.active-attempt.v1', JSON.parse(localStorage.getItem('zeus-llama.simulator.v1')!).sessions[0].call.id));
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByRole('button', { name: 'View call · Finished', exact: true })).toBeVisible();
  await other.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(other.getByRole('button', { name: 'Backend', exact: true })).toBeEnabled();
  await page.bringToFront();
  await page.getByRole('button', { name: 'View call · Finished', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Call again', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Stop call', exact: true })).toBeVisible();
  await expect(other.getByRole('button', { name: 'Backend', exact: true })).toBeDisabled();
  await expect(other.getByRole('button', { name: 'Restore saved call', exact: true })).toBeVisible();
  // A previously saved selection must never override the attempt's transport.
  await other.evaluate(() => localStorage.setItem('zeus-llama.mode.v1', 'live'));
  await page.reload();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Stop call', exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Stop call', exact: true }).click();
  await other.close();
});

test('a transient session check preserves the draft but a verified sign-out locks the UI', async ({ page }) => {
  await page.goto('/');
  const goal = page.getByLabel('Home goal', { exact: true });
  await goal.fill('Keep this unsaved appointment request');
  await page.route('**/api/auth/session', route => route.abort('connectionrefused'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('alert')).toContainText('Your draft is still here');
  await expect(goal).toHaveValue('Keep this unsaved appointment request');
  await page.unroute('**/api/auth/session');
  await page.getByRole('button', { name: 'Retry connection', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(goal).toHaveValue('Keep this unsaved appointment request');
  await page.route('**/api/auth/session', route => route.fulfill({ json: { setupRequired: false, authenticated: false, username: null, expiresAt: null } }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(goal).toHaveCount(0);
});

test('session expiry still locks an offline draft', async ({ page }) => {
  await page.clock.install();
  await page.route('**/api/auth/session', route => route.fulfill({ json: { setupRequired: false, authenticated: true, username: 'e2e-owner', expiresAt: new Date(Date.now() + 5000).toISOString() } }));
  await page.goto('/');
  await page.getByLabel('Home goal', { exact: true }).fill('An offline draft');
  await page.unroute('**/api/auth/session');
  await page.route('**/api/auth/session', route => route.abort('connectionrefused'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('alert')).toContainText('Your draft is still here');
  await page.clock.runFor(6000);
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByLabel('Home goal', { exact: true })).toHaveCount(0);
});

for (const failure of ['read', 'pending-write'] as const) {
  test(`storage ${failure} failure keeps the UI available and prevents Start`, async ({ page }) => {
    const crashes: string[] = []; page.on('pageerror', error => crashes.push(error.message));
    await page.addInitScript(failure => {
      const original = Storage.prototype[failure === 'read' ? 'getItem' : 'setItem'];
      const method = failure === 'read' ? 'getItem' : 'setItem';
      Object.defineProperty(Storage.prototype, method, { configurable: true, value: function (key: string, value?: string) {
        if (failure === 'read' || key === 'zeus-llama.pending-start.v1') throw new DOMException('Storage denied', failure === 'read' ? 'SecurityError' : 'QuotaExceededError');
        return original.call(this, key, value!);
      } });
    }, failure);
    if (failure === 'read') {
      await page.goto('/');
    } else {
      await prepare(page);
      await button(page, 'Call').click();
    }
    await expect(page.getByRole('alert').filter({ hasText: 'Browser storage is unavailable' })).toBeVisible();
    await button(page, 'Settings').click();
    await expect(button(page, 'Backend')).toBeDisabled();
    if (failure === 'pending-write') expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zeus-llama.simulator.v1')!).sessions.length)).toBe(0);
    expect(crashes).toEqual([]);
  });
}

test('storage failure during an existing call preserves Stop', async ({ page }) => {
  await page.clock.install(); await prepare(page, 'above_price'); await start(page, true);
  await page.evaluate(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Full', 'QuotaExceededError'); };
    Storage.prototype.removeItem = () => { throw new DOMException('Denied', 'SecurityError'); };
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Stop call', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Not booked', exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close call window', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Browser storage is unavailable' })).toBeVisible();
});

test('invalid saved state shows recovery instead of a blank root and retains the record', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('zeus-llama.active-attempt.v1', '{"id":null,"transport":"backend"}'));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Zeus Llama could not display this page' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload and restore', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('zeus-llama.active-attempt.v1'))).toBe('{"id":null,"transport":"backend"}');
});
