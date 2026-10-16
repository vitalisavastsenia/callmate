import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';

const credentials = { username: 'e2e-owner', password: 'isolated-browser-tests-only-password' };
test('owner setup, invalid login, reload, logout and an expired session protect the UI', async ({ page }) => {
  const request = page.request;
  // Reset only the disposable backend owned by playwright.config.ts.
  execFileSync(process.execPath, ['../server/dist/reset-auth.js'], { env: { ...process.env, CALLMATE_DATA_DIR: '/tmp/callmate-contacts-e2e' } });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Create your owner account' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('owner-setup.png'), fullPage: true });
  await expect(page.getByRole('button', { name: 'Contacts', exact: true })).toHaveCount(0);
  expect((await request.get('http://127.0.0.1:3000/api/v1/contacts')).status()).toBe(401);
  await page.getByLabel('Username', { exact: true }).fill(credentials.username);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByLabel('Confirm password').fill('different-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Passwords do not match');
  await page.getByLabel('Confirm password').fill(credentials.password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Contacts', exact: true })).toBeVisible();
  const cookies = await page.context().cookies();
  const session = cookies.find(cookie => cookie.name === 'callmate_session');
  expect(session?.httpOnly).toBe(true); expect(session?.sameSite).toBe('Strict');
  expect(await page.evaluate(() => document.cookie)).not.toContain('callmate_session');
  await page.reload(); await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  expect((await request.get('http://127.0.0.1:3000/api/v1/contacts')).status()).toBe(401);
  await page.getByLabel('Username', { exact: true }).fill(credentials.username);
  await page.getByLabel('Password', { exact: true }).fill('incorrect-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Username or password is incorrect');
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Contacts', exact: true })).toBeVisible();
  // Revoke the cookie server-side without telling the mounted UI; its next API request must lock it.
  await request.post('http://127.0.0.1:3000/api/auth/logout', { data: {} });
  await page.getByRole('button', { name: 'Contacts', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Contacts', exact: true })).toHaveCount(0);
});

test('development console requires the same owner and can sign in and out', async ({ page }) => {
  const request = page.request;
  const state = await (await request.get('http://127.0.0.1:3000/api/auth/session')).json();
  if (state.setupRequired) expect((await request.post('http://127.0.0.1:3000/api/auth/setup', { data: credentials })).ok()).toBe(true);
  await page.context().clearCookies();
  await page.goto('http://127.0.0.1:3000/');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start conversation', exact: true })).toBeHidden();
  await page.getByLabel('Username', { exact: true }).fill(credentials.username);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start conversation', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start conversation', exact: true })).toBeHidden();
});
