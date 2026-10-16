import { expect, test } from './fixtures';

test('Home exposes the goal immediately and navigation stays usable on narrow screens', async ({ page }) => {
  await page.goto('/');
  const goal = page.getByLabel('Home goal', { exact: true });
  await expect(goal).toBeVisible();
  const box = (await goal.boundingBox())!;
  expect(box.y).toBeGreaterThan(0);
  expect(box.y + box.height).toBeLessThan(page.viewportSize()!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const settings = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings', exact: true });
  await settings.focus(); await expect(settings).toBeInViewport(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('settings-layout.png'), fullPage: true });
});

test('settings save sections independently and preserve unsaved edits and failures', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Default maximum call duration (minutes)', { exact: true }).fill('3.5');
  await page.getByLabel('LLM provider').selectOption('openai');
  await page.getByLabel('Agent model', { exact: true }).fill('custom-unsaved-model');
  await page.getByLabel('Default name', { exact: true }).fill('UI Example');
  await page.getByRole('button', { name: 'Save personal details', exact: true }).click();
  await expect(page.getByText('Settings saved. Personal details apply to new requests and untouched fields.')).toBeVisible();
  await expect(page.getByLabel('Default maximum call duration (minutes)', { exact: true })).toHaveValue('3.5');
  await expect(page.getByLabel('Agent model', { exact: true })).toHaveValue('custom-unsaved-model');
  await expect(page.getByRole('region', { name: 'Call limits & storage' })).toContainText('Unsaved changes');
  await page.reload(); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Default name', { exact: true })).toHaveValue('UI Example');
  await expect(page.getByLabel('Default maximum call duration (minutes)', { exact: true })).not.toHaveValue('3.5');
  await page.getByRole('button', { name: 'Backend', exact: true }).click();
  const original = await (await page.request.get('/api/v1/settings')).json();
  try {
    const duration = page.getByLabel('Default maximum call duration (minutes)', { exact: true });
    await duration.fill('4.5');
    await page.route('**/api/v1/settings', async route => {
      if (route.request().method() === 'PUT') await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Temporary test failure', requestId: 'ui-review', details: [] } }) });
      else await route.continue();
    });
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Could not save call limits');
    await expect(duration).toHaveValue('4.5');
    await expect(page.getByRole('button', { name: 'Save settings', exact: true })).toBeEnabled();
    await page.unroute('**/api/v1/settings');
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(page.getByText('Settings saved. Limits apply to new requests and untouched fields.')).toBeVisible();
    expect((await (await page.request.get('/api/v1/settings')).json()).defaultCallLimits.maxDurationSeconds).toBe(270);
  } finally { await page.unroute('**/api/v1/settings'); await page.request.put('/api/v1/settings', { data: original }); }
});

test('Stop remains visible while scrolling a call and calendar has a responsive agenda', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Simulator', exact: true }).click();
  await page.getByLabel('Simulated outcome', { exact: true }).selectOption('above_price');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Book a haircut', exact: true }).click();
  await page.getByRole('button', { name: 'Prepare the plan', exact: true }).click();
  await page.getByRole('button', { name: 'Request', exact: true }).click();
  await page.getByLabel('Approved name', { exact: true }).fill('Alex Example');
  await page.getByRole('button', { name: 'Review call plan', exact: true }).click();
  await page.clock.install();
  await page.getByRole('button', { name: 'Call', exact: true }).click();
  const popup = page.getByRole('dialog');
  await expect(popup.getByRole('button', { name: 'Stop call', exact: true })).toBeVisible();
  await page.clock.runFor(10000);
  await popup.locator('.modal-body').evaluate(el => { el.scrollTop = el.scrollHeight; });
  const stop = popup.getByRole('button', { name: 'Stop call', exact: true });
  await expect(stop).toHaveCount(1); await expect(stop).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('call-scroll.png') });
  await stop.click(); await expect(popup.getByRole('button', { name: 'Close call window', exact: true })).toBeVisible();
  await popup.getByRole('button', { name: 'Close call window', exact: true }).click();
  await page.getByRole('button', { name: 'Agreements', exact: true }).click();
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  const calendar = (await page.locator('.agreements-calendar-pane').boundingBox())!;
  const agenda = (await page.getByRole('region', { name: 'Calendar agreements' }).boundingBox())!;
  if (page.viewportSize()!.width > 960) expect(agenda.x).toBeGreaterThan(calendar.x + calendar.width);
  else expect(agenda.y).toBeGreaterThan(calendar.y + calendar.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('calendar-layout.png'), fullPage: true });
});
