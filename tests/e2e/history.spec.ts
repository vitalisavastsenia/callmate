import { expect, test, type Page } from './fixtures';
import { confirmedCallFixture, uncertainCallFixture } from '@callmate/contracts/fixtures';
import { CallSnapshotSchema, type CallSnapshot } from '@callmate/contracts';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
function examples(): CallSnapshot[] {
  function call(name: string, index: number, base = confirmedCallFixture): CallSnapshot {
    const result = structuredClone(base);
    result.id = crypto.randomUUID(); result.plan.id = crypto.randomUUID();
    result.plan.request.business.name = name;
    result.createdAt = new Date(Date.parse('2026-10-15T11:00:00Z') - index * 60_000).toISOString();
    return result;
  }
  function information(name: string, index: number, resolved: boolean) {
    const result = call(name, index);
    Object.assign(result.plan.request, { requestType: 'ask', goal: 'Ask which documents I need for a first visit.', timeZone: 'Europe/Madrid',
      service: '', availability: [], questions: ['Which documents should I bring?'],
      tone: ['Friendly'], tone_notes: 'Please be patient.', boundaries: { canDecideAlone: [], mustAskMe: ['Any fees'] } });
    result.activeOffer = null; result.bookingState = 'completed';
    result.outcome = { status: 'completed', resolution: resolved ? 'resolved' : 'needs_follow_up',
      summaryEn: resolved ? 'Bring identification and previous records.' : 'The referral requirement still needs checking.',
      findings: [{ question: 'Which documents should I bring?', answerEn: resolved ? 'Identification and previous records.' : 'The clinic could not confirm.', answered: resolved }],
      nextSteps: resolved ? [] : ['Check the referral requirement.'], evidenceMessageIds: [result.messages[0]!.id] };
    return result;
  }
  const booked = call('Barber Apollo', 0);
  const answered = information('Clinic Sol', 1, true);
  const uncertain = call('Vet Hermes', 2, uncertainCallFixture);
  const failed = call('Garage Atlas', 3);
  failed.callState = 'no_answer'; failed.bookingState = 'not_booked';
  failed.outcome = { status: 'not_booked', reason: 'no_answer', summaryEn: 'The garage did not answer.' };
  const cancelled = call('Salon Hera', 4);
  Object.assign(cancelled.plan.request, { requestType: 'change', goal: 'Reschedule my existing appointment.', timeZone: 'Europe/Madrid',
    changeRequest: { description: 'Move my existing appointment to next week.', bookingReference: 'HERA-123' } });
  cancelled.activeOffer = null; cancelled.bookingState = 'not_booked';
  cancelled.outcome = { status: 'not_booked', reason: 'user_stopped', summaryEn: 'You stopped the call. The existing appointment was not changed.' };
  const followUp = information('Pharmacy Iris', 5, false);
  return [booked, answered, uncertain, failed, cancelled, followUp].map(item => CallSnapshotSchema.parse(item));
}
async function seed(page: Page, calls: CallSnapshot[]) {
  await page.clock.install({ time: new Date('2026-10-15T12:00:00Z') });
  await page.addInitScript(calls => { if (localStorage.getItem('zeus-llama.simulator.v1')) return; localStorage.setItem('zeus-llama.simulator.v1', JSON.stringify({
    plans: calls.map(({ plan }) => ({ id: plan.id, version: plan.version, createdAt: plan.createdAt, request: plan.request })),
    settings: { defaultCallLimits: { maxDurationSeconds: 300, maxEstimatedCost: { amountMinor: 200, currency: 'EUR' } }, transcriptRetentionDays: 30 },
    sessions: calls.map(call => ({ call, scenario: 'within_plan', step: 8, nextAt: 0, changed: false, startKey: call.id,
      startBody: JSON.stringify({ planId: call.plan.id, planVersion: call.plan.version, mode: 'simulator' }), decisions: {}, events: [] })),
  })); }, calls);
  await page.goto('/'); await button(page, 'Summary').click();
}

test('empty Summary offers a request and hides attention and filters', async ({ page }) => {
  await page.goto('/'); await button(page, 'Summary').click();
  const history = page.getByRole('region', { name: 'Call history', exact: true });
  await expect(history.getByText('Zeus is resting. Give him something to do.', { exact: true })).toBeVisible();
  await expect(history.locator('img')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Needs your attention', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Search calls', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('history-empty.png'), fullPage: true });
  await button(page, 'Create a request').click();
  await expect(button(page, 'Home')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByLabel('Home goal', { exact: true })).toHaveValue('');
  await expect(page.getByAltText('Zeus resting', { exact: true })).toHaveCount(0);
  await expect(button(page, 'Stop call')).toHaveCount(0);
});

test('history cards show honest statuses and combine search and filters above five calls', async ({ page }) => {
  await seed(page, examples());
  const cards = page.locator('.history-card');
  await expect(cards).toHaveCount(6);
  for (const [name, status] of [['Barber Apollo', 'Booked'], ['Clinic Sol', 'Answered'], ['Vet Hermes', 'Needed you'], ['Garage Atlas', 'Failed'], ['Salon Hera', 'Cancelled'], ['Pharmacy Iris', 'Needed you']] as const) {
    const card = page.getByRole('article', { name, exact: true });
    await expect(card.locator('.status-badge')).toHaveText(status!);
    await expect(card.locator('time')).toContainText('15 Oct 2026');
    await expect(card.locator('.history-summary')).not.toBeEmpty();
    await expect(card.getByRole('button', { name: /^Repeat/ })).toBeEnabled();
  }
  await expect(page.getByRole('article', { name: 'Clinic Sol' })).toContainText('Ask or find out');
  await expect(page.getByRole('article', { name: 'Salon Hera' })).toContainText('Change or cancel');
  await expect(page.getByRole('article', { name: 'Vet Hermes' })).toContainText('Outcome uncertain — check with the business before repeating.');
  // A future appointment is not a scheduled outbound call or a pending answer.
  await expect(page.getByRole('region', { name: 'Needs your attention', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('history-cards.png'), fullPage: true });
  await page.getByLabel('Search calls', { exact: true }).fill('  CLINIC  ');
  await expect(cards).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('Failed');
  await expect(page.getByText('No calls match your search or status filter.', { exact: true })).toBeVisible();
  await button(page, 'Clear filters').click(); await expect(cards).toHaveCount(6);
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('Needed you');
  await expect(cards).toHaveCount(2);
  await page.getByLabel('Search calls', { exact: true }).fill('referral'); await expect(cards).toHaveCount(1);
  await expect(cards).toContainText('Pharmacy Iris');
});

test('five calls need no filters and card Repeat restores the full editable request without dialing', async ({ page }) => {
  await seed(page, examples().slice(0, 5));
  await expect(page.getByLabel('Search calls', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Status', exact: true })).toHaveCount(0);
  await page.getByRole('article', { name: 'Clinic Sol', exact: true }).getByRole('button', { name: 'Repeat for Clinic Sol', exact: true }).click();
  await expect(button(page, 'Request')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Clinic Sol');
  await expect(page.getByLabel('Country code', { exact: true })).toHaveValue('+1');
  await expect(page.getByLabel('Phone number', { exact: true })).toHaveValue('2025550123');
  await expect(page.getByLabel('Goal', { exact: true })).toHaveValue('Ask which documents I need for a first visit.');
  await expect(button(page, 'Ask or find out')).toHaveAttribute('aria-pressed', 'true');
  await expect(button(page, 'Friendly')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Notes for Zeus', { exact: true })).toHaveValue('Please be patient.');
  await expect(page.getByLabel('Question 1', { exact: true })).toHaveValue('Which documents should I bring?');
  await expect(page.getByLabel('Approval boundary 1', { exact: true })).toHaveValue('Any fees');
  await expect(button(page, 'Call')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zeus-llama.simulator.v1')!).sessions.length)).toBe(5);
});

test('Repeat from an uncertain card preserves the warning and creates no new attempt', async ({ page }) => {
  await seed(page, examples());
  await page.getByRole('article', { name: 'Vet Hermes', exact: true }).getByRole('button', { name: 'Repeat for Vet Hermes', exact: true }).click();
  await expect(page.getByText('This earlier result was uncertain.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Vet Hermes');
  await expect(button(page, 'Call')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zeus-llama.simulator.v1')!).sessions.length)).toBe(6);
});

test('Agreements lists appointments and answered findings and opens their calendar dates and source calls', async ({ page }) => {
  const calls = examples();
  const partial = calls.at(-1)!;
  if (partial.outcome.status !== 'completed') throw new Error();
  partial.outcome.findings.push({ question: 'Opening hours?', answerEn: 'The desk opens at 9 am.', answered: true });
  await seed(page, calls);
  await button(page, 'Agreements').click();
  await expect(button(page, 'Agreements')).toHaveAttribute('aria-current', 'page');
  const view = page.getByRole('region', { name: 'Agreements', exact: true });
  await expect(view.getByRole('article')).toHaveCount(3);
  await expect(view.getByRole('article', { name: 'Barber Apollo', exact: true })).toContainText('20 Oct 2026');
  await expect(view.getByRole('article', { name: 'Clinic Sol', exact: true })).toContainText('Recorded on 15 October 2026');
  const followUp = view.getByRole('article', { name: 'Pharmacy Iris', exact: true });
  await expect(followUp).toContainText('The desk opens at 9 am.');
  await expect(followUp).toContainText('Follow-up needed');
  await expect(followUp).not.toContainText('The clinic could not confirm.');
  await expect(view).not.toContainText('Vet Hermes');
  await expect(view).not.toContainText('Garage Atlas');
  await expect(view.getByRole('article', { name: 'Barber Apollo', exact: true })).toContainText('Simulated appointment');
  await view.getByLabel('Search agreements', { exact: true }).fill('CLINIC');
  await expect(view.getByRole('article')).toHaveCount(1);
  await view.getByLabel('Search agreements', { exact: true }).fill('');
  await view.getByRole('combobox', { name: 'Agreement type', exact: true }).selectOption('appointment');
  await expect(view.getByRole('article')).toHaveCount(1);
  await view.getByRole('combobox', { name: 'Agreement type', exact: true }).selectOption('');
  await button(page, 'Show in calendar for Barber Apollo').click();
  await expect(view.getByRole('button', { name: '20 October 2026, 1 agreement', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(view.getByRole('article')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('agreements-calendar.png'), fullPage: true });
  await button(page, '15 October 2026, 2 agreements').click();
  await expect(view.getByRole('article')).toHaveCount(2);
  await button(page, 'Next month').click(); await expect(view.getByText('No agreements this month.', { exact: true })).toBeVisible();
  await button(page, 'Previous month').click(); await button(page, 'Today').click();
  await expect(view.getByRole('article')).toHaveCount(2);
  await button(page, 'List').click(); await expect(view.getByRole('article')).toHaveCount(3);
  await page.screenshot({ path: test.info().outputPath('agreements-list.png'), fullPage: true });
  await button(page, 'View call details for Barber Apollo').click();
  await expect(button(page, 'Summary')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('region', { name: 'Call details', exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zeus-llama.simulator.v1')!).sessions.length)).toBe(6);
});

test('empty Agreements still offers a usable calendar and survives navigation', async ({ page }) => {
  await page.goto('/'); await button(page, 'Agreements').click();
  const view = page.getByRole('region', { name: 'Agreements', exact: true });
  await expect(view.getByText('No agreements yet.', { exact: false })).toBeVisible();
  await button(page, 'Calendar').click(); await button(page, 'Today').click();
  await expect(view.getByText('No agreements on this date.', { exact: true })).toBeVisible();
  await expect(view.getByRole('button', { name: 'Today', exact: true })).toBeEnabled();
  await button(page, 'Home').click(); await expect(page.getByLabel('Home goal', { exact: true })).toBeVisible();
});

test('Agreements deletion confirms intent, updates calendar counts and persists while preserving Summary', async ({ page }) => {
  const calls = examples();
  await page.addInitScript(id => localStorage.setItem('zeus-llama.active-attempt.v1', id), calls[0]!.id);
  await seed(page, calls);
  await button(page, 'Agreements').click();
  const view = page.getByRole('region', { name: 'Agreements', exact: true });
  await button(page, 'Delete entry for Barber Apollo').click();
  const dialog = page.getByRole('dialog', { name: 'Delete agreement?', exact: true });
  await expect(dialog).toContainText('This does not cancel an appointment');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(view.getByRole('article')).toHaveCount(2);
  await button(page, 'Show in calendar for Barber Apollo').click();
  await button(page, 'Delete entry for Barber Apollo').click();
  await page.screenshot({ path: test.info().outputPath('agreement-delete-confirmation.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Delete entry', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(button(page, '20 October 2026, 0 agreements')).toBeVisible();
  await expect(view.getByText('No agreements on this date.', { exact: true })).toBeVisible();
  await page.reload(); await button(page, 'Agreements').click();
  await expect(view.getByRole('article')).toHaveCount(1);
  await expect(view.getByRole('article', { name: 'Clinic Sol', exact: true })).toBeVisible();
  await button(page, 'Delete entry for Clinic Sol').click();
  await dialog.getByRole('button', { name: 'Delete entry', exact: true }).click();
  await expect(view.getByText('No agreements yet.', { exact: false })).toBeVisible();
  await button(page, 'Refresh agreements').click();
  await expect(view.getByRole('article')).toHaveCount(0);
  await button(page, 'Summary').click();
  await expect(page.locator('.history-card')).toHaveCount(6);
  await page.getByRole('button', { name: 'View details for Barber Apollo', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Call details', exact: true })).toBeVisible();
});
